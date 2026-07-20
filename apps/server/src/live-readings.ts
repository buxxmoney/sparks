/**
 * Dashboard aggregations sourced DIRECTLY from the raw `readings` table — the table the
 * Pi formats and writes its meter dump into. We deliberately do NOT reshape that table;
 * instead the site-facing endpoints aggregate it on read.
 *
 * The raw row carries, per sample (`measured_at`):
 *   - CUMULATIVE energy registers: `energy_import_kwh`, `energy_import_kvarh` (ever-increasing).
 *   - INSTANTANEOUS power: `power_total` (WATTS), `va_total` (VA).
 *
 * From those:
 *   - energy over a window = the DELTA of a cumulative register (last − first). A register
 *     that goes backwards (meter reset / rollover) clamps to 0 rather than a negative.
 *   - demand over a clock-aligned interval = the AVERAGE instantaneous power in that interval.
 *
 * These helpers are PURE so they can be unit-tested without the raw table, which only
 * exists in production (local/test databases still carry the app's older derived-reading
 * shape). The DB layer in routers.ts fetches raw rows and delegates the math here.
 */

/** One raw sample, already coerced from the pg row (numeric → number, timestamp → Date). */
export interface RawReadingRow {
  meterId: string;
  measuredAt: Date;
  energyImportKwh: number | null;
  energyImportKvarh: number | null;
  /** Cumulative apparent-energy register (kVAh) — drives interval demand (kVA) for billing. */
  apparentEnergyKvah: number | null;
  /** Instantaneous active power, in WATTS (device native). */
  powerTotalW: number | null;
  /** Instantaneous apparent power, in VA (device native). */
  vaTotal: number | null;
}

/** Shape returned to the chart for each clock-aligned interval. Numeric fields are strings
 * (or null) to match the prior demand_intervals-backed contract the UI already parses. */
export interface IntervalRow {
  intervalStart: string;
  intervalMinutes: number;
  activeEnergyKwh: string | null;
  reactiveEnergyKvarh: string | null;
  avgDemandKw: string | null;
  avgDemandKva: string | null;
  isComplete: boolean;
}

function num(v: number | null | undefined): number | null {
  return v === null || v === undefined || Number.isNaN(v) ? null : v;
}

/** Tolerance for snapping an interval boundary to its on-the-boundary sample. Meters timestamp
 * a :00/:30 sample a millisecond or two after the exact boundary; this window (≫ that jitter,
 * ≪ the ~1-minute sampling cadence) captures it without ever reaching the next real sample. */
const BOUNDARY_SNAP_MS = 5_000;

/** Max distance from an interval boundary to the nearest reading for that boundary's register to
 * be trusted. Demand needs only the register at each boundary, so an interval is trustworthy when
 * a reading sits within this window of BOTH boundaries — how densely the MIDDLE was sampled is
 * irrelevant. A dropout that swallows a boundary (nearest reading further than this) is the only
 * thing that makes an interval's demand unreliable. */
const NEAR_BOUNDARY_MS = 4 * 60_000;

/**
 * Energy consumed across a set of time-ordered samples = (last register − first register),
 * clamped at 0. Samples MUST be passed oldest→newest (the SQL fetch orders by measured_at).
 * A backwards delta (meter reset / register rollover) clamps to 0 rather than a negative or
 * a spurious max−min spread. null when no sample carries the field.
 */
export function registerDelta(
  samples: RawReadingRow[],
  pick: (r: RawReadingRow) => number | null,
): number | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const s of samples) {
    const v = num(pick(s));
    if (v === null) continue;
    if (first === null) first = v;
    last = v;
  }
  if (first === null || last === null) return null;
  const d = last - first;
  return d < 0 ? 0 : d;
}


/**
 * Total active/reactive energy across a set of raw samples: per meter, the register
 * delta over the whole set, then summed across meters. Used for month-to-date and
 * per-billing-period totals.
 */
export function windowEnergy(rows: RawReadingRow[]): {
  activeEnergyKwh: string;
  reactiveEnergyKvarh: string;
} {
  const byMeter = new Map<string, RawReadingRow[]>();
  for (const r of rows) {
    const arr = byMeter.get(r.meterId);
    if (arr) arr.push(r);
    else byMeter.set(r.meterId, [r]);
  }
  let active = 0;
  let reactive = 0;
  for (const samples of byMeter.values()) {
    active += registerDelta(samples, (s) => s.energyImportKwh) ?? 0;
    reactive += registerDelta(samples, (s) => s.energyImportKvarh) ?? 0;
  }
  return { activeEnergyKwh: active.toFixed(3), reactiveEnergyKvarh: reactive.toFixed(3) };
}

