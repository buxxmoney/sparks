/**
 * Smoke-test the Resend email integration end-to-end. Sends a one-off email using
 * the app's real sendEmail (so it uses EMAIL_FROM + RESEND_API_KEY from .env) and
 * prints success or the raw Resend error — the quickest way to see whether your
 * sending domain is verified.
 *
 * Usage (from apps/server), creds already in .env:
 *   bun scripts/test-email.ts                 # sends to SPARKS_REVIEW_EMAIL
 *   bun scripts/test-email.ts you@example.com # sends to a specific address
 *
 * NOTE: this sends a REAL email. While the domain is unverified, Resend test-mode
 * only delivers to your Resend account's own address.
 */
import "dotenv/config";
import { sendEmail } from "../src/email";

async function main() {
  const to = process.argv[2] || process.env.SPARKS_REVIEW_EMAIL;
  if (!to) {
    console.error("No recipient. Pass one: bun scripts/test-email.ts you@example.com");
    process.exit(1);
  }
  if (process.env.NODE_ENV === "test") {
    console.error("Refusing to run with NODE_ENV=test (sendEmail is a no-op there).");
    process.exit(1);
  }

  console.log(`From: ${process.env.EMAIL_FROM || "(default onboarding@resend.dev)"}`);
  console.log(`To:   ${to}`);
  try {
    await sendEmail({
      to,
      subject: "Sparks email test",
      html: `<div style="font-family:system-ui,sans-serif">
        <h2>Sparks email is working ✅</h2>
        <p>If you're reading this, Resend delivered from your configured domain.</p>
      </div>`,
    });
    console.log(
      "→ sendEmail returned without error. If RESEND_API_KEY is set, it was accepted by Resend — check the inbox (and spam).",
    );
  } catch (err) {
    console.error("→ Resend returned an error:\n", err instanceof Error ? err.message : err);
    console.error(
      "\nA 'domain is not verified' error means sparksmetering.com isn't verified yet — add it at resend.com/domains and set the DNS records. A '403 test-mode' error means send to your Resend account's own email until the domain is verified.",
    );
    process.exit(1);
  }
}

main();
