-- Invoice review & QA overhaul:
--  (1) editable grouping persists the user's confirmed utility/supply/component
--      per line (the parser output stays intact for audit);
--  (2) reconciliations carry a review_status so a confirmed recon is shown to the
--      customer immediately as "provisional" but the sealed dispute PDF only
--      unlocks after Sparks QA sign-off ("reviewed");
--  (3) landlord_invoices records when the customer explicitly asked Sparks to
--      review it.
-- Additive + idempotent (safe to re-run via apply-migrations).

ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "confirmed_utility" text;
ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "confirmed_supply_group" text;
ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "confirmed_component" text;

ALTER TABLE "reconciliations" ADD COLUMN IF NOT EXISTS "review_status" text NOT NULL DEFAULT 'provisional';
ALTER TABLE "reconciliations" ADD COLUMN IF NOT EXISTS "reviewed_by_user_id" text;
ALTER TABLE "reconciliations" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamptz;
ALTER TABLE "reconciliations" ADD COLUMN IF NOT EXISTS "review_note" text;

ALTER TABLE "landlord_invoices" ADD COLUMN IF NOT EXISTS "review_requested_at" timestamptz;

CREATE INDEX IF NOT EXISTS "recon_review_idx" ON "reconciliations" ("review_status");
