-- R2: add the platform-operator flag to the better-auth `user` table.
-- Declared to better-auth as an additionalField (apps/server/src/auth.ts); read by
-- requirePlatformOperator. Additive + idempotent (safe to re-run via apply-migrations).
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "is_platform_operator" boolean NOT NULL DEFAULT false;
