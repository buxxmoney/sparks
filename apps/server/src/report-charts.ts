/**
 * Server-rendered SVG charts for the Sparks energy statement (reports.ts).
 *
 * These are PURE string builders — no DOM, no client JS — so they render inside the
 * Playwright→PDF pipeline exactly as authored. They mirror the approved design mockup:
 * daily-usage bars, a daily peak-demand line, a period-over-period cost/rate chart, and
 * recorded-vs-quoted grouped bars. Every chart degrades to a quiet placeholder when it
 * has no data (a brand-new site with one period, or a bill check with no interval data).
 *
 * Palette is hard-coded to the report's tokens (CSS variables aren't available to an
 * SVG string): brand green, amber for "quoted higher than usage supports", green-grey
 * neutrals and a faint grid.
 */

const C = {
  brand: "#15803d",
  brandSoft: "#e7f4ec",
  amber: "#b45309",
  grid: "#eef3ef",
  muted: "#6b756f",
  ink2: "#3b4640",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A clean axis: round the max up to a tidy value and return evenly spaced gridline stops. */
function niceScale(maxVal: number, ticks = 4): { max: number; steps: number[] } {
  if (!Number.isFinite(maxVal) || maxVal <= 0) return { max: 1, steps: [0, 1] };
  const rawStep = maxVal / ticks;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = niceNorm * mag;
  const max = Math.ceil(maxVal / step) * step;
  const steps: number[] = [];
  for (let v = 0; v <= max + step * 1e-6; v += step) steps.push(Math.round(v * 1e6) / 1e6);
  return { max, steps };
}

function randAxis(v: number): string {
  if (v === 0) return "R0";
  return v >= 1000 ? `R${+(v / 1000).toFixed(1)}k` : `R${v}`;
}

/** Show at most ~10 x-axis labels so day ticks never collide. */
function labelStride(n: number): number {
  return Math.max(1, Math.ceil(n / 10));
}

function placeholder(vb: string, msg: string): string {
  const [, , w, h] = vb.split(" ").map(Number);
  return `<svg class="chart" viewBox="${vb}" role="img" aria-label="${esc(msg)}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${w}" height="${h}" fill="none"/>
    <text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-size="13" fill="${C.muted}">${esc(msg)}</text>
  </svg>`;
}

export interface DailyPoint {
  label: string;
  value: number;
}

/** Bars of recorded energy per day. `closedBelow` renders unusually low days as faint bars. */
export function dailyUsageBars(data: DailyPoint[], closedBelow = 0): string {
  const vb = "0 0 820 248";
  if (data.length === 0) return placeholder(vb, "No interval data recorded for this period.");
  const W = 820, H = 248, padL = 46, padR = 12, padT = 30, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const { max, steps } = niceScale(Math.max(...data.map((d) => d.value)));
  const bw = plotW / data.length;
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const stride = labelStride(data.length);

  let s = "";
  for (const g of steps) {
    s += `<line x1="${padL}" x2="${W - padR}" y1="${y(g).toFixed(1)}" y2="${y(g).toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`;
    s += `<text x="${padL - 8}" y="${(y(g) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${C.muted}">${g}</text>`;
  }
  s += `<text x="${padL - 8}" y="12" text-anchor="end" font-size="9.5" fill="${C.muted}">kWh</text>`;
  data.forEach((p, i) => {
    const x = padL + i * bw + 2;
    const barW = Math.max(3, bw - 4);
    const closed = closedBelow > 0 && p.value <= closedBelow;
    s += `<rect x="${x.toFixed(1)}" y="${y(p.value).toFixed(1)}" width="${barW.toFixed(1)}" height="${(padT + plotH - y(p.value)).toFixed(1)}" rx="2" fill="${closed ? C.brandSoft : C.brand}" ${closed ? "" : 'opacity="0.92"'}/>`;
    if (i % stride === 0)
      s += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="9.5" fill="${C.muted}">${esc(p.label)}</text>`;
  });
  return `<svg class="chart" viewBox="${vb}" role="img" aria-label="Daily electricity use in kilowatt-hours" xmlns="http://www.w3.org/2000/svg">${s}</svg>`;
}

/** A daily peak-demand line with area fill and the month peak marked. */
export function demandProfileLine(data: DailyPoint[], peakValue: number): string {
  const vb = "0 0 820 248";
  if (data.length === 0) return placeholder(vb, "No demand data recorded for this period.");
  const W = 820, H = 248, padL = 46, padR = 14, padT = 30, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const { max, steps } = niceScale(Math.max(peakValue, ...data.map((d) => d.value)));
  const n = data.length;
  const step = n > 1 ? plotW / (n - 1) : 0;
  const x = (i: number) => padL + i * step;
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const peakI = data.reduce((best, d, i) => (d.value > data[best].value ? i : best), 0);
  const stride = labelStride(n);

  let s = "";
  for (const g of steps) {
    s += `<line x1="${padL}" x2="${W - padR}" y1="${y(g).toFixed(1)}" y2="${y(g).toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`;
    s += `<text x="${padL - 8}" y="${(y(g) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${C.muted}">${g}</text>`;
  }
  s += `<text x="${padL - 8}" y="12" text-anchor="end" font-size="9.5" fill="${C.muted}">kVA</text>`;
  const line = data.map((p, i) => `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L ${x(n - 1).toFixed(1)} ${padT + plotH} L ${x(0).toFixed(1)} ${padT + plotH} Z`;
  s += `<path d="${area}" fill="${C.brand}" opacity="0.08"/>`;
  s += `<path d="${line}" fill="none" stroke="${C.brand}" stroke-width="2" stroke-linejoin="round"/>`;
  data.forEach((p, i) => {
    if (i % stride === 0)
      s += `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="9.5" fill="${C.muted}">${esc(p.label)}</text>`;
  });
  const px = x(peakI), py = y(data[peakI].value);
  s += `<line x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${py.toFixed(1)}" y2="${padT}" stroke="${C.amber}" stroke-width="1" stroke-dasharray="3 3" opacity="0.6"/>`;
  s += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4" fill="${C.amber}"/>`;
  const lx = Math.max(70, Math.min(px, W - 90));
  s += `<text x="${lx.toFixed(1)}" y="12" text-anchor="middle" font-size="11" font-weight="600" fill="${C.amber}">${data[peakI].value.toFixed(1)} kVA peak</text>`;
  return `<svg class="chart" viewBox="${vb}" role="img" aria-label="Daily peak demand in kVA" xmlns="http://www.w3.org/2000/svg">${s}</svg>`;
}

export interface PeriodPoint {
  label: string;
  chargedRand: number;
  effRateCents: number;
}

/** Period-over-period: cost bars (left axis) + effective-rate line (right axis). */
export function periodTrendChart(periods: PeriodPoint[]): string {
  const vb = "0 0 820 258";
  if (periods.length === 0) return placeholder(vb, "No billing history yet — this fills in each period.");
  const W = 820, H = 258, padL = 54, padR = 54, padT = 30, padB = 30;
  const n = periods.length, plotW = W - padL - padR, plotH = H - padT - padB;
  const { max: costMax, steps } = niceScale(Math.max(...periods.map((p) => p.chargedRand)));
  const rates = periods.map((p) => p.effRateCents);
  let rMin = Math.min(...rates), rMax = Math.max(...rates);
  if (rMax - rMin < 4) { rMin -= 2; rMax += 2; } // don't let a flat rate look like noise
  const bw = plotW / n;
  const yc = (v: number) => padT + plotH - (v / costMax) * plotH;
  const yr = (v: number) => padT + plotH - ((v - rMin) / (rMax - rMin)) * plotH;

  let s = "";
  for (const g of steps) {
    s += `<line x1="${padL}" x2="${W - padR}" y1="${yc(g).toFixed(1)}" y2="${yc(g).toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`;
    s += `<text x="${padL - 8}" y="${(yc(g) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${C.muted}">${randAxis(g)}</text>`;
  }
  s += `<text x="${padL - 8}" y="12" text-anchor="end" font-size="9.5" fill="${C.brand}">Rand</text>`;
  s += `<text x="${W - padR + 8}" y="12" text-anchor="start" font-size="9.5" fill="${C.amber}">c/kWh</text>`;
  periods.forEach((p, i) => {
    const bx = padL + i * bw + bw * 0.24, w = bw * 0.52;
    const last = i === n - 1;
    s += `<rect x="${bx.toFixed(1)}" y="${yc(p.chargedRand).toFixed(1)}" width="${w.toFixed(1)}" height="${(padT + plotH - yc(p.chargedRand)).toFixed(1)}" rx="3" fill="${C.brand}" ${last ? "" : 'opacity="0.82"'}/>`;
    s += `<text x="${(padL + i * bw + bw / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="11" fill="${last ? C.brand : C.muted}" ${last ? 'font-weight="600"' : ""}>${esc(p.label)}</text>`;
  });
  const rline = periods.map((p, i) => `${i ? "L" : "M"} ${(padL + i * bw + bw / 2).toFixed(1)} ${yr(p.effRateCents).toFixed(1)}`).join(" ");
  s += `<path d="${rline}" fill="none" stroke="${C.amber}" stroke-width="2"/>`;
  periods.forEach((p, i) => {
    s += `<circle cx="${(padL + i * bw + bw / 2).toFixed(1)}" cy="${yr(p.effRateCents).toFixed(1)}" r="3" fill="${C.amber}"/>`;
  });
  [rMin, (rMin + rMax) / 2, rMax].forEach((g) => {
    s += `<text x="${W - padR + 8}" y="${(yr(g) + 3).toFixed(1)}" text-anchor="start" font-size="10" fill="${C.muted}">${g.toFixed(0)}</text>`;
  });
  return `<svg class="chart" viewBox="${vb}" role="img" aria-label="Cost and effective rate across recent periods" xmlns="http://www.w3.org/2000/svg">${s}</svg>`;
}

export interface ReconComponent {
  label: string;
  supportsRand: number;
  quotedRand: number;
}

/** Grouped bars: what your usage supports (green) vs what you were quoted (amber), per charge. */
export function reconComponentsBars(components: ReconComponent[]): string {
  const vb = "0 0 820 252";
  if (components.length === 0) return placeholder(vb, "No itemised charges to compare for this period.");
  const W = 820, H = 252, padL = 52, padR = 14, padT = 26, padB = 30;
  const n = components.length, plotW = W - padL - padR, plotH = H - padT - padB, gw = plotW / n;
  const { max, steps } = niceScale(Math.max(1, ...components.flatMap((c) => [c.supportsRand, c.quotedRand])));
  const y = (v: number) => padT + plotH - (v / max) * plotH;

  let s = `<text x="${padL - 8}" y="12" text-anchor="end" font-size="9.5" fill="${C.muted}">Rand</text>`;
  for (const g of steps) {
    s += `<line x1="${padL}" x2="${W - padR}" y1="${y(g).toFixed(1)}" y2="${y(g).toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`;
    s += `<text x="${padL - 8}" y="${(y(g) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${C.muted}">${randAxis(g)}</text>`;
  }
  components.forEach((c, i) => {
    const cx = padL + i * gw, w = gw * 0.28, gap = gw * 0.06;
    const x1 = cx + gw / 2 - w - gap / 2, x2 = cx + gw / 2 + gap / 2;
    s += `<rect x="${x1.toFixed(1)}" y="${y(c.supportsRand).toFixed(1)}" width="${w.toFixed(1)}" height="${(padT + plotH - y(c.supportsRand)).toFixed(1)}" rx="3" fill="${C.brand}" opacity="0.9"/>`;
    s += `<rect x="${x2.toFixed(1)}" y="${y(c.quotedRand).toFixed(1)}" width="${w.toFixed(1)}" height="${(padT + plotH - y(c.quotedRand)).toFixed(1)}" rx="3" fill="${C.amber}" opacity="0.9"/>`;
    s += `<text x="${(cx + gw / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="11.5" fill="${C.ink2}">${esc(c.label)}</text>`;
    if (c.quotedRand > c.supportsRand) {
      const diff = Math.round(c.quotedRand - c.supportsRand);
      s += `<text x="${(x2 + w / 2).toFixed(1)}" y="${(y(c.quotedRand) - 6).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="600" fill="${C.amber}">+R${diff}</text>`;
    }
  });
  return `<svg class="chart" viewBox="${vb}" role="img" aria-label="Recorded versus quoted by charge component" xmlns="http://www.w3.org/2000/svg">${s}</svg>`;
}
