-- Verbatim citations from published tariff documents backing a tariff profile:
-- [{ title, page, quote, appliesTo[], tariffScheduleId }] — shown in the
-- customer-facing "how we calculated this" view alongside the arithmetic, and
-- linked to the uploaded reference PDF in tariff_schedules where available.
-- Additive + idempotent — safe to apply out-of-band.
ALTER TABLE "tariff_profiles"
  ADD COLUMN IF NOT EXISTS "sources" jsonb;
