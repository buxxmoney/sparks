import { randomUUID } from "node:crypto";
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  getDb,
  landlordInvoices,
  member,
  organization,
  reconciliations,
  sites,
  tariffSchedules,
  user,
} from "@sparks/db";
import { auth } from "./auth";
import { sendEmail } from "./email";
import { extractPdfText } from "./invoices";
import { llamaParseConfigured, parseScheduleToMarkdown } from "./llamaparse";
import { requirePlatformOperator, type AuthContext } from "./middleware";
import { dispatchBillOutcome } from "./notifications";
import { putObject } from "./storage";
import {
  adminCreateCustomerInput,
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
