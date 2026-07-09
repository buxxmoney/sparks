-- Async invoice parsing: a failure reason column + an alert type for "your invoice
-- has finished parsing". Both idempotent so re-running apply-migrations is safe.

ALTER TYPE "alert_type" ADD VALUE IF NOT EXISTS 'invoice_parsed';

ALTER TABLE "landlord_invoices" ADD COLUMN IF NOT EXISTS "parse_error" text;
