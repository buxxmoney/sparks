-- Grouped invoice parsing: canonical per-line fields so charges can be grouped by
-- utility / supply group / physical unit regardless of the landlord's format.
-- Additive + idempotent (safe to re-run via apply-migrations).

ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "utility" text;
ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "supply_group" text;
ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "unit" text;
ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "quantity" numeric(14, 4);
ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "rate" numeric(14, 6);
ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "component" text;
