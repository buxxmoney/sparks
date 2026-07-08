/**
 * Database safety guards.
 *
 * The repo's `.env` DATABASE_URL points at the PRODUCTION Neon branch, and it is
 * loaded by default for anything that isn't run with NODE_ENV=test. Combined with
 * destructive operations — the test suite's unscoped `db.delete(...)` teardowns and
 * migration files that `DROP TABLE ... CASCADE` — a single mistargeted command can
 * wipe production. These helpers make that mistake fail loudly instead of silently
 * destroying data.
 */

export interface DbIdentity {
  host: string;
  name: string;
}

/** Parse a Postgres URL into a human host + database name (best-effort, never throws). */
export function describeDatabase(url: string | undefined = process.env.DATABASE_URL): DbIdentity {
  if (!url) return { host: "unset", name: "unset" };
  // postgres://user:pass@host:port/dbname?params  → host may be absent for localhost URLs.
  const afterAt = url.split("@")[1] ?? url.replace(/^\w+:\/\//, "");
  const host = afterAt.split("/")[0] || "local";
  const name = (afterAt.split("/")[1] ?? "").split("?")[0] || "unknown";
  return { host, name };
}

/**
 * True when the target DB is unmistakably local or a dedicated test DB — i.e. safe
 * for destructive operations. Local Postgres (localhost/127.0.0.1) or any database
 * whose name ends in `_test`.
 */
export function isLocalOrTestDatabase(url: string | undefined = process.env.DATABASE_URL): boolean {
  if (!url) return false;
  if (/(localhost|127\.0\.0\.1)/.test(url)) return true;
  return /_test$/.test(describeDatabase(url).name);
}

/**
 * Assert the current DATABASE_URL is a local/test DB. Call this before any code path
 * that performs destructive test teardown, so the suite can NEVER run against a real
 * database even if NODE_ENV / .env.test are misconfigured. Throws otherwise.
 */
export function assertTestDatabase(context = "the test suite"): void {
  if (isLocalOrTestDatabase()) return;
  const { host, name } = describeDatabase();
  throw new Error(
    `\n\n🛑 REFUSING to run ${context} against a non-test database (${host}/${name}).\n` +
      `   Tests perform destructive teardown and must target a local or *_test database.\n` +
      `   Fix: run with NODE_ENV=test (so apps/server/.env.test → sparks_test is loaded),\n` +
      `   or point DATABASE_URL at a database named *_test.\n`,
  );
}

/**
 * Gate a destructive operation (migrations, resets, seeds that drop data). Allowed
 * freely against local/test DBs. Against anything else it refuses UNLESS the caller
 * has opted in explicitly by setting CONFIRM_PROD_DB to the exact target DB name —
 * a deliberate, hard-to-do-by-accident acknowledgement.
 */
export function assertDestructiveAllowed(operation: string): void {
  if (isLocalOrTestDatabase()) return;
  const { host, name } = describeDatabase();
  if (process.env.CONFIRM_PROD_DB !== name) {
    throw new Error(
      `\n\n🛑 REFUSING to run "${operation}" against non-local database (${host}/${name}).\n` +
        `   This operation can DESTROY data. If you REALLY intend to run it against this\n` +
        `   database, re-run with:  CONFIRM_PROD_DB="${name}"\n`,
    );
  }
  console.warn(
    `\n⚠️  "${operation}" is running against a PRODUCTION-like database (${host}/${name}).\n` +
      `   CONFIRM_PROD_DB matched — proceeding intentionally.\n`,
  );
}
