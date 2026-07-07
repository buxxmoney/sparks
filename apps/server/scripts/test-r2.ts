/** One-off: verify R2 connectivity (put → exists → get) using apps/server/.env. */
import "dotenv/config";
import { getObject, objectExists, putObject, signObjectUrl } from "../src/storage";

console.log("R2 config present:", {
  accountId: Boolean(process.env.R2_ACCOUNT_ID),
  keyId: Boolean(process.env.R2_ACCESS_KEY_ID),
  secret: Boolean(process.env.R2_SECRET_ACCESS_KEY),
  bucket: process.env.R2_BUCKET_NAME,
  nodeEnv: process.env.NODE_ENV,
});

const key = `smoke/test-${Date.now()}.txt`;
try {
  await putObject(key, Buffer.from("hello from sparks r2 smoke"), "text/plain");
  console.log("✓ putObject ok");
  console.log("✓ objectExists:", await objectExists(key));
  const back = await getObject(key);
  console.log("✓ getObject ok, bytes:", back.toString());
  console.log("✓ signed url:", (await signObjectUrl(key, 60)).slice(0, 80), "…");
  console.log("\nR2 WORKS.");
} catch (e) {
  console.error("\n✗ R2 FAILED:", e instanceof Error ? `${e.name}: ${e.message}` : e);
}
process.exit(0);
