-- The Pi writes its formatted meter dump straight into `readings` using the RAW device
-- register shape (measured_at + cumulative energy registers + instantaneous power/VA). In
-- production `readings` already IS that shape, so these adds are no-ops there. Locally the
-- table still carries the app's older derived shape; this makes it a SUPERSET so the raw-
-- readings reads (dashboard endpoints + reconciliation's materializeDemandIntervalsFromRaw)
-- work against the same table. Additive + idempotent — safe to apply out-of-band.
ALTER TABLE "readings"
  ADD COLUMN IF NOT EXISTS "measured_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "energy_import_kwh" numeric,
  ADD COLUMN IF NOT EXISTS "energy_import_kvarh" numeric,
  ADD COLUMN IF NOT EXISTS "energy_kvah" numeric,
  ADD COLUMN IF NOT EXISTS "power_total" numeric,
  ADD COLUMN IF NOT EXISTS "va_total" numeric,
  ADD COLUMN IF NOT EXISTS "pf_total" numeric;

CREATE INDEX IF NOT EXISTS "readings_meter_measured_idx" ON "readings" ("meter_id", "measured_at");
