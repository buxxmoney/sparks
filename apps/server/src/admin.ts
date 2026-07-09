import { randomUUID } from "node:crypto";
import { desc, eq, isNotNull, sql } from "drizzle-orm";
import {
  alerts,
  getDb,
  landlordInvoices,
  member,
  organization,
  reconciliations,
  sites,
  tariffProfiles,
  tariffSchedules,
  user,
} from "@sparks/db";
import { auth } from "./auth";
import { sendEmail } from "./email";
import { extractPdfText } from "./invoices";
import { llamaParseConfigured, parseScheduleToMarkdown } from "./llamaparse";
import { PreconditionError, requirePlatformOperator, type AuthContext } from "./middleware";
import { dispatchBillOutcome } from "./notifications";
import { putObject } from "./storage";
import {
  adminCreateCustomerInput,
  adminDeleteOrganizationInput,
  adminListOrgSitesInput,
  adminListReviewedBillsInput,
  adminReviewReconciliationInput,
  tariffSchedulesCreateInput,
  tariffSchedulesDeleteInput,
} from "./validators";

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

  // Reject a duplicate up front with a clear, client-visible message (PreconditionError
  // surfaces its text; a plain Error would be sanitized to a generic 500).
  const existing = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, parsed.customerEmail))
    .limit(1);
  if (existing.length > 0) {
    throw new PreconditionError("That email has already been used — an account with it already exists.");
  }

  // 1) Create the customer user with a throwaway password — they never learn it;
  //    the onboarding email lets them set their own.
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
    // Guards against a race that slips past the pre-check; a duplicate email is the
    // expected cause, so surface a clean message rather than a raw 500.
    const msg = (err as Error).message ?? "";
    if (/exist|unique|duplicate/i.test(msg)) {
      throw new PreconditionError("That email has already been used — an account with it already exists.");
    }
    throw new PreconditionError(`Could not create an account for ${parsed.customerEmail}: ${msg}`);
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
 * Operator-only: list the sites under an organization (cross-tenant, so operators can
 * see + decommission them). Unlike sites.list (org-membership gated), this reads any org.
 */
export async function adminListOrgSites(ctx: AuthContext, input: unknown) {
  const parsed = adminListOrgSitesInput.parse(input);
  await requirePlatformOperator(ctx.userId);
  const db = getDb();
  const rows = await db
    .select({
      id: sites.id,
      name: sites.name,
      city: sites.city,
      status: sites.status,
      createdAt: sites.createdAt,
    })
    .from(sites)
    .where(eq(sites.organizationId, parsed.organizationId))
    .orderBy(sites.name);
  return { sites: rows };
}

/**
 * Operator-only: hard-delete an organization and everything under it — for when a
 * customer ends their subscription. Deletes in FK-dependency order inside a transaction:
 * its sites (cascading every site-scoped row — devices, meters, readings, invoices,
 * reconciliations, access grants, billing periods, site-level alerts…), then its
 * org-scoped tariff profiles and org-level alerts, then the org row itself (cascading
 * members + invitations). The customers' USER logins are left intact (a user may belong
 * to other orgs); the cascade only removes their membership of this org. Requires the
 * caller to echo the exact org name as a fat-finger guard.
 */
export async function adminDeleteOrganization(ctx: AuthContext, input: unknown) {
  const parsed = adminDeleteOrganizationInput.parse(input);
  await requirePlatformOperator(ctx.userId);
  const db = getDb();

  const [org] = await db
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .where(eq(organization.id, parsed.organizationId))
    .limit(1);
  if (!org) {
    throw new Error("Organization not found");
  }
  if (parsed.confirmName.trim() !== org.name) {
    throw new Error("The confirmation name does not match the organization name.");
  }

  const orgSites = await db
    .select({ id: sites.id })
    .from(sites)
    .where(eq(sites.organizationId, parsed.organizationId));

  await db.transaction(async (tx) => {
    // Sites first — their FKs cascade to all site-scoped data.
    await tx.delete(sites).where(eq(sites.organizationId, parsed.organizationId));
    // Org-scoped rows with no FK cascade from the organization row.
    await tx.delete(tariffProfiles).where(eq(tariffProfiles.organizationId, parsed.organizationId));
    await tx.delete(alerts).where(eq(alerts.organizationId, parsed.organizationId));
    // The org row — cascades better-auth members + invitations.
    await tx.delete(organization).where(eq(organization.id, parsed.organizationId));
  });

  return { deleted: parsed.organizationId, siteCount: orgSites.length };
}

