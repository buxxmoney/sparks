-- Tiered per-site access: viewer < editor < site_admin (org owners sit above all).
-- Convert the site_role enum columns to text and normalize the legacy values:
--   owner        → site_admin  (could manage the site's access)
--   site_manager → editor      (could act, but not manage access)
-- Text (not a new enum) so future levels don't need an enum migration.
-- Additive + idempotent.

ALTER TABLE "site_access" ALTER COLUMN "role" TYPE text;
UPDATE "site_access" SET "role" = 'site_admin' WHERE "role" = 'owner';
UPDATE "site_access" SET "role" = 'editor' WHERE "role" = 'site_manager';

ALTER TABLE "site_invitations" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "site_invitations" ALTER COLUMN "role" TYPE text;
UPDATE "site_invitations" SET "role" = 'site_admin' WHERE "role" = 'owner';
UPDATE "site_invitations" SET "role" = 'editor' WHERE "role" = 'site_manager';
ALTER TABLE "site_invitations" ALTER COLUMN "role" SET DEFAULT 'viewer';
