import pg from "pg";

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("ERROR: DATABASE_URL not set");
  process.exit(1);
}

console.log("Testing database connection...\n");

const client = new pg.Client({
  connectionString: dbUrl,
  ssl: {
    rejectUnauthorized: false,
  },
});

client.on("error", (err) => {
  console.error("Client error:", err);
});

client.connect((err) => {
  if (err) {
    console.error("✗ Connection failed:");
    console.error(err.message);
    process.exit(1);
  } else {
    console.log("✓ Connected successfully!");

    client.query("SELECT version();", (err, res) => {
      if (err) {
        console.error("✗ Query failed:", err.message);
      } else {
        console.log("✓ Query successful!");
        console.log("  Database:", res.rows[0].version);
      }
      client.end();
    });
  }
});