// Shared select shape for a reconciliation + its invoice/site/org context. Used by
// both the work queue and the reviewed history so their rows line up.
function reconContextColumns() {
  return {
    reconId: reconciliations.id,
    invoiceId: reconciliations.invoiceId,
    reviewStatus: reconciliations.reviewStatus,
    reviewNote: reconciliations.reviewNote,
    reviewedAt: reconciliations.reviewedAt,
    generatedAt: reconciliations.generatedAt,
    version: reconciliations.version,
    siteId: reconciliations.siteId,
    billingPeriodId: reconciliations.billingPeriodId,
    siteName: sites.name,
    organizationName: organization.name,
    customerEmail: user.email,
    billingPeriodStart: reconciliations.billingPeriodStart,
    billingPeriodEnd: reconciliations.billingPeriodEnd,
    chargedTotalCents: reconciliations.chargedTotalCents,
    expectedLandlordCents: reconciliations.expectedLandlordCents,
    discrepancyVsLandlordCents: reconciliations.discrepancyVsLandlordCents,
    dataIntegrityStatus: reconciliations.dataIntegrityStatus,
    reviewRequestedAt: landlordInvoices.reviewRequestedAt,
  };
}

/**
 * Operator-only unified work queue — the single "what needs doing" list. It merges the
 * old "bills submitted" + "QA queue" surfaces: every submitted bill still AWAITING an
 * operator response, one row each. A row is one of three states:
 *   - "needs_tariff"     — submitted but produced NO reconciliation (couldn't price
 *                          without a landlord tariff) → assign a tariff.
 *   - "pending_expected" — has a recon but no landlord tariff yet, so the expected side
 *                          is undetermined → assign a tariff (then it recomputes).
 *   - "ready"            — has a full recon with an expected side → review & respond.
 * Bills the operator has RESPONDED to (verified or sent back) leave the queue and live
 * in the Reviewed history (adminListReviewedBills). Newest first.
 */
