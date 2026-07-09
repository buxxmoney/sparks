import { Resend } from "resend";
import type { TariffAnalysis } from "./invoices";

// Default sender. Override with EMAIL_FROM once a verified domain is set up in
// Resend; the sandbox `onboarding@resend.dev` works for testing.
const FROM = process.env.EMAIL_FROM || "Sparks <onboarding@resend.dev>";

export interface EmailAttachment {
  filename: string;
  content: Buffer;
}

export interface EmailMessage {
  // A single address or several (Resend accepts an array of recipients).
  to: string | string[];
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}

/**
 * Send a transactional email via Resend. The API key is read lazily (at send
 * time) so it picks up whatever the process env has — including a `.env` loaded
 * at startup. If `RESEND_API_KEY` is not set we log the message instead of
 * throwing, so onboarding/invite flows remain testable in dev without a key.
 */
export async function sendEmail(msg: EmailMessage): Promise<void> {
  // Never hit the email provider from the test suite (it would make real network
  // calls and fail on Resend's test-mode recipient restriction).
  if (process.env.NODE_ENV === "test") {
    return;
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`[email] RESEND_API_KEY not set — logging instead of sending.`);
    console.warn(`[email] to=${msg.to} subject=${msg.subject}`);
    if (msg.attachments?.length) {
      console.warn(`[email] attachments: ${msg.attachments.map((a) => a.filename).join(", ")}`);
    }
    console.warn(`[email] body:\n${msg.html}`);
    return;
  }

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: FROM,
    to: msg.to,
    subject: msg.subject,
    html: msg.html,
    attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content })),
  });
  if (error) {
    throw new Error(`Resend send failed: ${error.message ?? JSON.stringify(error)}`);
  }
}

function button(link: string, label: string): string {
  return `<p><a href="${link}" style="display:inline-block;background:#171717;color:#ffffff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600">${label}</a></p>
  <p style="color:#6b7280;font-size:13px">Or paste this link into your browser:<br>${link}</p>`;
}

/** Onboarding / set-password email (also used for password resets). */
export function passwordSetEmail(link: string, orgName: string): { subject: string; html: string } {
  return {
    subject: "Set your Sparks password",
    html: `<div style="font-family:system-ui,sans-serif;max-width:480px;color:#111827">
      <h2 style="margin:0 0 8px">Welcome to Sparks</h2>
      <p>An account has been set up for <strong>${orgName}</strong>. Use the link below to set your password and sign in.</p>
      ${button(link, "Set your password")}
    </div>`,
  };
}

