import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  getDb,
  landlordInvoices,
  member,
  organization,
  reconciliations,
  sites,
  user,
} from "@sparks/db";
import { auth } from "./auth";
import { requirePlatformOperator, type AuthContext } from "./middleware";
import { dispatchBillOutcome } from "./notifications";
import { adminCreateCustomerInput, adminReviewReconciliationInput } from "./validators";

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "org"
  );
}

/**
 * Operator-only: provision a new customer. Creates the owner user + their org
 * (owned by the customer, not the acting operator) and emails them a link to set
 * their password. Sparks then adds sites to the org via sites.create.
 */
export async function adminCreateCustomer(ctx: AuthContext, input: unknown) {
  const parsed = adminCreateCustomerInput.parse(input);
  await requirePlatformOperator(ctx.userId);

  const db = getDb();

  // 1) Create the customer user with a throwaway password — they never learn it;
  //    the onboarding email lets them set their own. Fails if the email exists.
  let userId: string;
  try {
    const res = await auth.api.signUpEmail({
      body: {
        email: parsed.customerEmail,
        password: `${randomUUID()}${randomUUID()}`,
        name: parsed.customerName,
      },
    });
    userId = res.user.id;
  } catch (err) {
    throw new Error(
      `Could not create an account for ${parsed.customerEmail} (it may already exist): ${(err as Error).message}`,
    );
  }

  // 2) Create the org OWNED BY THE CUSTOMER. The plugin's createOrganization would
  //    make the acting operator the owner, so we insert the org + owner member row
  //    directly (this is the operator-provisioning path, not customer self-signup).
  const organizationId = randomUUID();
  await db.insert(organization).values({
    id: organizationId,
    name: parsed.organizationName,
    slug: `${slugify(parsed.organizationName)}-${organizationId.slice(0, 8)}`,
    createdAt: new Date(),
  });
  await db.insert(member).values({
    id: randomUUID(),
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });

  // 3) Send the onboarding "set your password" email (generates a token and calls
  //    the sendResetPassword hook configured in auth.ts).
  const webUrl = process.env.WEB_URL || "http://localhost:3000";
  await auth.api.requestPasswordReset({
    body: { email: parsed.customerEmail, redirectTo: `${webUrl}/auth/set-password` },
  });

  return { userId, organizationId, email: parsed.customerEmail };
}

/**
 * Operator-only: list every organization with its owner + site count, so the
 * operator admin surface can pick an org to provision sites for.
 */
export async function adminListOrganizations(ctx: AuthContext) {
  await requirePlatformOperator(ctx.userId);
  const db = getDb();

  const rows = await db
    .select({
      id: organization.id,
      name: organization.name,
      createdAt: organization.createdAt,
      ownerEmail: user.email,
      siteCount: sql<number>`(select count(*) from ${sites} where ${sites.organizationId} = ${organization.id})`,
    })
    .from(organization)
    .leftJoin(
      member,
      sql`${member.organizationId} = ${organization.id} and ${member.role} = 'owner'`,
    )
    .leftJoin(user, sql`${user.id} = ${member.userId}`);

  return {
    organizations: rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.createdAt,
      ownerEmail: r.ownerEmail ?? null,
      siteCount: Number(r.siteCount ?? 0),
    })),
  };
}

/**
 * Operator-only Sparks QA queue: every reconciliation awaiting sign-off
 * (provisional) or that QA flagged, newest first, with the site + org context and
 * the headline discrepancy so the operator can triage and verify it.
 */
export async function adminListReviewQueue(ctx: AuthContext) {
  await requirePlatformOperator(ctx.userId);
  const db = getDb();

  const rows = await db
    .select({
      reconId: reconciliations.id,
      reviewStatus: reconciliations.reviewStatus,
      reviewNote: reconciliations.reviewNote,
      generatedAt: reconciliations.generatedAt,
      version: reconciliations.version,
      siteId: reconciliations.siteId,
      siteName: sites.name,
      organizationName: organization.name,
      billingPeriodStart: reconciliations.billingPeriodStart,
      billingPeriodEnd: reconciliations.billingPeriodEnd,
      chargedTotalCents: reconciliations.chargedTotalCents,
      expectedLandlordCents: reconciliations.expectedLandlordCents,
      discrepancyVsLandlordCents: reconciliations.discrepancyVsLandlordCents,
      dataIntegrityStatus: reconciliations.dataIntegrityStatus,
      reviewRequestedAt: landlordInvoices.reviewRequestedAt,
    })
    .from(reconciliations)
    .leftJoin(sites, eq(sites.id, reconciliations.siteId))
    .leftJoin(organization, sql`${organization.id} = ${sites.organizationId}`)
    .leftJoin(landlordInvoices, eq(landlordInvoices.id, reconciliations.invoiceId))
    .where(inArray(reconciliations.reviewStatus, ["provisional", "flagged"]));

  const queue = rows
    .map((r) => ({ ...r, chargedTotalCents: r.chargedTotalCents ?? 0 }))
    .sort((a, b) => {
      // Customer-requested reviews first, then newest.
      const ar = a.reviewRequestedAt ? 1 : 0;
      const br = b.reviewRequestedAt ? 1 : 0;
      if (ar !== br) return br - ar;
      return (b.generatedAt?.getTime() ?? 0) - (a.generatedAt?.getTime() ?? 0);
    });

  return { queue };
}

/**
 * Operator-only: send the review outcome to the customer. The operator's written
 * description document (subject + body, with an optional PDF attachment) is
 * delivered to the customer's in-app inbox + email (+ an SMS nudge). 'reviewed'
 * unlocks the sealed dispute PDF; 'flagged' sends it back for a fix.
 */
export async function adminReviewReconciliation(ctx: AuthContext, input: unknown) {
  const parsed = adminReviewReconciliationInput.parse(input);
  await requirePlatformOperator(ctx.userId);
  const db = getDb();

  const recon = await db.query.reconciliations.findFirst({
    where: eq(reconciliations.id, parsed.reconId),
  });
  if (!recon) {
    throw new Error("Reconciliation not found");
  }

  const [updated] = await db
    .update(reconciliations)
    .set({
      reviewStatus: parsed.status,
      reviewedByUserId: ctx.userId,
      reviewedAt: new Date(),
      reviewNote: parsed.body,
    })
    .where(eq(reconciliations.id, parsed.reconId))
    .returning();

  // Deliver the outcome to the customer (inbox + email + SMS nudge).
  const site = await db.query.sites.findFirst({ where: eq(sites.id, recon.siteId) });
  const attachment =
    parsed.attachmentBase64 && parsed.attachmentName
      ? {
          filename: parsed.attachmentName,
          content: Buffer.from(parsed.attachmentBase64, "base64"),
        }
      : null;

  let delivery: { alertId: string; recipientCount: number } | null = null;
  if (site) {
    delivery = await dispatchBillOutcome({
      reconId: parsed.reconId,
      siteId: recon.siteId,
      organizationId: site.organizationId,
      siteName: site.name,
      subject: parsed.subject,
      body: parsed.body,
      verified: parsed.status === "reviewed",
      attachment,
      webUrl: process.env.WEB_URL || "http://localhost:3000",
    });
  }

  return { reconciliation: updated, delivery };
}