export async function adminListReviewQueue(ctx: AuthContext) {
  await requirePlatformOperator(ctx.userId);
  const db = getDb();

  const reconRows = await db
    .select(reconContextColumns())
    .from(reconciliations)
    .leftJoin(sites, eq(sites.id, reconciliations.siteId))
    .leftJoin(organization, sql`${organization.id} = ${sites.organizationId}`)
    .leftJoin(landlordInvoices, eq(landlordInvoices.id, reconciliations.invoiceId))
    .leftJoin(user, eq(user.id, landlordInvoices.uploadedByUserId));

  // Reduce to the latest version per invoice (each Reopen/operator recompute adds one).
  const latestByInvoice = new Map<string, (typeof reconRows)[number]>();
  const orphans: typeof reconRows = []; // recons with no invoiceId — can't dedupe.
  for (const r of reconRows) {
    if (!r.invoiceId) {
      orphans.push(r);
      continue;
    }
    const cur = latestByInvoice.get(r.invoiceId);
    if (!cur || r.version > cur.version) latestByInvoice.set(r.invoiceId, r);
  }

  const respondedInvoices = new Set<string>();
  const workRecons: (typeof reconRows)[number][] = [];
  for (const r of [...latestByInvoice.values(), ...orphans]) {
    // Responded (verified OR sent back) → history, not work.
    if (r.reviewStatus === "reviewed" || r.reviewStatus === "flagged") {
      if (r.invoiceId) respondedInvoices.add(r.invoiceId);
      continue;
    }
    workRecons.push(r);
  }

  const invoicesWithRecon = new Set(
    reconRows.map((r) => r.invoiceId).filter((id): id is string => Boolean(id)),
  );

  // Submitted bills that produced NO reconciliation at all → they still need a tariff.
  const submitted = await db
    .select({
      invoiceId: landlordInvoices.id,
      siteId: landlordInvoices.siteId,
      siteName: sites.name,
      organizationName: organization.name,
      customerEmail: user.email,
      billingPeriodId: landlordInvoices.billingPeriodId,
      billingPeriodStart: landlordInvoices.billingPeriodStart,
      billingPeriodEnd: landlordInvoices.billingPeriodEnd,
      confirmedTotalCents: landlordInvoices.confirmedTotalCents,
      reviewRequestedAt: landlordInvoices.reviewRequestedAt,
    })
    .from(landlordInvoices)
    .leftJoin(sites, eq(sites.id, landlordInvoices.siteId))
    .leftJoin(organization, sql`${organization.id} = ${sites.organizationId}`)
    .leftJoin(user, eq(user.id, landlordInvoices.uploadedByUserId))
    .where(isNotNull(landlordInvoices.reviewRequestedAt));

  const queue = [
    ...workRecons.map((r) => ({
      reconId: r.reconId as string | null,
      invoiceId: r.invoiceId,
      siteId: r.siteId,
      siteName: r.siteName,
      organizationName: r.organizationName,
      customerEmail: r.customerEmail,
      billingPeriodId: r.billingPeriodId,
      billingPeriodStart: r.billingPeriodStart,
      billingPeriodEnd: r.billingPeriodEnd,
      version: r.version,
      chargedTotalCents: r.chargedTotalCents ?? 0,
      expectedLandlordCents: r.expectedLandlordCents,
      discrepancyVsLandlordCents: r.discrepancyVsLandlordCents,
      dataIntegrityStatus: r.dataIntegrityStatus,
      reviewNote: r.reviewNote,
      reviewRequestedAt: r.reviewRequestedAt,
      generatedAt: r.generatedAt,
      state: r.expectedLandlordCents == null ? "pending_expected" : "ready",
    })),
    ...submitted
      .filter((s) => !invoicesWithRecon.has(s.invoiceId) && !respondedInvoices.has(s.invoiceId))
      .map((s) => ({
        reconId: null as string | null,
        invoiceId: s.invoiceId,
        siteId: s.siteId,
        siteName: s.siteName,
        organizationName: s.organizationName,
        customerEmail: s.customerEmail,
        billingPeriodId: s.billingPeriodId,
        billingPeriodStart: s.billingPeriodStart,
        billingPeriodEnd: s.billingPeriodEnd,
        version: 0,
        chargedTotalCents: s.confirmedTotalCents ?? 0,
        expectedLandlordCents: null as number | null,
        discrepancyVsLandlordCents: null as number | null,
        dataIntegrityStatus: null as string | null,
        reviewNote: null as string | null,
        reviewRequestedAt: s.reviewRequestedAt,
        generatedAt: null as Date | null,
        state: "needs_tariff",
      })),
  ].sort((a, b) => {
    const at = a.reviewRequestedAt?.getTime() ?? a.generatedAt?.getTime() ?? 0;
    const bt = b.reviewRequestedAt?.getTime() ?? b.generatedAt?.getTime() ?? 0;
    return bt - at;
  });

  return { queue };
}

/**
 * Operator-only Reviewed history — bills the operator has already responded to
 * (verified or sent back), newest response first. Searchable by site / org / customer
 * and paginated, since it grows without bound as bills are processed. Only the latest
 * recon version per invoice is shown, so a bill appears once with its final outcome.
 */
