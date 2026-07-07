import { createHash } from "node:crypto";
import type { Device, Meter, Reconciliation, Site } from "@sparks/db";
import { chromium } from "playwright";

export interface ReportData {
  reconciliation: Reconciliation;
  site: Site;
  meter: Meter;
  device: Device;
  landlordTariffName: string;
  ceilingTariffName: string | null;
  generatedAt?: Date; // Optional for testing; defaults to now()
}

/**
 * Render reconciliation report to HTML.
 * Includes: site/meter provenance, billing window, measured data,
 * expected vs actual pricing, data-integrity status with gaps flagged,
 * and NERSA recourse path.
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

  // Component-by-component comparison, persisted in the reconciliation breakdown.
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
  const componentRows = components
    .map((c) => {
      const d = c.discrepancyVsLandlordCents;
      const cls = d > 0 ? "negative" : d < 0 ? "positive" : "";
      return `<tr>
        <td>${c.label}</td>
        <td>${formatCents(c.chargedCents)}</td>
        <td>${formatCents(c.expectedLandlordCents)}</td>
        <td class="${cls}">${d > 0 ? "+" : ""}${formatCents(d)}</td>
      </tr>`;
    })
    .join("");
  const componentSection = components.length
    ? `<div class="section">
      <h2>Charge-by-charge comparison</h2>
      <table class="pricing-table">
        <thead><tr><th>Component</th><th>Charged</th><th>Expected (landlord tariff)</th><th>Discrepancy</th></tr></thead>
        <tbody>${componentRows}
          <tr class="discrepancy">
            <td>Total</td>
            <td>${formatCents(recon.chargedTotalCents)}</td>
            <td>${formatCents(recon.expectedLandlordCents)}</td>
            <td class="${(recon.discrepancyVsLandlordCents ?? 0) > 0 ? "negative" : "positive"}">${(recon.discrepancyVsLandlordCents ?? 0) > 0 ? "+" : ""}${formatCents(recon.discrepancyVsLandlordCents)}</td>
          </tr>
        </tbody>
      </table>
      <p style="font-size:11px;color:#777;margin-top:8px;">A positive discrepancy indicates the amount charged exceeds what the meter reading priced at the landlord tariff supports.</p>
    </div>`
    : "";

  const gapsText =
    recon.dataIntegrityStatus === "gaps_present"
      ? `⚠ Data contains ${recon.gapCount} gap(s) totaling ${recon.gapMinutesTotal} minutes. Measured data may understate actual usage.`
      : "✓ No data gaps detected during billing period.";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Electricity Reconciliation Report</title>
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
      border-bottom: 2px solid #0b1220;
    }
    .brand .mark {
      width: 40px;
      height: 40px;
      border-radius: 9px;
      background: #0b1220;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .brand .wordmark { font-size: 20px; font-weight: 700; color: #0b1220; letter-spacing: -0.01em; }
    .brand .tagline { font-size: 11px; color: #888; margin-top: 1px; }
    h1 { font-size: 24px; margin: 0 0 10px 0; color: #1a1a1a; }
    .subtitle { color: #666; font-size: 14px; margin-bottom: 20px; }
    .section {
      margin-top: 30px;
      padding: 15px;
      background: #f9f9f9;
      border-left: 4px solid #0066cc;
    }
    .section h2 {
      margin: 0 0 15px 0;
      font-size: 16px;
      color: #0066cc;
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
      background: #fff8e6;
      font-weight: 600;
    }
    .pricing-table .negative { color: #d9534f; }
    .pricing-table .positive { color: #5cb85c; }
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
    .nersa-section {
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
            stroke="#3b82f6" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>
      <span>
        <div class="wordmark">Sparks</div>
        <div class="tagline">Energy Reconciliation</div>
      </span>
    </div>
    <h1>Electricity Reconciliation Report</h1>
    <div class="subtitle">Dispute-ready report with measured vs. billed reconciliation</div>

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
          <div class="value">${device.serialNumber}</div>
        </div>
        <div class="provenance-item">
          <label>Meter Model</label>
          <div class="value">${meter.model || "—"}</div>
        </div>
        <div class="provenance-item">
          <label>MID Certificate</label>
          <div class="value">${meter.midCertificateRef || (meter.midCertifiedVariant ? "MID Certified" : "Not MID Certified")}</div>
        </div>
        <div class="provenance-item">
          <label>CT Ratio</label>
          <div class="value">${meter.ctRatioPrimary || "—"}:${meter.ctRatioSecondary || "5"}</div>
        </div>
        <div class="provenance-item">
          <label>Phase Configuration</label>
          <div class="value">${meter.phaseConfig || "—"}</div>
        </div>
        <div class="provenance-item">
          <label>Installer Name & Licence</label>
          <div class="value">${meter.installedByName || "—"}${meter.installerRegistration ? ` (${meter.installerRegistration})` : ""}</div>
        </div>
        <div class="provenance-item">
          <label>Commissioned Date</label>
          <div class="value">${meter.commissionedAt ? new Date(meter.commissionedAt).toLocaleDateString("en-ZA") : "—"}</div>
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

    <!-- Measured Data -->
    <div class="section">
      <h2>Measured Usage Data</h2>
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

    <!-- Pricing Comparison -->
    <div class="section">
      <h2>Pricing Comparison: Expected vs. Charged</h2>
      <table class="pricing-table">
        <thead>
          <tr>
            <th>Tariff</th>
            <th>Expected Charge</th>
            <th>Actual Charge</th>
            <th>Discrepancy</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Landlord Stated (${landlordTariffName})</td>
            <td>${formatCents(recon.expectedLandlordCents)}</td>
            <td>${formatCents(recon.chargedTotalCents)}</td>
            <td class="${recon.discrepancyVsLandlordCents && recon.discrepancyVsLandlordCents < 0 ? "negative" : "positive"}">
              ${recon.discrepancyVsLandlordCents ? (recon.discrepancyVsLandlordCents < 0 ? "−" : "+") : ""}${formatCents(Math.abs(recon.discrepancyVsLandlordCents || 0))}
            </td>
          </tr>
          ${
            ceilingTariffName
              ? `
          <tr>
            <td>Legal Ceiling (${ceilingTariffName})</td>
            <td>${formatCents(recon.expectedCeilingCents)}</td>
            <td>${formatCents(recon.chargedTotalCents)}</td>
            <td class="${recon.discrepancyVsCeilingCents && recon.discrepancyVsCeilingCents < 0 ? "negative" : "positive"}">
              ${recon.discrepancyVsCeilingCents ? (recon.discrepancyVsCeilingCents < 0 ? "−" : "+") : ""}${formatCents(Math.abs(recon.discrepancyVsCeilingCents || 0))}
            </td>
          </tr>
          `
              : ""
          }
        </tbody>
      </table>
    </div>

    ${componentSection}

    <!-- Data Integrity -->
    <div class="section">
      <h2>Data Integrity Status</h2>
      <div class="data-integrity ${recon.dataIntegrityStatus === "gaps_present" ? "gaps" : "clean"}">
        ${gapsText}
      </div>
    </div>

    <!-- NERSA Recourse -->
    <div class="section">
      <h2>Consumer Recourse &amp; Regulatory Framework</h2>
      <div class="nersa-section">
        <p><strong>If this reconciliation indicates overcharging:</strong></p>
        <ol style="margin: 10px 0; padding-left: 20px;">
          <li>Report discrepancies to your electricity provider within 30 days of invoice receipt.</li>
          <li>Request a detailed breakdown of charges and meter readings.</li>
          <li>If unresolved, escalate to your provincial Energy Regulator (NERSA) or local authority.</li>
          <li>Preserve this report as evidence of measured vs. billed discrepancies.</li>
        </ol>
        <p style="margin-top: 15px; font-size: 11px; color: #777;">
          This report reconciles measured electrical consumption against landlord and legal ceiling tariffs.
          It provides supporting evidence for any dispute regarding billing accuracy.
          Legal ceiling tariffs are set under NERSA regulations; landlord tariffs reflect contractual arrangements.
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
