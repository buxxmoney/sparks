-- Raw device telemetry landing table. Every payload the device streams to
-- POST /ingest/raw is stored verbatim (jsonb) keyed by meter + the device's own
-- timestamp. Downstream structured tables are derived from these rows. The unique
-- (meter_id, recorded_at) makes an offline-buffer replay idempotent.
-- Additive + idempotent — safe to apply out-of-band to prod (NEVER run the full
-- apply-migrations against prod; it re-runs 0001 which drops readings).
CREATE TABLE IF NOT EXISTS "raw_meter_readings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "meter_id" uuid NOT NULL REFERENCES "meters"("id") ON DELETE CASCADE,
  "recorded_at" timestamptz NOT NULL,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "payload" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "raw_meter_reading_uq"
  ON "raw_meter_readings" ("meter_id", "recorded_at");