export async function adminListReviewedBills(ctx: AuthContext, input: unknown) {
  const parsed = adminListReviewedBillsInput.parse(input);
  await requirePlatformOperator(ctx.userId);
  const db = getDb();

  const reconRows = await db
    .select(reconContextColumns())
    .from(reconciliations)
    .leftJoin(sites, eq(sites.id, reconciliations.siteId))
    .leftJoin(organization, sql`${organization.id} = ${sites.organizationId}`)
    .leftJoin(landlordInvoices, eq(landlordInvoices.id, reconciliations.invoiceId))
    .leftJoin(user, eq(user.id, landlordInvoices.uploadedByUserId));

  // Latest version per invoice, then keep only responded ones (verified/flagged).
  const latestByInvoice = new Map<string, (typeof reconRows)[number]>();
  for (const r of reconRows) {
    const key = r.invoiceId ?? r.reconId;
    const cur = latestByInvoice.get(key);
    if (!cur || r.version > cur.version) latestByInvoice.set(key, r);
  }

  const q = parsed.query?.trim().toLowerCase() ?? "";
  const all = [...latestByInvoice.values()]
    .filter((r) => r.reviewStatus === "reviewed" || r.reviewStatus === "flagged")
    .filter(
      (r) =>
        !q ||
        (r.siteName ?? "").toLowerCase().includes(q) ||
        (r.organizationName ?? "").toLowerCase().includes(q) ||
        (r.customerEmail ?? "").toLowerCase().includes(q),
    )
    .sort((a, b) => (b.reviewedAt?.getTime() ?? 0) - (a.reviewedAt?.getTime() ?? 0));

  const total = all.length;
  const page = all.slice(parsed.offset, parsed.offset + parsed.limit).map((r) => ({
    reconId: r.reconId,
    siteId: r.siteId,
    siteName: r.siteName,
    organizationName: r.organizationName,
    customerEmail: r.customerEmail,
    billingPeriodStart: r.billingPeriodStart,
    billingPeriodEnd: r.billingPeriodEnd,
    chargedTotalCents: r.chargedTotalCents ?? 0,
    expectedLandlordCents: r.expectedLandlordCents,
    discrepancyVsLandlordCents: r.discrepancyVsLandlordCents,
    reviewStatus: r.reviewStatus,
    reviewNote: r.reviewNote,
    reviewedAt: r.reviewedAt,
  }));

  return { reviewed: page, total, offset: parsed.offset, limit: parsed.limit };
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

/* ─────────────── Reference tariff schedules (operator) ─────────────── */

/**
 * Operator-only: upload a provider's published tariff schedule (e.g. Eskom's
 * Schedule of Standard Prices). Stores the PDF and its extracted text so the AI can
 * later cross-reference bills against it. Extraction is best-effort — a scanned doc
 * with no text layer still gets stored (extractedText null) and can be replaced.
 */
export async function adminTariffSchedulesCreate(ctx: AuthContext, input: unknown) {
  const parsed = tariffSchedulesCreateInput.parse(input);
  await requirePlatformOperator(ctx.userId);
  const db = getDb();

  const pdf = Buffer.from(parsed.contentBase64, "base64");
  if (pdf.length === 0) {
    throw new Error("Uploaded file is empty");
  }

  const scheduleId = randomUUID();
  const fileStorageKey = `tariff-schedules/${scheduleId}.pdf`;
  await putObject(fileStorageKey, pdf, "application/pdf");

  // Extraction (LlamaParse for the rate tables) can take minutes, so create the row
  // immediately in "pending" and extract in the background — the admin list polls.
  const [row] = await db
    .insert(tariffSchedules)
    .values({
      id: scheduleId,
      name: parsed.name,
      provider: parsed.provider,
      effectiveFrom: parsed.effectiveFrom,
      effectiveTo: parsed.effectiveTo ?? null,
      fileStorageKey,
      extractionStatus: "pending",
      uploadedByUserId: ctx.userId,
    })
    .returning();

  void runScheduleExtraction(scheduleId, pdf, parsed.filename).catch((err) =>
    console.error(`[schedule] background extraction crashed for ${scheduleId}:`, err),
  );

  return {
    scheduleId: row.id,
    name: row.name,
    provider: row.provider,
    status: "pending" as const,
    engine: llamaParseConfigured() ? "llamaparse" : "pdftotext",
  };
}

// Background: extract a schedule's text. Prefer LlamaParse (reads image-based rate
// tables); fall back to pdftotext (descriptions only) when LlamaParse is unconfigured
// or fails. Records extraction_status = ready/failed.
async function runScheduleExtraction(
  scheduleId: string,
  pdf: Buffer,
  filename: string,
): Promise<void> {
  const db = getDb();
  let text: string | null = null;
  let engine: "llamaparse" | "pdftotext" | null = null;
  let llamaError: string | null = null;

  // Prefer LlamaParse for the rate tables. If it's configured but fails, keep the
  // reason (llamaError) so we can flag that the good extractor is broken — even when
  // the pdftotext fallback still yields (rate-table-less) text.
  if (llamaParseConfigured()) {
    const { markdown, error } = await parseScheduleToMarkdown(pdf, filename);
    if (markdown) {
      text = markdown;
      engine = "llamaparse";
      // Partial success (some chunks failed) still yields usable text but is worth
      // flagging — keep the error so operators are told.
      if (error) llamaError = error;
    } else {
      llamaError = error;
    }
  }
  if (!text) {
    try {
      text = await extractPdfText(pdf);
      if (text) engine = "pdftotext";
    } catch (err) {
      console.error(`[schedule] pdftotext fallback failed for ${scheduleId}:`, err);
    }
  }

  await db
    .update(tariffSchedules)
    .set({
      extractedText: text,
      extractionStatus: text ? "ready" : "failed",
      extractionEngine: engine,
      extractionError: llamaError,
    })
    .where(eq(tariffSchedules.id, scheduleId));
  console.log(
    `[schedule] ${scheduleId} extraction ${text ? `ready via ${engine} (${text.length} chars)` : "failed"}` +
      (llamaError ? ` — LlamaParse error: ${llamaError}` : ""),
  );

  // If LlamaParse was expected but failed, make it KNOWN to operators (not just
  // logged) — otherwise schedules silently lose their rate tables.
  if (llamaError) {
    await notifyOperatorsLlamaParseFailed(scheduleId, llamaError, Boolean(text)).catch(() => {});
  }
}

/** Email the Sparks operator inbox that LlamaParse extraction is broken. */
async function notifyOperatorsLlamaParseFailed(
  scheduleId: string,
  error: string,
  fellBackToPdftotext: boolean,
): Promise<void> {
  const to = (process.env.SPARKS_REVIEW_EMAIL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (to.length === 0) {
    console.warn("[schedule] SPARKS_REVIEW_EMAIL not set — cannot alert on LlamaParse failure.");
    return;
  }
  const db = getDb();
  const sched = await db.query.tariffSchedules.findFirst({
    where: eq(tariffSchedules.id, scheduleId),
  });
  await sendEmail({
    to,
    subject: "⚠️ LlamaParse extraction failed for a tariff schedule",
    html: `<div style="font-family:system-ui,sans-serif;max-width:560px;color:#111827">
      <h2 style="margin:0 0 8px">LlamaParse extraction failed</h2>
      <p>Schedule <strong>${sched?.name ?? scheduleId}</strong> (${sched?.provider ?? "?"}) could not be parsed by LlamaParse.</p>
      <p style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 12px;font-family:monospace;font-size:12px">${error}</p>
      <p>${
        fellBackToPdftotext
          ? "It fell back to pdftotext, so the schedule is usable but its <strong>rate tables are likely missing</strong> — exact-rate checks won't work until this is fixed and the schedule is re-uploaded."
          : "No fallback text was produced — this schedule has no usable text."
      }</p>
      <p style="color:#6b7280;font-size:12px">Check the LLAMA_CLOUD_API_KEY, LlamaCloud quota/status, then re-upload the schedule.</p>
    </div>`,
  }).catch((e) => console.error("[schedule] failed to email LlamaParse-failure alert:", e));
}

/** Operator-only: list uploaded reference schedules (metadata + text size). */
export async function adminTariffSchedulesList(ctx: AuthContext) {
  await requirePlatformOperator(ctx.userId);
  const db = getDb();
  const rows = await db
    .select({
      id: tariffSchedules.id,
      name: tariffSchedules.name,
      provider: tariffSchedules.provider,
      effectiveFrom: tariffSchedules.effectiveFrom,
      effectiveTo: tariffSchedules.effectiveTo,
      createdAt: tariffSchedules.createdAt,
      extractionStatus: tariffSchedules.extractionStatus,
      extractionEngine: tariffSchedules.extractionEngine,
      extractionError: tariffSchedules.extractionError,
      textLength: sql<number>`coalesce(length(${tariffSchedules.extractedText}), 0)::int`,
    })
    .from(tariffSchedules)
    .orderBy(desc(tariffSchedules.effectiveFrom));
  return { schedules: rows };
}

/** Operator-only: remove a reference schedule. */
export async function adminTariffSchedulesDelete(ctx: AuthContext, input: unknown) {
  const parsed = tariffSchedulesDeleteInput.parse(input);
  await requirePlatformOperator(ctx.userId);
  const db = getDb();
  await db.delete(tariffSchedules).where(eq(tariffSchedules.id, parsed.scheduleId));
  return { deleted: true };
}
