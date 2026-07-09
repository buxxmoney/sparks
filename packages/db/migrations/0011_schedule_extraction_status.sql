-- Async extraction state for reference tariff schedules (LlamaParse runs in the
-- background at upload). Additive; idempotent.

ALTER TABLE "tariff_schedules"
  ADD COLUMN IF NOT EXISTS "extraction_status" text NOT NULL DEFAULT 'pending';
