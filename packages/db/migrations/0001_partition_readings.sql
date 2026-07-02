-- Add isPlatformOperator field to user table (better-auth managed)
-- Note: better-auth user table is managed by better-auth, but we extend it here
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "is_platform_operator" boolean DEFAULT false NOT NULL;

-- Convert readings to range-partitioned table by time (monthly partitions)
-- Note: This requires dropping and recreating the table, so we do it as separate steps

-- Step 1: Create the partitioned parent table
CREATE TABLE IF NOT EXISTS "readings_partitioned" (
  "meter_id" uuid NOT NULL,
  "time" timestamp with time zone NOT NULL,
  "seq" bigint,
  "active_energy_kwh" numeric(14, 3),
  "reactive_energy_kvarh" numeric(14, 3),
  "apparent_energy_kvah" numeric(14, 3),
  "total_power_kw" numeric(12, 3),
  "total_apparent_kva" numeric(12, 3),
  "power_factor" numeric(5, 4),
  "source" "reading_source" DEFAULT 'live' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("meter_id", "time")
) PARTITION BY RANGE ("time");

-- Step 2: Create current month partition (2026-07)
CREATE TABLE IF NOT EXISTS "readings_202607" PARTITION OF "readings_partitioned"
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- Step 3: Create next month partition (2026-08)
CREATE TABLE IF NOT EXISTS "readings_202608" PARTITION OF "readings_partitioned"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- Step 4: Copy data from old table to partitioned table (if old table has data)
INSERT INTO "readings_partitioned"
SELECT * FROM "readings" ON CONFLICT DO NOTHING;

-- Step 5: Drop the old readings table
DROP TABLE IF EXISTS "readings" CASCADE;

-- Step 6: Rename the partitioned table to readings
ALTER TABLE "readings_partitioned" RENAME TO "readings";

-- Step 7: Recreate foreign key from readings to meters
ALTER TABLE "readings" ADD CONSTRAINT "readings_meter_id_meters_id_fk"
  FOREIGN KEY ("meter_id") REFERENCES "meters"("id") ON DELETE cascade ON UPDATE no action;

-- Step 8: Recreate indexes
CREATE INDEX IF NOT EXISTS "readings_time_idx" ON "readings" ("time");

-- Function to create monthly partitions for readings
-- This can be called via a scheduled job to create future partitions
CREATE OR REPLACE FUNCTION create_next_month_partition()
RETURNS void AS $$
DECLARE
  partition_name text;
  start_date date;
  end_date date;
  current_year_month text;
BEGIN
  -- Get next month's boundaries
  start_date := date_trunc('month', CURRENT_DATE + interval '1 month')::date;
  end_date := start_date + interval '1 month';

  -- Format partition name as readings_YYYYMM
  current_year_month := to_char(start_date, 'YYYYMM');
  partition_name := 'readings_' || current_year_month;

  -- Create the partition if it doesn't exist
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF readings FOR VALUES FROM (%L) TO (%L)',
    partition_name,
    start_date::timestamp with time zone,
    end_date::timestamp with time zone
  );

  RAISE NOTICE 'Created partition % for readings', partition_name;
END;
$$ LANGUAGE plpgsql;
