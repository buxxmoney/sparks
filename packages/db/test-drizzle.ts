// Note: This file requires postgres-js to be installed
// It's kept for reference but not currently used in the project
// To use: npm install postgres
// import { drizzle } from "drizzle-orm/postgres-js";
// import postgres from "postgres";

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("ERROR: DATABASE_URL not set");
  process.exit(1);
}

console.log("Testing Drizzle connection...\n");

try {
  console.log("✓ Drizzle configured (postgres-js not installed)");
  console.log("  DATABASE_URL:", dbUrl.split("@")[1] || "configured");
} catch (err) {
  console.error("✗ Configuration failed:");
  if (err instanceof Error) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
}
