import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import pg from "pg";

const { Client } = pg;

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("ERROR: DATABASE_URL not set");
  process.exit(1);
}

console.log(`Connecting to: ${dbUrl.split("@")[1] || "database"}`);

const client = new Client({
  connectionString: dbUrl,
  ssl: {
    rejectUnauthorized: false,
  } as any,
  connectionTimeoutMillis: 10000,
  query_timeout: 30000,
});

async function applyMigrations() {
  try {
    await client.connect();
    console.log("✓ Connected to database");

    const migrationsDir = join(process.cwd(), "migrations");
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const filePath = join(migrationsDir, file);
      const sql = readFileSync(filePath, "utf-8");

      console.log(`\nApplying: ${file}`);
      try {
        await client.query(sql);
        console.log(`✓ ${file} applied successfully`);
      } catch (err) {
        console.error(`✗ Failed to apply ${file}:`);
        console.error(err instanceof Error ? err.message : String(err));
      }
    }

    console.log("\n✓ All migrations completed");
  } catch (err) {
    console.error("\n✗ Connection or migration error:");
    if (err instanceof Error) {
      console.error(`  ${err.message}`);
      if (err.message.includes("terminated")) {
        console.error("\n  → Check that DATABASE_URL is correct");
        console.error("  → Check your Neon console for the latest connection string");
      }
    } else {
      console.error(err);
    }
    process.exit(1);
  } finally {
    try {
      await client.end();
    } catch {}
  }
}

applyMigrations();
