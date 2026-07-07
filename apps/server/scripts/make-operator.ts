/**
 * Grant a user the Sparks platform-operator flag (internal cross-tenant admin).
 * The flag is `input: false` in better-auth, so it can never be set by a client —
 * this trusted server script is the way to bootstrap the first operator.
 *
 * Usage (from apps/server):
 *   bun scripts/make-operator.ts you@example.com
 *
 * Loads apps/server/.env for DATABASE_URL, so it targets the same DB the dev
 * server uses. Sign the user up first (via /auth/signup), then run this.
 */
import "dotenv/config";
import { getDb, user } from "@sparks/db";
import { eq } from "drizzle-orm";

const email = process.argv[2];
if (!email) {
  console.error("Usage: bun scripts/make-operator.ts <email>");
  process.exit(1);
}

const host = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? "").host || "(unknown)";
  } catch {
    return "(unknown)";
  }
})();

const db = getDb();
const rows = await db
  .update(user)
  .set({ isPlatformOperator: true })
  .where(eq(user.email, email))
  .returning({ id: user.id, email: user.email, isPlatformOperator: user.isPlatformOperator });

if (rows.length === 0) {
  console.error(`✗ No user with email "${email}" on DB ${host}. Sign up first, then re-run.`);
  process.exit(1);
}
console.log(`✓ ${email} is now a platform operator (DB ${host}).`);
process.exit(0);
