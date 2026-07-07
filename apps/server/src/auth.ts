import { db } from "@sparks/db";
import { betterAuth } from "better-auth";
import { sendEmail, passwordSetEmail } from "./email";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import {
  defaultStatements,
  ownerAc,
} from "better-auth/plugins/organization/access";

/**
 * Org-level access control. The organization plugin models an org as an Account
 * (§4.1). We expose exactly two org roles:
 *   - owner  — full control of the org and all of its sites.
 *   - member — any non-owner in the org. Deliberately given NO plugin-level org
 *              statements: all privilege management (invites, role changes, access
 *              grants) goes through our own middleware-guarded procedures (see
 *              routers.ts / middleware.ts), so a member can't use the plugin's
 *              direct endpoints to escalate. Per-site capability (viewer/editor/
 *              site_admin) is a SEPARATE axis (the `site_access` table).
 */
const ac = createAccessControl(defaultStatements);
const owner = ac.newRole(ownerAc.statements);
const member = ac.newRole({});

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  secret: process.env.BETTER_AUTH_SECRET || "dev-secret-change-in-production",
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3001",
  appName: "Sparks",
  // Dev ports plus any production web origin(s) from WEB_ORIGINS (comma-separated),
  // e.g. "https://app.sparksmetering.com".
  trustedOrigins: [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    "http://localhost:3002",
    "http://127.0.0.1:3002",
    ...(process.env.WEB_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ],
  emailAndPassword: {
    enabled: true,
    // Used for BOTH operator-driven onboarding (a customer sets their initial
    // password) and ordinary "forgot password". We build the link from the raw
    // token so it points straight at our web set-password page.
    sendResetPassword: async ({ user, token }) => {
      const webUrl = process.env.WEB_URL || "http://localhost:3000";
      const link = `${webUrl}/auth/set-password?token=${token}`;
      // Dev aid: print the link so you can complete onboarding/reset without
      // relying on email delivery (e.g. while Resend is still in test mode).
      // Never logged in production.
      if (process.env.NODE_ENV !== "production") {
        console.log(`\n[onboarding] set-password link for ${user.email}:\n${link}\n`);
      }
      const { subject, html } = passwordSetEmail(link, user.name || user.email);
      // Delivery is best-effort: provisioning already succeeded and the link is
      // logged above, so a send failure (e.g. an unverified domain) shouldn't
      // surface as a scary background-task error.
      try {
        await sendEmail({ to: user.email, subject, html });
      } catch (e) {
        console.warn(
          `[onboarding] email delivery failed for ${user.email} (use the link above): ${e instanceof Error ? e.message : e}`,
        );
      }
    },
  },
  user: {
    additionalFields: {
      // Global platform-operator flag (internal cross-tenant admin). Never
      // settable by clients — only via a trusted server/admin path. Maps to the
      // `is_platform_operator` column defined in packages/db/src/schema.ts.
      isPlatformOperator: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false,
      },
      // Optional mobile number for SMS notifications (set via the profile path).
      phone: {
        type: "string",
        required: false,
        input: true,
      },
    },
  },
  plugins: [
    organization({
      ac,
      roles: { owner, member },
      creatorRole: "owner",
    }),
  ],
});
