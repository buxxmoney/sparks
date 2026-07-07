-- Reconcile the non-owner org role to a single name. Historically two values were
-- used: 'operator' (from the better-auth plugin config / role demotion) and
-- 'member' (raw inserts on site-invite accept). Both meant "non-owner". We now use
-- 'member' everywhere; normalise any legacy 'operator' rows.
-- Additive + idempotent.

UPDATE "member" SET "role" = 'member' WHERE "role" = 'operator';
