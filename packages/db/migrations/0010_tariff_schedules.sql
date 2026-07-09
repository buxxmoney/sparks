-- Reference utility tariff schedules (Eskom / municipal published prices) used by
-- the AI to look up a rate a bill only names. Additive; idempotent.

CREATE TABLE IF NOT EXISTS "tariff_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "provider" text NOT NULL,
  "effective_from" timestamptz NOT NULL,
  "effective_to" timestamptz,
  "file_storage_key" text NOT NULL,
  "extracted_text" text,
  "uploaded_by_user_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "tariff_schedule_provider_idx"
  ON "tariff_schedules" ("provider", "effective_from");