/** One energy bucket for the "energy across periods" chart. Numeric fields are strings. */
export interface EnergyBucket {
  label: string;
  periodStart: string;
  periodEnd: string;
  activeEnergyKwh: string;
  reactiveEnergyKvarh: string;
}

// Local calendar day/month of a UTC instant in an IANA timezone.
function zonedParts(d: Date, tz: string): { y: number; mo: number; day: number } {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return { y: get("year"), mo: get("month"), day: get("day") };
}

// Milliseconds that `tz` is ahead of UTC at instant `d`.
function tzOffsetMs(d: Date, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - d.getTime();
}

// The UTC instant of local midnight (00:00 in `tz`) for calendar date y-mo-day. Day/month
// arithmetic overflows are normalised by Date.UTC (e.g. day+7, month+1).
function zonedMidnightUtc(y: number, mo: number, day: number, tz: string): Date {
  const guess = new Date(Date.UTC(y, mo - 1, day));
  return new Date(guess.getTime() - tzOffsetMs(guess, tz));
}

/**
 * Bucket raw samples by calendar day, week (Monday-start), or month, oldest→newest — each
 * bucket's energy = the per-meter register delta within it (via windowEnergy). Grouping is in
 * the SITE's timezone `tz` (pass "UTC" for UTC days), so a "daily" bar covers local midnight→
 * midnight, not a UTC day offset from it. PURE.
 */
export function bucketEnergyByCalendar(
  rows: RawReadingRow[],
  unit: "day" | "week" | "month",
  tz: string,
): EnergyBucket[] {
  // The UTC instant of the local bucket start containing `d`.
  const bucketStart = (d: Date): Date => {
    const { y, mo, day } = zonedParts(d, tz);
    if (unit === "month") return zonedMidnightUtc(y, mo, 1, tz);
    if (unit === "week") {
      // Monday of the local week (calendar-only day-of-week from the local date).
      const dow = new Date(Date.UTC(y, mo - 1, day)).getUTCDay(); // 0=Sun … 6=Sat
      const sinceMonday = (dow + 6) % 7;
      return zonedMidnightUtc(y, mo, day - sinceMonday, tz);
    }
    return zonedMidnightUtc(y, mo, day, tz);
  };

  const groups = new Map<number, RawReadingRow[]>(); // key = bucket-start epoch ms
  for (const r of rows) {
    const key = bucketStart(r.measuredAt).getTime();
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }

  return [...groups.entries()]
    .sort((a, z) => a[0] - z[0])
    .map(([key, group]) => {
      const start = new Date(key);
      const sp = zonedParts(start, tz);
      const end =
        unit === "month"
          ? zonedMidnightUtc(sp.y, sp.mo + 1, 1, tz)
          : unit === "week"
            ? zonedMidnightUtc(sp.y, sp.mo, sp.day + 7, tz)
            : zonedMidnightUtc(sp.y, sp.mo, sp.day + 1, tz);
      const energy = windowEnergy(group);
      const label =
        unit === "month"
          ? start.toLocaleDateString("en-ZA", { month: "short", year: "2-digit", timeZone: tz })
          : start.toLocaleDateString("en-ZA", { day: "numeric", month: "short", timeZone: tz });
      return {
        label,
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
        activeEnergyKwh: energy.activeEnergyKwh,
        reactiveEnergyKvarh: energy.reactiveEnergyKvarh,
      };
    });
}

/**
 * Peak demand (kVA) over a window: the highest clock-aligned interval-average of apparent
 * power across the site. Demand charges bill the peak *interval average*, never an
 * instantaneous spike — so this must match what billing/reconciliation charges, and it
 * computes demand the SAME way `deriveMeterIntervals` does: per meter, apparent-energy
 * register Δ over each clock-aligned interval ÷ interval-hours, summed across meters.
 *
 * Two things this deliberately does NOT do, which the old instantaneous-`va_total` mean got
 * wrong:
 *   - It never averages momentary VA snapshots (those spike above any true interval average).
 *   - It ignores INCOMPLETE intervals — a data gap (a few samples straddling a big register
 *     jump) yields a bogus sky-high demand, so an interval only counts when every meter has
 *     a full sample count for it. If no interval is complete, peak is "0.000".
 */
