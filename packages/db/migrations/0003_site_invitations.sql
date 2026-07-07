-- Slice 4: site-scoped invitations. An org-owner invites someone by email to a
-- specific site; on accept the invitee becomes an org member (non-owner) + gets a
-- site_access grant. Additive + idempotent (safe to re-run via apply-migrations).

DO $$ BEGIN
  CREATE TYPE "site_invite_status" AS ENUM ('pending', 'accepted', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "site_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "site_id" uuid NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL,
  "email" text NOT NULL,
  "role" "site_role" NOT NULL DEFAULT 'site_manager',
  "token" text NOT NULL UNIQUE,
  "invited_by_user_id" text NOT NULL,
  "status" "site_invite_status" NOT NULL DEFAULT 'pending',
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "accepted_at" timestamptz,
  "accepted_by_user_id" text
);

CREATE INDEX IF NOT EXISTS "site_invitations_site_idx" ON "site_invitations" ("site_id", "status");
