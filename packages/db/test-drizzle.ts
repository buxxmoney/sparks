import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("ERROR: DATABASE_URL not set");
  process.exit(1);
}

console.log("Testing Drizzle connection...\n");

try {
  const sql = postgres(dbUrl, {
    ssl: "require",
    max: 1,
    idle_timeout: 5,
  });

  const db = drizzle(sql);

  const result = await sql`SELECT version()`;
  console.log("✓ Connection successful!");
  console.log("  Version:", result[0].version);

  await sql.end();
} catch (err) {
  console.error("✗ Connection failed:");
  if (err instanceof Error) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
}
