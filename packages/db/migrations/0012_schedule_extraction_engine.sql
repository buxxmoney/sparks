-- Record which extractor produced a schedule's text and any LlamaParse failure,
-- so a broken LlamaParse (silently falling back to pdftotext) is visible. Additive.

ALTER TABLE "tariff_schedules" ADD COLUMN IF NOT EXISTS "extraction_engine" text;
ALTER TABLE "tariff_schedules" ADD COLUMN IF NOT EXISTS "extraction_error" text;