export function peakDemandKva(rows: RawReadingRow[], intervalMinutes: number): string {
  // Group raw samples by meter, then derive each meter's energy-based clock-aligned intervals.
  const byMeter = new Map<string, RawReadingRow[]>();
  for (const r of rows) {
    const arr = byMeter.get(r.meterId);
    if (arr) arr.push(r);
    else byMeter.set(r.meterId, [r]);
  }

  // intervalStart(ms) → summed kVA across meters + whether EVERY meter's interval is complete.
  const site = new Map<number, { kva: number; complete: boolean }>();
  for (const samples of byMeter.values()) {
    for (const iv of deriveMeterIntervals(samples, intervalMinutes)) {
      const key = iv.intervalStart.getTime();
      const prev = site.get(key) ?? { kva: 0, complete: true };
      prev.kva += Number(iv.avgDemandKva);
      prev.complete = prev.complete && iv.isComplete;
      site.set(key, prev);
    }
  }

  let peak = 0;
  for (const v of site.values()) {
    if (v.complete && v.kva > peak) peak = v.kva;
  }
  return peak.toFixed(3);
}

/**
 * Bucket raw samples into clock-aligned intervals (oldest→newest) for the load chart's
 * "average demand per interval" series. Demand and energy are derived the SAME way billing and
 * peak demand are — per meter via `deriveMeterIntervals` (energy-register Δ over the interval,
 * boundary-snapped, ÷ interval-hours), then summed across meters — so the chart, the peak tile,
 * and the bill all agree. A metric is null when NO sample in the interval carried its register
 * (so the chart can gap rather than plot a false 0); `isComplete` is the real completeness flag.
 */
export function bucketIntervals(rows: RawReadingRow[], intervalMinutes: number): IntervalRow[] {
  const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;

  // Per clock-aligned interval-start: which register fields any sample carried (gap-vs-0).
  const present = new Map<number, { kwh: boolean; kvarh: boolean; kvah: boolean }>();
  for (const r of rows) {
    const key = Math.floor(r.measuredAt.getTime() / intervalMs) * intervalMs;
    const p = present.get(key) ?? { kwh: false, kvarh: false, kvah: false };
    if (r.energyImportKwh !== null) p.kwh = true;
    if (r.energyImportKvarh !== null) p.kvarh = true;
    if (r.apparentEnergyKvah !== null) p.kvah = true;
    present.set(key, p);
  }

  // Group by meter, derive each meter's energy-based intervals, sum across meters per interval.
  const byMeter = new Map<string, RawReadingRow[]>();
  for (const r of rows) {
    const arr = byMeter.get(r.meterId);
    if (arr) arr.push(r);
    else byMeter.set(r.meterId, [r]);
  }
  const agg = new Map<
    number,
    { active: number; reactive: number; kw: number; kva: number; complete: boolean }
  >();
  for (const samples of byMeter.values()) {
    for (const iv of deriveMeterIntervals(samples, intervalMinutes)) {
      const key = iv.intervalStart.getTime();
      const a = agg.get(key) ?? { active: 0, reactive: 0, kw: 0, kva: 0, complete: true };
      a.active += Number(iv.activeEnergyKwh);
      a.reactive += Number(iv.reactiveEnergyKvarh);
      a.kw += Number(iv.avgDemandKw);
      a.kva += Number(iv.avgDemandKva);
      a.complete = a.complete && iv.isComplete;
      agg.set(key, a);
    }
  }

  return [...agg.entries()]
    .sort((x, z) => x[0] - z[0])
    .map(([start, a]) => {
      const p = present.get(start) ?? { kwh: false, kvarh: false, kvah: false };
      return {
        intervalStart: new Date(start).toISOString(),
        intervalMinutes,
        activeEnergyKwh: p.kwh ? a.active.toFixed(3) : null,
        reactiveEnergyKvarh: p.kvarh ? a.reactive.toFixed(3) : null,
        avgDemandKw: p.kwh ? a.kw.toFixed(3) : null,
        avgDemandKva: p.kvah ? a.kva.toFixed(3) : null,
        isComplete: a.complete,
      };
    });
}

/** A per-meter clock-aligned interval derived from raw readings, for BILLING/reconciliation.
 * Boundary-correct (register-at-boundary) so per-interval energies telescope to the true
 * total — matching workers.aggregateDemandIntervals, but sourced from the raw `readings`
 * table. Numeric fields are strings for the demand_intervals columns they upsert into. */
export interface DerivedMeterInterval {
  intervalStart: Date;
  intervalMinutes: number;
  activeEnergyKwh: string;
  reactiveEnergyKvarh: string;
  apparentEnergyKvah: string;
  avgDemandKw: string;
  avgDemandKva: string;
  sampleCount: number;
  expectedSamples: number;
  isComplete: boolean;
}

type EnergyRegister = "energyImportKwh" | "energyImportKvarh" | "apparentEnergyKvah";

