import { and, eq, inArray } from "drizzle-orm";
import {
  alertDeliveries,
  alerts,
  getDb,
  member,
  siteAccess,
  user,
} from "@sparks/db";
import { billReviewOutcomeEmail, sendEmail } from "./email";
import { sendSms } from "./sms";
import { putObject } from "./storage";

/**
 * Everyone who should hear about a site's bill outcome: the customer org owner(s)
 * plus anyone with an explicit site-access grant. De-duplicated user rows.
 */
async function resolveRecipients(organizationId: string, siteId: string) {
  const db = getDb();
  const owners = await db
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.role, "owner")));
  const grants = await db
    .select({ userId: siteAccess.userId })
    .from(siteAccess)
    .where(eq(siteAccess.siteId, siteId));

  const ids = [...new Set([...owners, ...grants].map((r) => r.userId))];
  if (ids.length === 0) return [];
  return db.select({ id: user.id, email: user.email, phone: user.phone }).from(user).where(
    inArray(user.id, ids),
  );
}

/**
 * Deliver a Sparks review outcome to the customer across every channel:
 *  - app: an alert + per-recipient delivery row (the in-app inbox item);
 *  - email: the operator's written outcome, with their optional attachment;
 *  - sms: a short "your review is ready" nudge to recipients with a phone number.
 * Per-recipient/channel failures are recorded (status='failed') but never abort
 * the whole dispatch. Returns the alert id + how many people were notified.
 */
export async function dispatchBillOutcome(params: {
  reconId: string;
  siteId: string;
  organizationId: string;
  siteName: string;
  subject: string;
  body: string;
  verified: boolean;
  attachment: { filename: string; content: Buffer } | null;
  webUrl: string;
}): Promise<{ alertId: string; recipientCount: number; attachmentKey: string | null }> {
  const db = getDb();
  const recipients = await resolveRecipients(params.organizationId, params.siteId);

  // Persist the optional attachment once; the inbox offers it via a signed URL.
  let attachmentKey: string | null = null;
  if (params.attachment) {
    attachmentKey = `review-outcomes/${params.reconId}/${params.attachment.filename}`;
    await putObject(attachmentKey, params.attachment.content, "application/pdf");
  }

  const [alert] = await db
    .insert(alerts)
    .values({
      organizationId: params.organizationId,
      siteId: params.siteId,
      type: "invoice_ready",
      severity: params.verified ? "info" : "warning",
      title: params.subject,
      message: params.body,
      payload: {
        reconId: params.reconId,
        verified: params.verified,
        attachmentKey,
        attachmentName: params.attachment?.filename ?? null,
      },
      status: "open",
    })
    .returning();

  const link = `${params.webUrl}/sites/${params.siteId}/reconciliation/${params.reconId}`;
  const email = billReviewOutcomeEmail({
    siteName: params.siteName,
    subject: params.subject,
    body: params.body,
    verified: params.verified,
    link,
  });

  for (const r of recipients) {
    // In-app inbox item.
    await db.insert(alertDeliveries).values({
      alertId: alert.id,
      channel: "app",
      recipientUserId: r.id,
      status: "sent",
      sentAt: new Date(),
    });

    // Email (with the operator's attachment, if any).
    if (r.email) {
      try {
        await sendEmail({
          to: r.email,
          subject: email.subject,
          html: email.html,
          attachments: params.attachment ? [params.attachment] : undefined,
        });
        await db.insert(alertDeliveries).values({
          alertId: alert.id,
          channel: "email",
          recipientUserId: r.id,
          status: "sent",
          sentAt: new Date(),
        });
      } catch (err) {
        console.error(`[notify] email to ${r.email} failed:`, err);
        await db
          .insert(alertDeliveries)
          .values({ alertId: alert.id, channel: "email", recipientUserId: r.id, status: "failed" });
      }
    }

    // SMS nudge (only if we have a number).
    if (r.phone) {
      try {
        const ref = await sendSms(
          r.phone,
          `Sparks: your bill review for ${params.siteName} is ready. ${link}`,
        );
        await db.insert(alertDeliveries).values({
          alertId: alert.id,
          channel: "sms",
          recipientUserId: r.id,
          status: "sent",
          sentAt: new Date(),
          providerRef: ref,
        });
      } catch (err) {
        console.error(`[notify] sms to ${r.phone} failed:`, err);
        await db
          .insert(alertDeliveries)
          .values({ alertId: alert.id, channel: "sms", recipientUserId: r.id, status: "failed" });
      }
    }
  }

  return { alertId: alert.id, recipientCount: recipients.length, attachmentKey };
}

/**
 * In-app notification that background parsing of an uploaded invoice has finished
 * (or failed). Lets a customer who navigated away from the upload screen find out
 * their invoice is ready to review (or needs re-uploading). App-inbox only — no
 * email/SMS, to avoid noise on a routine step. Best-effort; never throws.
 */
export async function dispatchInvoiceParsed(params: {
  invoiceId: string;
  siteId: string;
  organizationId: string;
  siteName: string;
  ok: boolean;
  errorMessage?: string | null;
}): Promise<void> {
  try {
    const db = getDb();
    const recipients = await resolveRecipients(params.organizationId, params.siteId);
    if (recipients.length === 0) return;

    const [alert] = await db
      .insert(alerts)
      .values({
        organizationId: params.organizationId,
        siteId: params.siteId,
        type: "invoice_parsed",
        severity: params.ok ? "info" : "warning",
        title: params.ok
          ? `Invoice ready to review — ${params.siteName}`
          : `Couldn't read an invoice — ${params.siteName}`,
        message: params.ok
          ? "We've finished reading your invoice. Open it to review the charges and send it to Sparks."
          : `We couldn't read the invoice you uploaded${
              params.errorMessage ? `: ${params.errorMessage}` : ""
            }. Please open it and try again.`,
        payload: { invoiceId: params.invoiceId, ok: params.ok },
        status: "open",
      })
      .returning();

    for (const r of recipients) {
      await db.insert(alertDeliveries).values({
        alertId: alert.id,
        channel: "app",
        recipientUserId: r.id,
        status: "sent",
        sentAt: new Date(),
      });
    }
  } catch (err) {
    console.error(`[notify] invoice-parsed alert failed for ${params.invoiceId}:`, err);
  }
}

/**
 * In-app confirmation for the customer that their bill has been SENT to Sparks for
 * review — closing the loop (ready → sent → outcome) in their Alerts inbox.
 * App-inbox only; best-effort; never throws.
 */
export async function dispatchReviewSubmitted(params: {
  invoiceId: string;
  siteId: string;
  organizationId: string;
  siteName: string;
}): Promise<void> {
  try {
    const db = getDb();
    const recipients = await resolveRecipients(params.organizationId, params.siteId);
    if (recipients.length === 0) return;

    const [alert] = await db
      .insert(alerts)
      .values({
        organizationId: params.organizationId,
        siteId: params.siteId,
        type: "review_submitted",
        severity: "info",
        title: `Sent to Sparks — ${params.siteName}`,
        message:
          "Your bill has been sent to Sparks for review. We'll check the charges against your meter and let you know the outcome.",
        payload: { invoiceId: params.invoiceId },
        status: "open",
      })
      .returning();

    for (const r of recipients) {
      await db.insert(alertDeliveries).values({
        alertId: alert.id,
        channel: "app",
        recipientUserId: r.id,
        status: "sent",
        sentAt: new Date(),
      });
    }
  } catch (err) {
    console.error(`[notify] review-submitted alert failed for ${params.invoiceId}:`, err);
  }
}
