import { createHash } from "node:crypto";
import type { Device, Meter, Reconciliation, Site } from "@sparks/db";
import { chromium } from "playwright";

export interface ReportData {
  reconciliation: Reconciliation;
  site: Site;
  meter: Meter;
  /** Legacy gateway hardware — meters now write directly to the database, so this is optional. */
  device?: Device | null;
  landlordTariffName: string;
  ceilingTariffName: string | null;
  generatedAt?: Date; // Optional for testing; defaults to now()
}

/**
 * Turn the reconciliation numbers into plain-language, non-accusatory pointers a
 * tenant can raise with their landlord. Every item is framed as a question to ask
 * or a thing to confirm — never an accusation — so the report suggests clarifications
 * rather than pointing fingers. Ordered most-worth-asking first.
 */
export function buildClarificationPoints(
  recon: Reconciliation,
  landlordTariffName: string,
): string[] {
  const points: string[] = [];
  const rand = (cents: number): string => `R${(Math.abs(cents) / 100).toFixed(2)}`;
  // A difference only worth raising once it clears loose rounding noise (R10).
  const MATERIAL_CENTS = 1000;

  const components =
    (
      recon.breakdown as {
        components?: Array<{
          label: string;
          chargedCents: number;
          expectedLandlordCents: number;
          discrepancyVsLandlordCents: number;
        }>;
      } | null
    )?.components ?? [];

  // No tariff on file — we couldn't price the recorded usage against a rate at all.
  if (recon.expectedLandlordCents === null) {
    points.push(
      "We didn't have your landlord's tariff on file, so we couldn't line your recorded usage up against a rate. It's worth asking your landlord which tariff and unit rates they use to work out your bill.",
    );
  }

  // Headline difference between the quoted total and what the meter supports.
  const overall = recon.discrepancyVsLandlordCents;
  if (overall !== null && overall > MATERIAL_CENTS) {
    points.push(
      `Your quoted charge is about ${rand(overall)} more than your recorded usage comes to at the ${landlordTariffName} tariff. You could ask your landlord to walk you through how the total was worked out.`,
    );
  }

  // Line-by-line: flag any charge that sits materially above what the meter supports.
  for (const c of components) {
    if (c.discrepancyVsLandlordCents > MATERIAL_CENTS) {
      points.push(
        `The "${c.label}" line is about ${rand(c.discrepancyVsLandlordCents)} higher than your recorded usage supports — it's worth asking what rate or basis was applied to it.`,
      );
    }
  }

  // Data gaps: recorded usage may understate, so a high bill isn't necessarily wrong.
  if (recon.dataIntegrityStatus === "gaps_present") {
    points.push(
      `Your meter data has ${recon.gapCount} short gap(s) (${recon.gapMinutesTotal} minutes in total) during this period, so your recorded usage may be slightly understated. If the bill still looks high, it's worth confirming the readings your landlord used.`,
    );
  }

  // Nothing stood out — say so plainly rather than inventing a query.
  if (points.length === 0) {
    points.push(
      "Your quoted charges line up closely with what your meter recorded — there's nothing that stands out to query. Keep this report with your records in case you need it later.",
    );
  }

  return points;
}

/**
 * Render the reconciliation report to HTML — a neutral, tenant-facing document that
 * lays your recorded meter usage alongside the charges you were quoted, and turns any
 * differences into gentle "things to ask your landlord" pointers (see
 * {@link buildClarificationPoints}). It suggests clarifications; it does not accuse.
 * Includes: site/meter provenance, billing window, recorded usage, a recorded-vs-quoted
 * comparison, data-integrity notes, and the clarification pointers.
 */
