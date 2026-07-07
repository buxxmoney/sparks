/**
 * Smoke-test the SMS integration (Clickatell / Twilio, per SMS_PROVIDER). Sends a
 * one-off message to the number you pass and prints the provider's response so we
 * can see exactly what came back (a message ref on success, or the raw error).
 *
 * Usage (from apps/server), with your creds already in apps/server/.env:
 *   bun scripts/test-sms.ts +27821234567
 *   bun scripts/test-sms.ts +27821234567 "custom message"
 *
 * Loads apps/server/.env so it uses the same SMS_PROVIDER / SMS_API_KEY / SMS_FROM
 * as the app. NOTE: this sends a REAL SMS (Clickatell bills per message) — use your
 * own number, and on a trial account make sure that number is verified first.
 */
import "dotenv/config";
import { sendSms } from "../src/sms";

async function main() {
  const to = process.argv[2];
  const body = process.argv[3] || "Sparks SMS test — your bill review notifications are working.";

  if (!to) {
    console.error("Usage: bun scripts/test-sms.ts +27821234567 [message]");
    process.exit(1);
  }
  // sendSms no-ops under NODE_ENV=test — make sure we actually send.
  if (process.env.NODE_ENV === "test") {
    console.error("Refusing to run with NODE_ENV=test (SMS is a no-op there). Unset it and retry.");
    process.exit(1);
  }

  console.log(`Provider: ${process.env.SMS_PROVIDER || "(unset)"}`);
  console.log(`Sending to ${to}…`);
  try {
    const ref = await sendSms(to, body);
    if (ref === null) {
      console.log(
        "→ No send happened (logged only). That means creds are missing/incomplete — check SMS_API_KEY (and SMS_PROVIDER).",
      );
    } else {
      console.log(`→ Accepted by provider. Message ref: ${ref}`);
      console.log("Check the handset. If it doesn't arrive, the account may be unfunded or the number unverified.");
    }
  } catch (err) {
    console.error("→ Provider returned an error:\n", err instanceof Error ? err.message : err);
    console.error(
      "\nIf this is an auth/endpoint error, tell me the message — it usually means the key is for a different Clickatell API and I'll adjust the endpoint/auth (or set SMS_API_URL).",
    );
    process.exit(1);
  }
}

main();
