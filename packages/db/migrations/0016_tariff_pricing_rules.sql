-- Structural billing rules a tariff's rate rows can't express, stored per profile:
--   { minDemandKva, reactiveAllowanceFactorOfKwh, reactiveHighSeasonOnly,
--     surchargeFractionOfSubtotal, vatFraction }
-- Sources: City Power FY26/27 schedule p7 (70 kVA minimum demand, 6c/kWh network
-- surcharge), Eskom Schedule of Standard Prices Apr 2026 (30% reactive allowance,
-- R/POD/day charges) — verified against Life Grand Cafe's Feb–May 2026 bills.
-- Additive + idempotent — safe to apply out-of-band.
ALTER TABLE "tariff_profiles"
  ADD COLUMN IF NOT EXISTS "pricing_rules" jsonb;
