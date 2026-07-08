import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { assertTestDatabase } from "./guard";
import * as schema from "./schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable not set");
}

// Test runs perform destructive, unscoped teardown (`db.delete(...)`). If the suite
// is ever pointed at a real database (e.g. NODE_ENV=test but a prod DATABASE_URL, or
// a missing .env.test), refuse to connect at all — before a single query — instead of
// silently wiping it. `bun test` sets NODE_ENV=test automatically.
if (process.env.NODE_ENV === "test") {
  assertTestDatabase();
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;

export function getDb(): Database {
  return db;
}

export * from "./schema";
export * from "./guard";