export function renderReportHtml(data: ReportData): string {
  const {
    reconciliation: recon,
    site,
    meter,
    device,
    landlordTariffName,
    ceilingTariffName,
  } = data;

  const formatCents = (cents: number | null): string => {
    if (cents === null) return "—";
    return `R${(cents / 100).toFixed(2)}`;
  };

  const formatNumber = (val: string | number | null, decimals = 3): string => {
    if (val === null) return "—";
    return Number(val).toFixed(decimals);
  };

  // Line-by-line: what your meter's usage supports vs what you were quoted. We label
  // the difference neutrally ("higher"/"lower") rather than as an over/undercharge —
  // the report suggests questions, it doesn't return a verdict.
  const components =
    (
      recon.breakdown as {
        components?: Array<{
          label: string;
          chargedCents: number;
          expectedLandlordCents: number;
          discrepancyVsLandlordCents: number;
        }>;
      } | null
    )?.components ?? [];
  const diffLabel = (d: number): string =>
    d > 0 ? `${formatCents(d)} higher` : d < 0 ? `${formatCents(-d)} lower` : "—";
  const componentRows = components
    .map((c) => {
      const d = c.discrepancyVsLandlordCents;
      const cls = d > 0 ? "higher" : d < 0 ? "lower" : "";
      return `<tr>
        <td>${c.label}</td>
        <td>${formatCents(c.expectedLandlordCents)}</td>
        <td>${formatCents(c.chargedCents)}</td>
        <td class="${cls}">${diffLabel(d)}</td>
      </tr>`;
    })
    .join("");
  const componentSection = components.length
    ? `<div class="section">
      <h2>Line-by-line</h2>
      <table class="pricing-table">
        <thead><tr><th>Charge</th><th>Your usage supports</th><th>You were quoted</th><th>Difference</th></tr></thead>
        <tbody>${componentRows}
          <tr class="discrepancy">
            <td>Total</td>
            <td>${formatCents(recon.expectedLandlordCents)}</td>
            <td>${formatCents(recon.chargedTotalCents)}</td>
            <td class="${(recon.discrepancyVsLandlordCents ?? 0) > 0 ? "higher" : (recon.discrepancyVsLandlordCents ?? 0) < 0 ? "lower" : ""}">${diffLabel(recon.discrepancyVsLandlordCents ?? 0)}</td>
          </tr>
        </tbody>
      </table>
      <p style="font-size:11px;color:#777;margin-top:8px;">"Your usage supports" prices the meter's recorded usage at the ${landlordTariffName} tariff. Where the quoted amount is higher, the "Points to raise" below suggest what to ask about.</p>
    </div>`
    : "";

  const clarificationPoints = buildClarificationPoints(recon, landlordTariffName);
  const clarificationItems = clarificationPoints.map((p) => `<li>${p}</li>`).join("");

  const gapsText =
    recon.dataIntegrityStatus === "gaps_present"
      ? `Your data contains ${recon.gapCount} short gap(s) totalling ${recon.gapMinutesTotal} minutes. Recorded usage may slightly understate actual usage over these windows.`
      : "No data gaps were detected during the billing period — your recorded usage covers the whole window.";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Usage &amp; Billing Reconciliation</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      margin: 0;
      padding: 20px;
      background: #fff;
    }
    .container { max-width: 900px; margin: 0 auto; }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      padding-bottom: 16px;
      margin-bottom: 20px;
      border-bottom: 2px solid #15803d;
    }
    .brand .mark {
      width: 40px;
      height: 40px;
      border-radius: 9px;
      background: #ecfdf3;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .brand .wordmark { font-size: 20px; font-weight: 700; color: #0b3d20; letter-spacing: -0.01em; }
    .brand .tagline { font-size: 11px; color: #888; margin-top: 1px; }
    h1 { font-size: 24px; margin: 0 0 10px 0; color: #1a1a1a; }
    .subtitle { color: #666; font-size: 14px; margin-bottom: 20px; }
    .section {
      margin-top: 30px;
      padding: 15px;
      background: #f9f9f9;
      border-left: 4px solid #15803d;
    }
    .section h2 {
      margin: 0 0 15px 0;
      font-size: 16px;
      color: #15803d;
    }
    .provenance-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
      margin-bottom: 15px;
    }
    .provenance-item {
      background: #fff;
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 4px;
    }
    .provenance-item label {
      display: block;
      font-size: 12px;
      color: #666;
      margin-bottom: 4px;
      font-weight: 500;
    }
    .provenance-item .value {
      font-size: 14px;
      color: #1a1a1a;
      word-break: break-word;
    }
    .pricing-table {
      width: 100%;
      border-collapse: collapse;
      margin: 15px 0;
      background: #fff;
    }
    .pricing-table th {
      background: #f0f0f0;
      border: 1px solid #ddd;
      padding: 10px;
      text-align: left;
      font-weight: 600;
      font-size: 13px;
    }
    .pricing-table td {
      border: 1px solid #ddd;
      padding: 10px;
      font-size: 13px;
    }
    .pricing-table tr.discrepancy td {
      background: #f4faf6;
      font-weight: 600;
    }
    /* Neutral, not alarmist: "higher" is amber (worth a look), "lower" muted. */
    .pricing-table .higher { color: #b45309; }
    .pricing-table .lower { color: #557; }
    .points {
      margin: 6px 0 0 0;
      padding-left: 20px;
    }
    .points li {
      font-size: 13px;
      color: #333;
      margin-bottom: 10px;
      line-height: 1.6;
    }
    .data-integrity {
      padding: 10px;
      border-radius: 4px;
      margin: 15px 0;
      font-size: 13px;
    }
    .data-integrity.clean {
      background: #e8f5e9;
      color: #2e7d32;
      border-left: 4px solid #2e7d32;
    }
    .data-integrity.gaps {
      background: #fff3e0;
      color: #e65100;
      border-left: 4px solid #e65100;
    }
    .note-section {
      background: #f5f5f5;
      padding: 15px;
      border-radius: 4px;
      font-size: 12px;
      line-height: 1.7;
      color: #555;
    }
    .timestamp {
      text-align: right;
      font-size: 11px;
      color: #999;
      margin-top: 30px;
      padding-top: 15px;
      border-top: 1px solid #ddd;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">
      <span class="mark">
        <svg width="26" height="26" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M6 24 H15.5 C18.2 24 18.6 37 22 37 C25.4 37 25 11 28.5 11 C32 11 31.8 24 34.5 24 H42"
            stroke="#15803d" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>
      <span>
        <div class="wordmark">Sparks</div>
        <div class="tagline">Energy Reconciliation</div>
      </span>
    </div>
    <h1>Usage &amp; Billing Reconciliation</h1>
    <div class="subtitle">Your recorded meter usage, laid out next to the charges you were quoted — with a few things you may want to ask your landlord to clarify.</div>

    <!-- Site & Meter Provenance -->
    <div class="section">
      <h2>Site & Meter Information</h2>
      <div class="provenance-grid">
        <div class="provenance-item">
          <label>Site Name</label>
          <div class="value">${site.name || "—"}</div>
        </div>
        <div class="provenance-item">
          <label>Address</label>
          <div class="value">${[site.addressLine1, site.city, site.province].filter(Boolean).join(", ") || "—"}</div>
        </div>
        <div class="provenance-item">
          <label>Meter Serial Number</label>
          <div class="value">${meter.serialNumber}</div>
        </div>
        <div class="provenance-item">
          <label>Device Serial Number</label>
          <div class="value">${device?.serialNumber || "—"}</div>
        </div>
        <div class="provenance-item">
          <label>Meter Model</label>
          <div class="value">${meter.model || "—"}</div>
        </div>
        <div class="provenance-item">
          <label>Installed Date</label>
          <div class="value">${meter.installedAt ? new Date(meter.installedAt).toLocaleDateString("en-ZA") : "—"}</div>
        </div>
      </div>
    </div>

    <!-- Billing Window -->
    <div class="section">
      <h2>Billing Window & Measurement Interval</h2>
      <div class="provenance-grid">
        <div class="provenance-item">
          <label>Period Start</label>
          <div class="value">${new Date(recon.billingPeriodStart).toLocaleDateString("en-ZA", { weekday: "short", year: "numeric", month: "short", day: "numeric" })}</div>
        </div>
        <div class="provenance-item">
          <label>Period End</label>
          <div class="value">${new Date(recon.billingPeriodEnd).toLocaleDateString("en-ZA", { weekday: "short", year: "numeric", month: "short", day: "numeric" })}</div>
        </div>
        <div class="provenance-item">
          <label>Boundary Inclusivity</label>
          <div class="value">${recon.boundaryInclusivity === "half_open" ? "Half-open (exclusive end)" : recon.boundaryInclusivity === "inclusive" ? "Inclusive" : recon.boundaryInclusivity}</div>
        </div>
        <div class="provenance-item">
          <label>Demand Interval</label>
          <div class="value">${recon.demandIntervalMinutes} minutes</div>
        </div>
      </div>
    </div>

    <!-- Recorded Usage -->
    <div class="section">
      <h2>What your meter recorded</h2>
      <div class="provenance-grid">
        <div class="provenance-item">
          <label>Active Energy</label>
          <div class="value">${formatNumber(recon.measuredActiveKwh)} kWh</div>
        </div>
        <div class="provenance-item">
          <label>Maximum Demand</label>
          <div class="value">${formatNumber(recon.measuredMaxDemandKva, 2)} kVA</div>
        </div>
        <div class="provenance-item">
          <label>Reactive Energy</label>
          <div class="value">${formatNumber(recon.measuredReactiveKvarh)} kVAr·h</div>
        </div>
        <div class="provenance-item">
          <label>Status</label>
          <div class="value">${recon.status === "final" ? "Final" : "Draft"}</div>
        </div>
      </div>
    </div>

    <!-- Recorded usage vs quoted charges -->
    <div class="section">
      <h2>Recorded usage vs quoted charges</h2>
      <table class="pricing-table">
        <thead>
          <tr>
            <th>Basis</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Your recorded usage, priced at the ${landlordTariffName} tariff</td>
            <td>${formatCents(recon.expectedLandlordCents)}</td>
          </tr>
          <tr class="discrepancy">
            <td>What you were quoted</td>
            <td>${formatCents(recon.chargedTotalCents)}</td>
          </tr>
          <tr>
            <td>Difference</td>
            <td class="${(recon.discrepancyVsLandlordCents ?? 0) > 0 ? "higher" : (recon.discrepancyVsLandlordCents ?? 0) < 0 ? "lower" : ""}">${recon.discrepancyVsLandlordCents === null ? "—" : diffLabel(recon.discrepancyVsLandlordCents)}</td>
          </tr>
          ${
            ceilingTariffName
              ? `
          <tr>
            <td>Legal maximum for reference (${ceilingTariffName})</td>
            <td>${formatCents(recon.expectedCeilingCents)}</td>
          </tr>
          `
              : ""
          }
        </tbody>
      </table>
      ${
        recon.expectedLandlordCents === null
          ? `<p style="font-size:11px;color:#777;margin-top:8px;">We didn't have your landlord's tariff on file, so we couldn't price your recorded usage against a rate. See the points below for what to ask.</p>`
          : ""
      }
    </div>

    ${componentSection}

    <!-- Points to raise with your landlord -->
    <div class="section">
      <h2>Points to raise with your landlord</h2>
      <p style="font-size:12px;color:#666;margin:0 0 6px 0;">These are suggestions, not accusations — a friendly starting point for a conversation about your bill.</p>
      <ul class="points">${clarificationItems}</ul>
    </div>

    <!-- Data note -->
    <div class="section">
      <h2>About your recorded data</h2>
      <div class="data-integrity ${recon.dataIntegrityStatus === "gaps_present" ? "gaps" : "clean"}">
        ${gapsText}
      </div>
    </div>

    <!-- How to use this report -->
    <div class="section">
      <h2>How to use this report</h2>
      <div class="note-section">
        <p>This report puts your independently recorded meter usage next to the charges you were quoted, so you can have an informed, good-faith conversation with your landlord.</p>
        <ol style="margin: 10px 0; padding-left: 20px;">
          <li>Share it with your landlord and ask about any of the points above.</li>
          <li>Ask for a detailed breakdown of the charges and the meter readings they used.</li>
          <li>Keep this report with your records in case you need to refer back to it.</li>
        </ol>
        <p style="margin-top: 15px; font-size: 11px; color: #777;">
          The figures come from your sub-meter's recorded usage priced at the tariff on file. They're intended to help you understand and discuss your bill — not to make a legal determination about it.
        </p>
      </div>
    </div>

    <div class="timestamp">
      Report generated: ${(data.generatedAt || new Date()).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })}
    </div>
  </div>
</body>
</html>`;

  return html;
}

/**
 * Render HTML to PDF using Playwright/Chromium.
 * Returns Buffer containing the PDF.
 */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      margin: { top: 20, bottom: 20, left: 20, right: 20 },
    });
    await page.close();
    return pdfBuffer;
  } finally {
    await browser.close();
  }
}

/**
 * Compute SHA256 hash of a buffer.
 */
export function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
