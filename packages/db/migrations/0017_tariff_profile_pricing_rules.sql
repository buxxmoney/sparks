-- Calculation rules and per-rule citations that a flat rate row cannot express.
-- These columns ALREADY EXIST in production (added out-of-band); this migration
-- brings the tracked schema into line so a fresh database matches. `pricing_rules`
-- carries the percentage-surcharge fraction, minimum-demand floor, reactive free
-- allowance and VAT fraction; `sources` carries per-rule citations.
-- Additive + idempotent — safe to re-apply.
ALTER TABLE "tariff_profiles"
  ADD COLUMN IF NOT EXISTS "pricing_rules" jsonb,
  ADD COLUMN IF NOT EXISTS "sources" jsonb;
