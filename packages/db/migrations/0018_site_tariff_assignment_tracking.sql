-- Who put a site on a tariff, and when.
--
-- `site_tariff_assignments` recorded only the business-time range an assignment
-- covers. There was no record of when the decision was made or by whom, so a
-- customer asking "why am I on this tariff?" could not be answered, and a
-- mis-assignment could not be traced.
--
-- The partial unique index is the important half: nothing prevented two
-- open-ended assignments for one (site, role), and `readingsBillToDate` would
-- then pick one by sort order — silently pricing a bill under an arbitrary
-- tariff. This makes "currently activated" a fact the database enforces rather
-- than a convention the query layer hopes for.
--
-- Additive + idempotent. NOTE: the unique index will FAIL if any site already
-- has overlapping open-ended assignments; resolve those first (close the stale
-- one by setting effective_to) rather than dropping the index.
ALTER TABLE "site_tariff_assignments"
  ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "created_by_user_id" text,
  ADD COLUMN IF NOT EXISTS "note" text;

CREATE UNIQUE INDEX IF NOT EXISTS "site_tariff_one_active"
  ON "site_tariff_assignments" ("site_id", "role")
  WHERE "effective_to" IS NULL;