/**
 * Derive one meter's clock-aligned demand intervals from its raw samples, for billing. PURE.
 *
 * Interval energy = the cumulative register at the interval END boundary minus the value at its
 * START boundary, where each boundary register is snapped to its on-the-boundary sample with a
 * small tolerance (see `boundaryRegister`) — capturing the :00/:30 reading even though meters
 * timestamp it a millisecond or two late, so demand is not under-read at every boundary. Σ
 * interval deltas telescopes across covered buckets, conserving energy; a backwards delta
 * (register rollover / meter reset) clamps to 0. Demand = energy / interval-hours. Emits only
 * intervals whose own bucket has ≥1 sample; an interval is `isComplete` only when a reading sits
 * near BOTH boundaries (the two register values the demand needs) — middle sampling density is
 * irrelevant, so a mid-interval dropout does NOT gap it; only a boundary-swallowing gap does.
 */
export function deriveMeterIntervals(
  rows: RawReadingRow[],
  intervalMinutes: number,
): DerivedMeterInterval[] {
  if (rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
  const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;

  const firstMs = sorted[0].measuredAt.getTime();
  const lastMs = sorted[sorted.length - 1].measuredAt.getTime();
  const startMs = Math.floor(firstMs / intervalMs) * intervalMs; // clock-aligned

  const earliest = (field: EnergyRegister): number | null => {
    for (const r of sorted) {
      const v = num(r[field]);
      if (v !== null) return v;
    }
    return null;
  };
  const registerAtOrBefore = (field: EnergyRegister, t: number): number | null => {
    let val: number | null = null;
    for (const r of sorted) {
      if (r.measuredAt.getTime() > t) break;
      const v = num(r[field]);
      if (v !== null) val = v;
    }
    return val ?? earliest(field);
  };
  // Register snapshot AT a clock boundary. Meters timestamp their on-the-half-hour samples a
  // millisecond or two LATE (e.g. 10:30:00.001), so anchoring strictly on the last reading
  // ≤ the exact boundary would skip that boundary sample and grab the one ~a minute earlier —
  // under-reading every interval's demand. We therefore snap with a small tolerance: the last
  // reading at or before (boundary + BOUNDARY_SNAP_MS). The tolerance is far larger than the
  // sub-second jitter yet far smaller than the sampling cadence, so it never reaches into the
  // next real sample (which keeps a mid-next-bucket reset/rollover out of this interval).
  const boundaryRegister = (field: EnergyRegister, t: number): number | null =>
    registerAtOrBefore(field, t + BOUNDARY_SNAP_MS);
  const intervalEnergy = (field: EnergyRegister, s: number, e: number): number => {
    const a = boundaryRegister(field, s);
    const b = boundaryRegister(field, e);
    if (a === null || b === null) return 0;
    const d = b - a;
    return d < 0 ? 0 : d;
  };

  // Sample count per clock-aligned bucket (informational only).
  const bucketCount = new Map<number, number>();
  for (const r of sorted) {
    const b = Math.floor(r.measuredAt.getTime() / intervalMs) * intervalMs;
    bucketCount.set(b, (bucketCount.get(b) ?? 0) + 1);
  }
  // Is there a reading within NEAR_BOUNDARY_MS of clock time `t`? (times ascending)
  const times = sorted.map((r) => r.measuredAt.getTime());
  const hasReadingNear = (t: number): boolean => {
    for (const rt of times) {
      if (rt < t - NEAR_BOUNDARY_MS) continue;
      return rt <= t + NEAR_BOUNDARY_MS;
    }
    return false;
  };
  const hours = intervalMinutes / 60;
  const expectedSamples = Math.ceil((intervalMinutes * 60) / 60);

  const out: DerivedMeterInterval[] = [];
  for (let s = startMs; s <= lastMs; s += intervalMs) {
    const e = s + intervalMs;
    const sampleCount = bucketCount.get(s) ?? 0;
    if (sampleCount === 0) continue;

    const active = intervalEnergy("energyImportKwh", s, e);
    const reactive = intervalEnergy("energyImportKvarh", s, e);
    const apparent = intervalEnergy("apparentEnergyKvah", s, e);
    out.push({
      intervalStart: new Date(s),
      intervalMinutes,
      activeEnergyKwh: active.toFixed(3),
      reactiveEnergyKvarh: reactive.toFixed(3),
      apparentEnergyKvah: apparent.toFixed(3),
      avgDemandKw: (active / hours).toFixed(3),
      avgDemandKva: (apparent / hours).toFixed(3),
      sampleCount,
      expectedSamples,
      // Demand = register at START boundary vs END boundary, so it's trustworthy whenever a
      // reading sits near BOTH boundaries — regardless of middle sampling density. It's only
      // unreliable when a dropout swallows a boundary (no reading near it), e.g. the interval
      // straddling a 55-min gap whose boundary register is guessed from a far-away sample.
      isComplete: hasReadingNear(s) && hasReadingNear(e),
    });
  }
  return out;
}
