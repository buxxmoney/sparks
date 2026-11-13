-- Per-rate provenance, so a customer's bill can name and source every line it charges.
-- `label` is the name the published schedule gives the rate ("Service charge",
-- "Winter · Block 2: 501-1 000 kWh"); `source` cites the document it was read from.
-- Both nullable: rates loaded before this migration keep working, and the API derives a
-- fallback label from charge_type/season/tou_period when the column is null.
-- Additive + idempotent — safe to re-apply.
ALTER TABLE "tariff_rates"
  ADD COLUMN IF NOT EXISTS "label" text,
  ADD COLUMN IF NOT EXISTS "source" text;
