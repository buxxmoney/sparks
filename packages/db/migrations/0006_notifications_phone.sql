-- Notifications: bill-review request email → Sparks, and the customer Alerts
-- inbox for the review outcome (in-app + email + optional SMS nudge).
--  - user.phone: optional mobile number (captured at set-password + in Settings),
--    used for the SMS "your review is ready" nudge.
--  - alert_deliveries.read_at: per-recipient read state for the in-app inbox
--    (the app-channel delivery row IS the inbox item).
-- Bill outcomes reuse the existing alert_type 'invoice_ready' (verified vs flagged
-- is carried by severity + title/payload) so no enum change is needed.
-- Additive + idempotent.

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "phone" text;
ALTER TABLE "alert_deliveries" ADD COLUMN IF NOT EXISTS "read_at" timestamptz;

CREATE INDEX IF NOT EXISTS "alert_deliv_recipient_idx" ON "alert_deliveries" ("recipient_user_id", "channel");
