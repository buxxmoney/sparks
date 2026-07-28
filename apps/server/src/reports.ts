import { createHash } from "node:crypto";
import type { Device, Meter, Reconciliation, Site } from "@sparks/db";
import { chromium } from "playwright";
import {
  type DailyPoint,
  dailyUsageBars,
  demandProfileLine,
  periodTrendChart,
  type ReconComponent,
  reconComponentsBars,
} from "./report-charts";

/** One period in the period-over-period section — richer than the chart's PeriodPoint so
 *  the comparison table can also show usage and peak columns. */
export interface PeriodHistoryRow {
  label: string;
  usedKwh: number;
  peakKva: number;
  chargedRand: number;
  effRateCents: number;
}

export interface ReportData {
  reconciliation: Reconciliation;
  site: Site;
  meter: Meter;
  /** Legacy gateway hardware — meters now write directly to the database, so this is optional. */
  device?: Device | null;
  landlordTariffName: string;
  ceilingTariffName: string | null;
  generatedAt?: Date; // Optional for testing; defaults to now()
  /** Recorded energy per calendar day over the period (drives the daily-usage bars). */
  dailyUsage?: DailyPoint[];
  /** Recorded peak demand (kVA) per calendar day (drives the demand-profile line). */
  dailyPeakDemand?: DailyPoint[];
  /** This period + prior periods, oldest→newest, for the period-over-period section. */
  periodHistory?: PeriodHistoryRow[];
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
 * Render the Sparks energy statement to HTML — a flagship, tenant-facing document that
 * lays your independently recorded meter usage alongside the charges you were quoted,
 * with real charts (daily usage, daily peak demand, period-over-period trend, and a
 * recorded-vs-quoted breakdown) and gentle "things to ask your landlord" pointers (see
 * {@link buildClarificationPoints}). It suggests clarifications; it does not accuse.
 * Charts are server-rendered SVG (see report-charts.ts) so they survive the PDF pipeline.
 */
export function renderReportHtml(data: ReportData): string {
  const { reconciliation: recon, site, meter, device, landlordTariffName } = data;
  const tz = site.timezone || "Africa/Johannesburg";
  const dailyUsage = data.dailyUsage ?? [];
  const dailyPeak = data.dailyPeakDemand ?? [];
  const history = data.periodHistory ?? [];

  const groupThousands = (n: number): string =>
    Math.round(n)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const formatCents = (cents: number | null): string =>
    cents === null ? "—" : `R${(cents / 100).toFixed(2)}`;
  const fmtRandBig = (cents: number | null): string =>
    cents === null
      ? "—"
      : `R${groupThousands(Math.floor(cents / 100))}.${String(((cents % 100) + 100) % 100).padStart(2, "0")}`;
  const diffLabel = (d: number): string =>
    d > 0 ? `${formatCents(d)} higher` : d < 0 ? `${formatCents(-d)} lower` : "—";
  const fmtDate = (x: Date | string, opts: Intl.DateTimeFormatOptions): string =>
    new Date(x).toLocaleDateString("en-ZA", { timeZone: tz, ...opts });

  // Billing window.
  const periodStartStr = fmtDate(recon.billingPeriodStart, { day: "numeric", month: "short" });
  const periodEndStr = fmtDate(recon.billingPeriodEnd, { day: "numeric", month: "short" });
  const periodYear = fmtDate(recon.billingPeriodEnd, { year: "numeric" });
  const periodDays = Math.max(
    1,
    Math.round(
      (new Date(recon.billingPeriodEnd).getTime() - new Date(recon.billingPeriodStart).getTime()) /
        86_400_000,
    ),
  );

  // Summary "you were quoted" note — the one place the difference is called out.
  const diff = recon.discrepancyVsLandlordCents;
  let diffNote: string;
  let diffAccent = false;
  if (recon.expectedLandlordCents === null) {
    diffNote = "no landlord tariff on file yet";
  } else if (diff !== null && diff > 0) {
    diffNote = `${formatCents(diff)} higher · worth a look`;
    diffAccent = true;
  } else if (diff !== null && diff < 0) {
    diffNote = `${formatCents(-diff)} lower than expected`;
  } else {
    diffNote = "in line with your usage";
  }

  // Line-by-line: what your meter's usage supports vs what you were quoted. We label
  // the difference neutrally ("higher"/"lower") rather than as an over/undercharge.
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
      const cls = d > 0 ? "higher" : d < 0 ? "lower" : "";
      return `<tr>
        <td>${c.label}</td>
        <td>${formatCents(c.expectedLandlordCents)}</td>
        <td>${formatCents(c.chargedCents)}</td>
        <td class="${cls}">${diffLabel(d)}</td>
      </tr>`;
    })
    .join("");

  const reconBars: ReconComponent[] = components.length
    ? components.map((c) => ({
        label: c.label,
        supportsRand: c.expectedLandlordCents / 100,
        quotedRand: c.chargedCents / 100,
      }))
    : recon.expectedLandlordCents !== null
      ? [
          {
            label: "Total",
            supportsRand: recon.expectedLandlordCents / 100,
            quotedRand: (recon.chargedTotalCents ?? 0) / 100,
          },
        ]
      : [];

  // Period-over-period table rows, with a delta vs the previous period's quoted total.
  const trendRows = history
    .map((p, i) => {
      const prev = i > 0 ? history[i - 1] : null;
      const dPct = prev && prev.chargedRand > 0 ? ((p.chargedRand - prev.chargedRand) / prev.chargedRand) * 100 : null;
      const deltaCell =
        dPct === null
          ? `<td class="muted">—</td>`
          : `<td class="${dPct >= 0 ? "delta-up" : "delta-down"}">${dPct >= 0 ? "▲ " : "▼ "}${Math.abs(dPct).toFixed(1)}%</td>`;
      const isLast = i === history.length - 1;
      return `<tr>
        <td>${p.label}${isLast ? ' <span class="tag">this period</span>' : ""}</td>
        <td>${groupThousands(p.usedKwh)}</td>
        <td>${p.peakKva.toFixed(1)}</td>
        <td>${fmtRandBig(Math.round(p.chargedRand * 100))}</td>
        <td>${p.effRateCents.toFixed(1)}c</td>
        ${deltaCell}
      </tr>`;
    })
    .join("");

  const clarificationItems = buildClarificationPoints(recon, landlordTariffName)
    .map((p) => `<li>${p}</li>`)
    .join("");

  const gapsText =
    recon.dataIntegrityStatus === "gaps_present"
      ? `Your data contains ${recon.gapCount} short gap(s) totalling ${recon.gapMinutesTotal} minutes. Recorded usage may slightly understate actual usage over these windows.`
      : "No data gaps were detected during the billing period — your recorded usage covers the whole window.";

  // Charts (server-rendered SVG).
  const usageSvg = dailyUsageBars(dailyUsage);
  const demandSvg = demandProfileLine(dailyPeak, Number(recon.measuredMaxDemandKva ?? 0));
  const trendSvg = periodTrendChart(
    history.map((p) => ({ label: p.label, chargedRand: p.chargedRand, effRateCents: p.effRateCents })),
  );
  const reconSvg = reconComponentsBars(reconBars);

  const ceilingRef =
    data.ceilingTariffName && recon.expectedCeilingCents !== null
      ? `<p class="footnote">For reference, the legal maximum (${data.ceilingTariffName}) for this usage is ${formatCents(recon.expectedCeilingCents)}.</p>`
      : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sparks Energy Statement</title>
  <style>
    :root {
      --brand: #15803d; --brand-deep: #0b3d20; --brand-soft: #e7f4ec;
      --ink: #14211a; --ink-2: #3b4640; --muted: #6b756f; --line: #e4ebe6;
      --amber: #b45309; --slate: #59636e;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: var(--ink-2); line-height: 1.6; margin: 0; background: #fff;
      -webkit-font-smoothing: antialiased;
    }
    .container { max-width: 820px; margin: 0 auto; padding: 8px 10px 32px; }
    .tnum { font-variant-numeric: tabular-nums; }

    .masthead { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px;
      padding-bottom: 20px; border-bottom: 2px solid var(--brand); flex-wrap: wrap; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand .mark { width: 42px; height: 42px; border-radius: 10px; background: var(--brand-soft);
      display: flex; align-items: center; justify-content: center; flex: none; }
    .wordmark { font-size: 19px; font-weight: 700; color: var(--brand-deep); letter-spacing: .14em; text-transform: uppercase; }
    .tagline { font-size: 10.5px; color: var(--muted); letter-spacing: .16em; text-transform: uppercase; margin-top: 2px; }
    .masthead .meta { text-align: right; font-size: 12px; color: var(--muted); line-height: 1.7; }
    .masthead .meta b { color: var(--ink); font-weight: 600; }

    h1 { font-size: 26px; line-height: 1.2; color: var(--ink); margin: 24px 0 4px; letter-spacing: -.01em; font-weight: 650; }
    .subtitle { font-size: 14px; color: var(--muted); margin: 0; max-width: 60ch; }

    .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--line);
      border: 1px solid var(--line); border-radius: 6px; overflow: hidden; margin-top: 24px; }
    .summary .cell { background: #fff; padding: 15px 16px; }
    .summary .k { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 7px; }
    .summary .v { font-size: 22px; font-weight: 650; color: var(--ink); letter-spacing: -.01em; }
    .summary .v.sm { font-size: 15px; line-height: 1.35; }
    .summary .u { font-size: 12px; color: var(--muted); font-weight: 500; margin-left: 3px; }
    .summary .cell.accent .v { color: var(--amber); }
    .summary .sub { font-size: 11.5px; color: var(--muted); margin-top: 3px; }
    .summary .sub.amber { color: var(--amber); }

    section { margin-top: 34px; page-break-inside: avoid; }
    .eyebrow { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .13em; color: var(--brand); margin-bottom: 6px; }
    h2 { font-size: 18px; color: var(--ink); margin: 0 0 4px; font-weight: 600; letter-spacing: -.005em; }
    .lede { font-size: 13.5px; color: var(--muted); margin: 0 0 16px; max-width: 66ch; }

    .panel { border: 1px solid var(--line); border-radius: 8px; padding: 18px 18px 6px; }
    .panel .callout { display: flex; gap: 10px; align-items: baseline; margin: 2px 4px 12px; padding: 10px 14px;
      background: var(--brand-soft); border-radius: 6px; font-size: 12.5px; color: var(--brand-deep); }
    .panel .callout b { font-weight: 650; }
    figure { margin: 0; }
    figcaption { font-size: 11.5px; color: var(--muted); margin: 6px 4px 10px; }
    svg.chart { display: block; width: 100%; height: auto; }

    .legend { display: flex; gap: 18px; flex-wrap: wrap; font-size: 12px; color: var(--ink-2); margin: 2px 4px 12px; }
    .legend span { display: inline-flex; align-items: center; gap: 7px; }
    .swatch { width: 11px; height: 11px; border-radius: 3px; flex: none; }

    .scroll { overflow-x: auto; margin-top: 14px; }
    table.data { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
    table.data th, table.data td { padding: 9px 12px; text-align: right; border-bottom: 1px solid var(--line); }
    table.data th:first-child, table.data td:first-child { text-align: left; }
    table.data thead th { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 600; border-bottom: 1.5px solid var(--line); }
    table.data tbody tr:last-child td { border-bottom: none; }
    table.data tr.total td { font-weight: 650; color: var(--ink); background: #f6faf7; border-top: 1.5px solid var(--line); }
    .delta-up { color: var(--amber); font-weight: 600; }
    .delta-down { color: var(--brand); font-weight: 600; }
    td.higher { color: var(--amber); }
    td.lower { color: var(--slate); }
    td.muted { color: var(--muted); }
    .tag { display: inline-block; font-size: 11px; padding: 1px 8px; border-radius: 20px; background: var(--brand-soft); color: var(--brand-deep); font-weight: 600; }
    .footnote { font-size: 11px; color: var(--muted); margin: 8px 4px 0; }

    ol.points { list-style: none; margin: 0; padding: 0; counter-reset: p; display: grid; gap: 13px; }
    ol.points li { position: relative; padding-left: 40px; font-size: 13.5px; color: var(--ink-2); }
    ol.points li::before { counter-increment: p; content: counter(p); position: absolute; left: 0; top: -1px;
      width: 26px; height: 26px; border-radius: 50%; background: var(--brand-soft); color: var(--brand-deep);
      font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
    ol.howto { display: grid; gap: 8px; margin: 0; padding-left: 20px; font-size: 13px; }
    .disclaimer { font-size: 12px; color: var(--muted); line-height: 1.7; margin-top: 14px; }

    .provenance { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 14px; }
    .provenance .pi { font-size: 12px; }
    .provenance .pi label { display: block; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-bottom: 2px; }
    .provenance .pi .val { color: var(--ink); }

    footer { margin-top: 34px; padding-top: 16px; border-top: 1px solid var(--line);
      display: flex; justify-content: space-between; gap: 16px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
  </style>
</head>
<body>
  <div class="container">

    <div class="masthead">
      <div class="brand">
        <span class="mark">
          <svg width="28" height="28" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M6 24 H15.5 C18.2 24 18.6 37 22 37 C25.4 37 25 11 28.5 11 C32 11 31.8 24 34.5 24 H42"
              stroke="#15803d" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
        <span>
          <div class="wordmark">Sparks</div>
          <div class="tagline">Energy Reconciliation</div>
        </span>
      </div>
      <div class="meta">
        <div><b>${site.name || "—"}</b></div>
        <div>${[site.addressLine1, site.city, site.province].filter(Boolean).join(", ") || "—"}</div>
        <div>Meter ${meter.serialNumber}${meter.model ? ` · ${meter.model}` : ""}</div>
        <div>Statement ref ${recon.id.slice(0, 8).toUpperCase()}</div>
      </div>
    </div>

    <h1>Energy Statement</h1>
    <p class="subtitle">Your independently recorded electricity use for this billing period, set alongside the charges you were quoted.</p>

    <div class="summary">
      <div class="cell">
        <div class="k">Billing period</div>
        <div class="v sm">${periodStartStr} – ${periodEndStr}<div class="sub">${periodYear} · ${periodDays} days</div></div>
      </div>
      <div class="cell">
        <div class="k">Electricity used</div>
        <div class="v tnum">${groupThousands(Number(recon.measuredActiveKwh))}<span class="u">kWh</span></div>
        <div class="sub">Peak demand ${Number(recon.measuredMaxDemandKva ?? 0).toFixed(1)} kVA</div>
      </div>
      <div class="cell">
        <div class="k">Your usage supports</div>
        <div class="v tnum">${fmtRandBig(recon.expectedLandlordCents)}</div>
        <div class="sub">at the ${landlordTariffName} tariff</div>
      </div>
      <div class="cell${diffAccent ? " accent" : ""}">
        <div class="k">You were quoted</div>
        <div class="v tnum">${fmtRandBig(recon.chargedTotalCents)}</div>
        <div class="sub${diffAccent ? " amber" : ""}">${diffNote}</div>
      </div>
    </div>

    <section>
      <div class="eyebrow">Consumption</div>
      <h2>Electricity used, day by day</h2>
      <p class="lede">How much your meter recorded each day of the period.</p>
      <div class="panel">
        <figure>
          ${usageSvg}
          <figcaption>Recorded active energy per calendar day (kWh), site timezone ${tz}.</figcaption>
        </figure>
      </div>
    </section>

    <section>
      <div class="eyebrow">Demand</div>
      <h2>Your daily peak demand</h2>
      <p class="lede">Demand charges are set by your single highest half-hour of the month — not your total usage. This is the peak your meter recorded each day.</p>
      <div class="panel">
        <div class="callout"><b>Month peak: ${Number(recon.measuredMaxDemandKva ?? 0).toFixed(1)} kVA</b><span>your demand charge is based on the highest ${recon.demandIntervalMinutes}-minute average of the period, not your total usage.</span></div>
        <figure>
          ${demandSvg}
          <figcaption>Highest ${recon.demandIntervalMinutes}-minute demand average per day (kVA).</figcaption>
        </figure>
      </div>
    </section>

    <section>
      <div class="eyebrow">Trend</div>
      <h2>How this period compares</h2>
      <p class="lede">Your recent billing periods side by side — usage, what you were quoted, peak demand, and the effective rate you paid per unit. This fills in as each period closes.</p>
      <div class="panel">
        <div class="legend">
          <span><span class="swatch" style="background:var(--brand)"></span>Quoted total (R)</span>
          <span><span class="swatch" style="background:var(--amber)"></span>Effective rate (c/kWh)</span>
        </div>
        <figure>${trendSvg}</figure>
      </div>
      <div class="scroll">
        <table class="data">
          <thead>
            <tr><th>Period</th><th>Used (kWh)</th><th>Peak (kVA)</th><th>Quoted</th><th>Eff. rate</th><th>vs prev.</th></tr>
          </thead>
          <tbody>${trendRows || '<tr><td colspan="6" class="muted">No history yet — this fills in each period.</td></tr>'}</tbody>
        </table>
      </div>
    </section>

    <section>
      <div class="eyebrow">Reconciliation</div>
      <h2>Recorded usage vs quoted charges</h2>
      <p class="lede">Each charge on your bill, next to what your recorded usage supports at the tariff on file. Where the quote is higher, the points below suggest what to ask.</p>
      <div class="panel">
        <div class="legend">
          <span><span class="swatch" style="background:var(--brand)"></span>Your usage supports</span>
          <span><span class="swatch" style="background:var(--amber)"></span>You were quoted</span>
        </div>
        <figure>${reconSvg}</figure>
      </div>
      <div class="scroll">
        <table class="data">
          <thead>
            <tr><th>Charge</th><th>Your usage supports</th><th>You were quoted</th><th>Difference</th></tr>
          </thead>
          <tbody>
            ${componentRows}
            <tr class="total">
              <td>Total</td>
              <td>${formatCents(recon.expectedLandlordCents)}</td>
              <td>${formatCents(recon.chargedTotalCents)}</td>
              <td class="${(recon.discrepancyVsLandlordCents ?? 0) > 0 ? "higher" : (recon.discrepancyVsLandlordCents ?? 0) < 0 ? "lower" : ""}">${recon.discrepancyVsLandlordCents === null ? "—" : diffLabel(recon.discrepancyVsLandlordCents)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      ${ceilingRef}
    </section>

    <section>
      <div class="eyebrow">Next steps</div>
      <h2>Points to raise with your landlord</h2>
      <p class="lede">Suggestions, not accusations — a friendly starting point for a conversation about your bill.</p>
      <ol class="points">${clarificationItems}</ol>
    </section>

    <section>
      <div class="eyebrow">About this statement</div>
      <h2>How to use it</h2>
      <ol class="howto">
        <li>Share it with your landlord and ask about any of the points above.</li>
        <li>Ask for a detailed breakdown of the charges and the meter readings they used.</li>
        <li>Keep it with your records in case you need to refer back to it.</li>
      </ol>
      <p class="disclaimer">${gapsText} The figures come from your sub-meter's recorded usage, priced at the tariff on file. This statement is intended to help you understand and discuss your bill — not to make a legal determination about it.</p>
      <div class="provenance">
        <div class="pi"><label>Meter</label><div class="val">${meter.serialNumber}${meter.model ? ` · ${meter.model}` : ""}</div></div>
        <div class="pi"><label>Installed</label><div class="val">${meter.installedAt ? fmtDate(meter.installedAt, { year: "numeric", month: "short", day: "numeric" }) : "—"}</div></div>
        <div class="pi"><label>Gateway</label><div class="val">${device?.serialNumber || "—"}</div></div>
        <div class="pi"><label>Demand interval</label><div class="val">${recon.demandIntervalMinutes} minutes</div></div>
        <div class="pi"><label>Period boundary</label><div class="val">${recon.boundaryInclusivity === "half_open" ? "Half-open (exclusive end)" : recon.boundaryInclusivity === "inclusive" ? "Inclusive" : recon.boundaryInclusivity}</div></div>
        <div class="pi"><label>Data integrity</label><div class="val">${recon.dataIntegrityStatus === "gaps_present" ? "Verified, minor gaps" : "Verified, no gaps"}</div></div>
      </div>
    </section>

    <footer>
      <span>Generated by Sparks · ${(data.generatedAt || new Date()).toLocaleString("en-ZA", { timeZone: tz })}</span>
      <span>Meter ${meter.serialNumber} · ${recon.status === "final" ? "Final" : "Draft"}</span>
    </footer>

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