/** Site-scoped invitation email (org-owner invites a Site Manager). */
export function siteInviteEmail(
  link: string,
  siteName: string,
  inviterOrg: string,
): { subject: string; html: string } {
  return {
    subject: `You've been invited to view ${siteName} on Sparks`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:480px;color:#111827">
      <h2 style="margin:0 0 8px">Site access invitation</h2>
      <p><strong>${inviterOrg}</strong> has invited you to view <strong>${siteName}</strong> on Sparks.</p>
      ${button(link, "Accept invitation")}
    </div>`,
  };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const randStr = (cents: number) =>
  `R ${(cents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface ReviewRequestLine {
  rawLabel: string;
  utility: string;
  supplyGroup: string;
  component: string;
  unit: string | null;
  quantity: number | null;
  rate: number | null;
  valueCents: number;
}

/**
 * Internal "please review this bill" email → the Sparks review inbox. Carries the
 * AI breakdown (every parsed line + the reconcilable total) and the customer's
 * note; the original invoice PDF is attached by the caller.
 */
export function billReviewRequestEmail(data: {
  orgName: string;
  siteName: string;
  customerEmail: string;
  reconcilableTotalCents: number;
  statedTotalCents: number | null;
  periodStart: Date;
  periodEnd: Date;
  note: string | null;
  lines: ReviewRequestLine[];
  adminUrl: string;
  tariffAnalysis?: TariffAnalysis | null;
}): { subject: string; html: string } {
  const rows = data.lines
    .map(
      (l) => `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(l.rawLabel)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(l.utility)} / ${escapeHtml(l.supplyGroup)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(l.component)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${l.quantity ?? "—"} ${escapeHtml(l.unit ?? "")}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${l.rate ?? "—"}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-weight:600">${randStr(l.valueCents)}</td>
      </tr>`,
    )
    .join("");
  const period = `${data.periodStart.toISOString().slice(0, 10)} → ${data.periodEnd.toISOString().slice(0, 10)}`;
  return {
    subject: `Bill review requested — ${data.orgName} / ${data.siteName}`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:720px;color:#111827">
      <h2 style="margin:0 0 4px">Bill review requested</h2>
      <p style="color:#6b7280;margin:0 0 12px">${escapeHtml(data.orgName)} · ${escapeHtml(data.siteName)} · ${escapeHtml(data.customerEmail)}<br>Billing period ${period}</p>
      <p><strong>Reconcilable total (AI):</strong> ${randStr(data.reconcilableTotalCents)}${
        data.statedTotalCents !== null
          ? ` &nbsp;·&nbsp; invoice stated total ${randStr(data.statedTotalCents)}`
          : ""
      }</p>
      ${data.note ? `<p style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 12px"><strong>Customer note:</strong> ${escapeHtml(data.note)}</p>` : ""}
      <p style="margin:14px 0 6px;font-weight:600">AI breakdown of the parsed lines</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="text-align:left;color:#6b7280;font-size:11px">
          <th style="padding:6px 8px">Charge</th><th style="padding:6px 8px">Utility / supply</th>
          <th style="padding:6px 8px">Component</th><th style="padding:6px 8px;text-align:right">Qty</th>
          <th style="padding:6px 8px;text-align:right">Rate</th><th style="padding:6px 8px;text-align:right">Amount</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#6b7280;font-size:12px;margin-top:8px">The original invoice PDF is attached. This grouping is the AI's best guess — verify it before signing off.</p>
      ${tariffAnalysisHtml(data.tariffAnalysis)}
      ${button(data.adminUrl, "Open in Sparks admin")}
    </div>`,
  };
}

/** Renders the "Tariff analysis (AI)" block for the review email. */
function tariffAnalysisHtml(a: TariffAnalysis | null | undefined): string {
  if (!a) return ""; // not an electricity bill — omit the section entirely
  const basisTag =
    a.basis === "reference"
      ? ` <span style="font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;background:#fef9c3;color:#854d0e">reference baseline</span>`
      : a.basis === "direct"
        ? ` <span style="font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;background:#dcfce7;color:#166534">direct</span>`
        : "";
  const heading = `<p style="margin:18px 0 6px;font-weight:600">Tariff analysis (AI)${
    a.scheduleName ? ` — vs ${escapeHtml(a.scheduleName)}` : ""
  }${basisTag}</p>`;
  const context = a.contextNote
    ? `<p style="color:#854d0e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 10px;font-size:12px;margin:0 0 8px">${escapeHtml(a.contextNote)}</p>`
    : "";
  if (!a.available || a.lines.length === 0) {
    return `${heading}${context}<p style="color:#6b7280;font-size:12px">${escapeHtml(
      a.note ?? "No tariff analysis available.",
    )}</p>`;
  }
  const verdictChip = (v: string) => {
    const map: Record<string, string> = {
      match: "#dcfce7;color:#166534",
      over: "#fee2e2;color:#991b1b",
      under: "#fef9c3;color:#854d0e",
      unknown: "#f3f4f6;color:#6b7280",
    };
    return `<span style="display:inline-block;font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;background:${
      map[v] ?? map.unknown
    }">${escapeHtml(v)}</span>`;
  };
  const rows = a.lines
    .map(
      (l) => `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(l.charge)}<br><span style="color:#6b7280;font-size:11px">${escapeHtml(l.detectedTariff)}</span></td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(l.scheduleRate ?? "—")}<br><span style="color:#6b7280;font-size:11px">${escapeHtml(l.scheduleRef ?? l.rateSource)}</span></td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${escapeHtml(l.billed)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${escapeHtml(l.expected ?? "—")}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee">${verdictChip(l.verdict)}${
          l.comment ? `<br><span style="color:#6b7280;font-size:11px">${escapeHtml(l.comment)}</span>` : ""
        }</td>
      </tr>`,
    )
    .join("");
  return `${heading}${context}
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="text-align:left;color:#6b7280;font-size:11px">
        <th style="padding:6px 8px">Charge / tariff</th><th style="padding:6px 8px">Schedule rate / source</th>
        <th style="padding:6px 8px;text-align:right">Billed</th><th style="padding:6px 8px;text-align:right">Expected</th>
        <th style="padding:6px 8px">Check</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#6b7280;font-size:12px;margin-top:6px">Rates cross-referenced by AI against ${escapeHtml(
      a.provider ?? "the schedule",
    )}. Treat as a guide and verify anything flagged.</p>`;
}

/**
 * Customer-facing review-outcome email — the operator's written description, with
 * their optional attachment (added by the caller).
 */
export function billReviewOutcomeEmail(data: {
  siteName: string;
  subject: string;
  body: string;
  verified: boolean;
  link: string;
}): { subject: string; html: string } {
  const bodyHtml = escapeHtml(data.body).replace(/\n/g, "<br>");
  return {
    subject: data.subject,
    html: `<div style="font-family:system-ui,sans-serif;max-width:560px;color:#111827">
      <span style="display:inline-block;font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;background:${
        data.verified ? "#dcfce7;color:#166534" : "#f3f4f6;color:#374151"
      }">${data.verified ? "Report available" : "No reconciliation found"}</span>
      <h2 style="margin:10px 0 8px">${escapeHtml(data.subject)}</h2>
      <p style="color:#6b7280;margin:0 0 12px">Review outcome for ${escapeHtml(data.siteName)}</p>
      <div style="font-size:14px;line-height:1.6">${bodyHtml}</div>
      ${button(data.link, "View in Sparks")}
    </div>`,
  };
}
