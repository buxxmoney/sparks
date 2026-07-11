import { randomBytes } from "node:crypto";
import type { Database } from "@sparks/db";
import { sql } from "drizzle-orm";
import { PreconditionError } from "./middleware";

/**
 * Per-site Postgres ingest roles.
 *
 * Meters write their readings directly to Neon (no server in the path), so each
 * site gets its own LOGIN role whose password lives on the meter readers. The
 * role is deliberately minimal:
 *
 *   - INSERT on the `readings` table and nothing else — no SELECT, no other tables.
 *   - An RLS policy scopes inserts to meters belonging to that role's site, so a
 *     credential lifted off one site's meter cannot write readings for another
 *     org's meters. The membership check runs through a SECURITY DEFINER function
 *     so the role itself needs no SELECT on `meters`.
 *   - The app's own role owns the tables and therefore bypasses RLS — enabling it
 *     here does not affect any server-side code path.
 *
 * The password is returned exactly once, at creation (or rotation) time, and is
 * never persisted anywhere — role existence is checked against pg_roles, not a
 * table of ours.
 *
 * DDL cannot take bound parameters, so everything interpolated below is either
 * derived from a validated UUID (role name) or generated server-side from
 * base64url alphabet (password). Nothing client-provided is ever spliced in.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function siteIngestRoleName(siteId: string): string {
  if (!UUID_RE.test(siteId)) {
    throw new PreconditionError("Invalid site id");
  }
  // 11 + 32 = 43 chars, well under Postgres's 63-char identifier limit.
  return `meter_site_${siteId.toLowerCase().replace(/-/g, "")}`;
}

function generatePassword(): string {
  // 32 chars of [A-Za-z0-9_-]: safe inside a single-quoted SQL literal.
  return randomBytes(24).toString("base64url");
}

async function roleExists(db: Database, roleName: string): Promise<boolean> {
  const res = await db.execute(sql`SELECT 1 FROM pg_roles WHERE rolname = ${roleName}`);
  return res.rows.length > 0;
}

/**
 * Grants + RLS policy for one site role. Idempotent — safe to re-run.
 * `readings.id` is a bigserial, so inserting also needs USAGE on its sequence.
 */
async function applyRoleScoping(db: Database, roleName: string, siteId: string): Promise<void> {
  await db.execute(
    sql.raw(`
      GRANT USAGE ON SCHEMA public TO "${roleName}";
      GRANT INSERT ON TABLE public.readings TO "${roleName}";
      GRANT USAGE ON SEQUENCE public.readings_id_seq TO "${roleName}";

      CREATE OR REPLACE FUNCTION public.meter_belongs_to_site(_meter_id uuid, _site_id uuid)
      RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
      AS $fn$
        SELECT EXISTS (SELECT 1 FROM meters WHERE id = _meter_id AND site_id = _site_id)
      $fn$;

      ALTER TABLE public.readings ENABLE ROW LEVEL SECURITY;

      DROP POLICY IF EXISTS "ingest_${roleName}" ON public.readings;
      CREATE POLICY "ingest_${roleName}" ON public.readings
        FOR INSERT TO "${roleName}"
        WITH CHECK (public.meter_belongs_to_site(meter_id, '${siteId.toLowerCase()}'::uuid));
    `),
  );
}

/**
 * Connection coordinates for the meter config file, read off the server's own
 * DATABASE_URL. Meters use the DIRECT endpoint on purpose — posts are
 * intermittent and the gateway holds no idle connection (connect → drain →
 * disconnect), so direct connections stay well under Neon's limit.
 */
export function ingestConnectionInfo(): { host: string | null; database: string | null } {
  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    return { host: url.hostname || null, database: url.pathname.replace(/^\//, "") || null };
  } catch {
    return { host: null, database: null };
  }
}

export type EnsureIngestRoleResult = {
  roleName: string;
  /** Present only when the role was created by this call — shown once, never stored. */
  password: string | null;
  created: boolean;
  host: string | null;
  database: string | null;
};

export async function ensureSiteIngestRole(
  db: Database,
  siteId: string,
): Promise<EnsureIngestRoleResult> {
  const roleName = siteIngestRoleName(siteId);

  if (await roleExists(db, roleName)) {
    // Re-apply scoping so a role whose grants/policy drifted (or predate RLS) heals.
    await applyRoleScoping(db, roleName, siteId);
    return { roleName, password: null, created: false, ...ingestConnectionInfo() };
  }

  const password = generatePassword();
  try {
    await db.execute(
      sql.raw(
        `CREATE ROLE "${roleName}" WITH LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      ),
    );
  } catch (err) {
    // 42710 duplicate_object: a concurrent ensure won the race — their password stands.
    if (err instanceof Error && "code" in err && (err as { code?: string }).code === "42710") {
      await applyRoleScoping(db, roleName, siteId);
      return { roleName, password: null, created: false, ...ingestConnectionInfo() };
    }
    throw err;
  }

  await applyRoleScoping(db, roleName, siteId);
  return { roleName, password, created: true, ...ingestConnectionInfo() };
}

export type RotateIngestPasswordResult = {
  roleName: string;
  password: string;
  host: string | null;
  database: string | null;
};

export async function rotateSiteIngestPassword(
  db: Database,
  siteId: string,
): Promise<RotateIngestPasswordResult> {
  const roleName = siteIngestRoleName(siteId);

  if (!(await roleExists(db, roleName))) {
    throw new PreconditionError(
      "This site has no ingest role yet — add a meter first to create one.",
    );
  }

  const password = generatePassword();
  await db.execute(sql.raw(`ALTER ROLE "${roleName}" WITH PASSWORD '${password}'`));
  // Rotation is also the recovery path for pre-RLS roles, so heal scoping here too.
  await applyRoleScoping(db, roleName, siteId);
  return { roleName, password, ...ingestConnectionInfo() };
}
