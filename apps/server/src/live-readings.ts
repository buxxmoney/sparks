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

import { type SQL, sql } from "drizzle-orm";

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

/**
 * Collapse a site's raw samples into the per-interval usage the tariff pricer needs.
 * PURE.
 *
 * Per meter, derive boundary-correct clock-aligned intervals (the same
 * `deriveMeterIntervals` billing uses), then sum across meters per interval so the
 * site is priced as one supply point. The result carries per-interval energy AND the
 * interval start instants, so `priceUsage` can attribute each interval to its
 * time-of-use band and season rather than pricing a single undifferentiated total.
 *
 * Two deliberate choices, both matching how the bill check prices the same period:
 *   - Peak demand counts only `isComplete` intervals. An interval whose boundary was
 *     swallowed by a dropout yields a bogus sky-high kVA, and demand charges bill the
 *     single highest interval — so one bad interval would dominate the whole estimate.
 *   - Energy is summed across ALL intervals (complete or not). Register deltas
 *     telescope, so an incomplete interval's energy is still real energy; only its
 *     *demand* is untrustworthy.
 */
export function usageFromRawReadings(
  rows: RawReadingRow[],
  intervalMinutes: number,
): {
  activeKwh: number;
  reactiveKvarh: number;
  maxDemandKva: number;
  intervalStarts: Date[];
  intervalActiveKwh: number[];
  /** Intervals contributing energy — 0 means the period has no metered data at all. */
  intervalCount: number;
} {
  const byMeter = new Map<string, RawReadingRow[]>();
  for (const r of rows) {
    const arr = byMeter.get(r.meterId);
    if (arr) arr.push(r);
    else byMeter.set(r.meterId, [r]);
  }

  // intervalStart(ms) → site-wide totals for that interval.
  const agg = new Map<number, { active: number; reactive: number; kva: number; complete: boolean }>();
  for (const samples of byMeter.values()) {
    for (const iv of deriveMeterIntervals(samples, intervalMinutes)) {
      const key = iv.intervalStart.getTime();
      const a = agg.get(key) ?? { active: 0, reactive: 0, kva: 0, complete: true };
      a.active += Number(iv.activeEnergyKwh);
      a.reactive += Number(iv.reactiveEnergyKvarh);
      a.kva += Number(iv.avgDemandKva);
      a.complete = a.complete && iv.isComplete;
      agg.set(key, a);
    }
  }

  const ordered = [...agg.entries()].sort((a, z) => a[0] - z[0]);
  const intervalStarts: Date[] = [];
  const intervalActiveKwh: number[] = [];
  let activeKwh = 0;
  let reactiveKvarh = 0;
  let maxDemandKva = 0;
  for (const [start, a] of ordered) {
    intervalStarts.push(new Date(start));
    intervalActiveKwh.push(a.active);
    activeKwh += a.active;
    reactiveKvarh += a.reactive;
    if (a.complete && a.kva > maxDemandKva) maxDemandKva = a.kva;
  }

  return {
    activeKwh,
    reactiveKvarh,
    maxDemandKva,
    intervalStarts,
    intervalActiveKwh,
    intervalCount: ordered.length,
  };
}

/* ─────────────── Interval usage, derived in Postgres ─────────────── */

/**
 * `deriveMeterIntervals`, executed inside Postgres.
 *
 * Why. Pricing a period needs per-interval energy (for season / time-of-use
 * attribution) and the peak interval demand. Deriving those in the app means
 * shipping every raw sample to it first — ~30 000 rows for a month of 1/min
 * metering. Postgres finds those rows in ~0.2 s; moving them to the app took
 * 8-21 s. This query does the same derivation where the data is and returns one
 * row per INTERVAL (~1 400 for a month of half-hours), so the transfer is a few
 * dozen kilobytes instead of megabytes.
 *
 * It is a SELECT: nothing is materialised, so there is no table to keep fresh and
 * nothing that can go stale behind the live figure.
 *
 * Fidelity. The output must equal `usageFromRawReadings(rows, intervalMinutes)`
 * over the same window, to the last decimal — a bill that changes because of
 * where the arithmetic ran is a bug. Each rule below mirrors one in
 * `deriveMeterIntervals`:
 *   - Timestamps are truncated to milliseconds (`ms`), as the JS `Date` the app
 *     path sees is; otherwise a sample 5.0003 s past a boundary would snap
 *     differently in the two paths.
 *   - `snap` is the first boundary whose register snapshot includes the sample:
 *     the smallest n with ms <= n*L + BOUNDARY_SNAP_MS (the inclusive
 *     "at or before boundary + tolerance" rule).
 *   - A boundary's register is the last NON-NULL value at or before it, carried
 *     forward across empty boundaries, falling back to the window's earliest
 *     value when nothing precedes it.
 *   - Energy = end register − start register, clamped at 0 (reset / rollover),
 *     rounded to 3 dp PER METER before summing across meters.
 *   - An interval is emitted only when its own bucket holds a sample, and is
 *     complete only when a sample sits within NEAR_BOUNDARY_MS of BOTH edges.
 *
 * `to` is inclusive, matching `fetchRawReadings`' default.
 *
 * Shape. Everything is window functions over ONE per-meter timeline; the only
 * join is to `firsts`, which has a row per meter. That is deliberate. Postgres
 * has no row estimates for CTEs and guesses one row each, so an earlier version
 * that self-joined boundary snapshots got a nested loop that recomputed an
 * every-sample aggregate once per interval — 17 s for a month. The CTEs are
 * MATERIALIZED for the same reason: each is computed exactly once.
 */
export function siteIntervalsQuery(
  meterIds: string[],
  window: { from: Date; to: Date },
  intervalMinutes: number,
): SQL {
  const intervalMs = Math.max(1, intervalMinutes) * 60_000;
  const hours = intervalMinutes / 60;
  const ids = sql.join(
    meterIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const L = sql`${intervalMs}::bigint`;
  const near = sql`${NEAR_BOUNDARY_MS}::bigint`;
  return sql`
with r as materialized (
  select meter_id, measured_at as t,
         energy_import_kwh as k, energy_import_kvarh as q, energy_kvah as v,
         floor(extract(epoch from measured_at) * 1000)::bigint as ms
  from readings
  where meter_id in (${ids})
    and measured_at >= ${window.from} and measured_at <= ${window.to}
),
s as materialized (
  select r.*,
         ms / ${L} as bucket,
         (ms - ${BOUNDARY_SNAP_MS}::bigint + ${L} - 1) / ${L} as snap
  from r
),
firsts as materialized (
  select meter_id,
         (array_agg(k order by t) filter (where k is not null))[1] as k0,
         (array_agg(q order by t) filter (where q is not null))[1] as q0,
         (array_agg(v order by t) filter (where v is not null))[1] as v0
  from s group by meter_id
),
-- One timeline of boundary indexes per meter, carrying three kinds of fact:
-- the register snapshot taken at a boundary, the sample span of the bucket that
-- STARTS there, and a bare marker for each bucket's END boundary so that the row
-- after a bucket is always its own end (which is what lets lead() stand in for
-- a self-join below).
timeline as materialized (
  select meter_id, snap as n,
         (array_agg(k order by t desc) filter (where k is not null))[1] as k,
         (array_agg(q order by t desc) filter (where q is not null))[1] as q,
         (array_agg(v order by t desc) filter (where v is not null))[1] as v,
         null::bigint as first_ms, null::bigint as last_ms, false as has_samples
  from s group by meter_id, snap
  union all
  select meter_id, bucket, null, null, null, min(ms), max(ms), true
  from s group by meter_id, bucket
  union all
  select distinct meter_id, bucket + 1, null::numeric, null::numeric, null::numeric,
         null::bigint, null::bigint, false
  from s
),
line as (
  select meter_id, n, max(k) as k, max(q) as q, max(v) as v,
         max(first_ms) as first_ms, max(last_ms) as last_ms,
         bool_or(has_samples) as has_samples
  from timeline group by meter_id, n
),
runs as (
  select line.*,
         count(k) over w as gk, count(q) over w as gq, count(v) over w as gv,
         -- Nearest sample before this boundary / after this bucket. Sample times
         -- rise with n, so the running max / trailing min IS the nearest one.
         max(last_ms)  over (w rows between unbounded preceding and 1 preceding) as prev_last,
         min(first_ms) over (w rows between 1 following and unbounded following) as next_first
  from line
  window w as (partition by meter_id order by n)
),
carried as (
  select meter_id, n, has_samples, first_ms, last_ms, prev_last, next_first,
         first_value(k) over (partition by meter_id, gk order by n) as k,
         first_value(q) over (partition by meter_id, gq order by n) as q,
         first_value(v) over (partition by meter_id, gv order by n) as v
  from runs
),
edged as (
  select carried.*,
         lead(k) over w as k_end, lead(q) over w as q_end, lead(v) over w as v_end
  from carried
  window w as (partition by meter_id order by n)
),
per_meter as (
  select e.meter_id, e.n as bucket,
         round(greatest(coalesce(e.k_end, f.k0) - coalesce(e.k, f.k0), 0), 3) as kwh,
         round(greatest(coalesce(e.q_end, f.q0) - coalesce(e.q, f.q0), 0), 3) as kvarh,
         round(greatest(coalesce(e.v_end, f.v0) - coalesce(e.v, f.v0), 0) / ${hours}::numeric, 3) as kva,
         (e.first_ms <= e.n * ${L} + ${near}
            or coalesce(e.prev_last >= e.n * ${L} - ${near}, false))
         and
         (e.last_ms >= (e.n + 1) * ${L} - ${near}
            or coalesce(e.next_first <= (e.n + 1) * ${L} + ${near}, false)) as complete
  from edged e
  join firsts f on f.meter_id = e.meter_id
  where e.has_samples
)
select bucket * ${L} as start_ms,
       sum(kwh)   as active_kwh,
       sum(kvarh) as reactive_kvarh,
       sum(kva)   as kva,
       bool_and(complete) as complete
from per_meter
group by bucket
order by bucket`;
}

/** One row of {@link siteIntervalsQuery}, as the pg driver returns it. */
export interface SiteIntervalRow {
  start_ms: string | number;
  active_kwh: string | number | null;
  reactive_kvarh: string | number | null;
  kva: string | number | null;
  complete: boolean;
}

/**
 * Fold {@link siteIntervalsQuery} rows into the usage the pricer consumes — the
 * same shape, and the same rules, as {@link usageFromRawReadings}: energy sums
 * across every interval, peak demand counts only complete ones. PURE.
 */
export function usageFromIntervalRows(rows: SiteIntervalRow[]): ReturnType<
  typeof usageFromRawReadings
> {
  const intervalStarts: Date[] = [];
  const intervalActiveKwh: number[] = [];
  let activeKwh = 0;
  let reactiveKvarh = 0;
  let maxDemandKva = 0;
  for (const row of rows) {
    const active = Number(row.active_kwh ?? 0);
    const kva = Number(row.kva ?? 0);
    intervalStarts.push(new Date(Number(row.start_ms)));
    intervalActiveKwh.push(active);
    activeKwh += active;
    reactiveKvarh += Number(row.reactive_kvarh ?? 0);
    if (row.complete && kva > maxDemandKva) maxDemandKva = kva;
  }
  return {
    activeKwh,
    reactiveKvarh,
    maxDemandKva,
    intervalStarts,
    intervalActiveKwh,
    intervalCount: rows.length,
  };
}

/* ─────────────── Endpoint reads ─────────────── */

/*
 * A meter's energy registers are accumulators, so the energy used over any window
 * is two readings: the register at its end minus the register at its start.
 * Nothing in between is needed. The queries below fetch exactly those endpoints
 * with index seeks on (meter_id, measured_at) — a handful of rows per window,
 * however many samples the window holds.
 *
 * Only two things genuinely need more than endpoints, and neither is energy:
 * time-of-use pricing (which interval the energy fell in) and peak demand (the
 * single highest interval). Those use `siteIntervalsQuery` / `sitePeakDemandQuery`.
 */

function idValues(meterIds: string[]): SQL {
  return sql.join(
    meterIds.map((id) => sql`(${id}::uuid)`),
    sql`, `,
  );
}

/**
 * Energy for each of several windows, by endpoints: per meter, the last non-null
 * register in the window minus the first, clamped at 0 (reset / rollover), summed
 * across meters. This is `windowEnergy`'s rule, without the samples in between.
 *
 * `has_data` is false for a window with no reading at all, so a caller can tell
 * "used nothing" from "nothing recorded".
 */
export function windowEnergyQuery(
  meterIds: string[],
  windows: Array<{ from: Date; to: Date }>,
  opts: { endExclusive?: boolean } = {},
): SQL {
  const upper = (col: SQL) => (opts.endExclusive ? sql`${col} < w.t` : sql`${col} <= w.t`);
  const endpoint = (field: SQL, direction: SQL) => sql`
    left join lateral (
      select ${field} as v from readings r
      where r.meter_id = m.meter_id and r.measured_at >= w.f and ${upper(sql`r.measured_at`)}
        and ${field} is not null
      order by r.measured_at ${direction} limit 1
    )`;
  return sql`
with w(i, f, t) as (
  values ${sql.join(
    windows.map((w, i) => sql`(${i}::int, ${w.from}::timestamptz, ${w.to}::timestamptz)`),
    sql`, `,
  )}
),
m(meter_id) as (values ${idValues(meterIds)})
select w.i,
       coalesce(sum(greatest(kl.v - kf.v, 0)), 0) as active_kwh,
       coalesce(sum(greatest(ql.v - qf.v, 0)), 0) as reactive_kvarh,
       coalesce(bool_or(kf.v is not null or qf.v is not null), false) as has_data
from w cross join m
${endpoint(sql`r.energy_import_kwh`, sql`asc`)} kf on true
${endpoint(sql`r.energy_import_kwh`, sql`desc`)} kl on true
${endpoint(sql`r.energy_import_kvarh`, sql`asc`)} qf on true
${endpoint(sql`r.energy_import_kvarh`, sql`desc`)} ql on true
group by w.i
order by w.i`;
}

/** One row of {@link windowEnergyQuery}. */
export interface WindowEnergyRow {
  i: number;
  active_kwh: string | number;
  reactive_kvarh: string | number;
  has_data: boolean;
}

/**
 * Energy between consecutive BOUNDARIES of one window, by endpoints.
 *
 * `boundaries` are ascending instants from the window's start to its end; the
 * result has one row per gap between them (i = 0 … n-2). This is what pricing a
 * non-time-of-use tariff needs: the period cut at the few instants where the rate
 * can change (a season boundary, a tariff change), and the energy in each piece.
 *
 * A boundary's register is read exactly as `deriveMeterIntervals` reads one, so
 * the pieces sum to the same total the per-interval path produces:
 *   - the last reading at or before boundary + BOUNDARY_SNAP_MS (meters stamp the
 *     on-the-hour sample a millisecond late), never outside the window;
 *   - falling back to the window's earliest reading when nothing precedes it.
 * The one divergence is a register reset INSIDE a piece: this clamps the piece at
 * 0, where the interval path clamps only the interval containing the reset.
 */
export function boundaryEnergyQuery(
  meterIds: string[],
  window: { from: Date; to: Date },
  boundaries: Date[],
): SQL {
  // Timestamps are compared at millisecond precision in the interval path, so
  // "<= boundary + snap" there is "< boundary + snap + 1 ms" on exact timestamps.
  const snap = sql`${(BOUNDARY_SNAP_MS + 1) / 1000}::double precision`;
  const atBoundary = (field: SQL) => sql`
    left join lateral (
      select ${field} as v from readings r
      where r.meter_id = m.meter_id
        and r.measured_at >= ${window.from} and r.measured_at <= ${window.to}
        and r.measured_at < b.t + make_interval(secs => ${snap})
        and ${field} is not null
      order by r.measured_at desc limit 1
    )`;
  const earliest = (field: SQL) => sql`
    left join lateral (
      select ${field} as v from readings r
      where r.meter_id = m.meter_id
        and r.measured_at >= ${window.from} and r.measured_at <= ${window.to}
        and ${field} is not null
      order by r.measured_at asc limit 1
    )`;
  return sql`
with b(i, t) as (
  values ${sql.join(
    boundaries.map((t, i) => sql`(${i}::int, ${t}::timestamptz)`),
    sql`, `,
  )}
),
m(meter_id) as (values ${idValues(meterIds)}),
reg as (
  select b.i, m.meter_id,
         coalesce(k.v, k0.v) as k, coalesce(q.v, q0.v) as q,
         k0.v is not null or q0.v is not null as has_data
  from b cross join m
  ${atBoundary(sql`r.energy_import_kwh`)} k on true
  ${earliest(sql`r.energy_import_kwh`)} k0 on true
  ${atBoundary(sql`r.energy_import_kvarh`)} q on true
  ${earliest(sql`r.energy_import_kvarh`)} q0 on true
),
piece as (
  select i, meter_id, has_data,
         greatest(lead(k) over w - k, 0) as kwh,
         greatest(lead(q) over w - q, 0) as kvarh,
         lead(i) over w is not null as has_next
  from reg
  window w as (partition by meter_id order by i)
)
select i,
       coalesce(sum(kwh), 0)   as active_kwh,
       coalesce(sum(kvarh), 0) as reactive_kvarh,
       coalesce(bool_or(has_data), false) as has_data
from piece
where has_next
group by i
order by i`;
}

/**
 * Peak site demand over a window as ONE row: the highest complete interval from
 * {@link siteIntervalsQuery}, reduced inside Postgres. Demand is the one figure
 * endpoints cannot give — it is the largest single interval, so every interval
 * has to be looked at — but they never need to leave the database.
 */
export function sitePeakDemandQuery(
  meterIds: string[],
  window: { from: Date; to: Date },
  intervalMinutes: number,
): SQL {
  return sql`
select coalesce(max(kva) filter (where complete), 0) as peak_kva,
       count(*)::int as interval_count
from (${siteIntervalsQuery(meterIds, window, intervalMinutes)}) intervals`;
}

/**
 * The calendar buckets (day / Monday-start week / month, in the site's timezone)
 * from the one containing `from` up to the one containing `to` — the same buckets
 * `bucketEnergyByCalendar` groups samples into, enumerated without the samples.
 * The first is clipped to `from` so it covers only what was asked for.
 */
export function calendarWindows(
  from: Date,
  to: Date,
  unit: "day" | "week" | "month",
  tz: string,
): Array<{ from: Date; to: Date; periodStart: Date; periodEnd: Date; label: string }> {
  const first = zonedParts(from, tz);
  let start: Date;
  if (unit === "month") start = zonedMidnightUtc(first.y, first.mo, 1, tz);
  else if (unit === "week") {
    const dow = new Date(Date.UTC(first.y, first.mo - 1, first.day)).getUTCDay();
    start = zonedMidnightUtc(first.y, first.mo, first.day - ((dow + 6) % 7), tz);
  } else start = zonedMidnightUtc(first.y, first.mo, first.day, tz);

  const out: ReturnType<typeof calendarWindows> = [];
  while (start.getTime() <= to.getTime()) {
    const sp = zonedParts(start, tz);
    const end =
      unit === "month"
        ? zonedMidnightUtc(sp.y, sp.mo + 1, 1, tz)
        : unit === "week"
          ? zonedMidnightUtc(sp.y, sp.mo, sp.day + 7, tz)
          : zonedMidnightUtc(sp.y, sp.mo, sp.day + 1, tz);
    out.push({
      from: start.getTime() < from.getTime() ? from : start,
      to: end,
      periodStart: start,
      periodEnd: end,
      label:
        unit === "month"
          ? start.toLocaleDateString("en-ZA", { month: "short", year: "2-digit", timeZone: tz })
          : start.toLocaleDateString("en-ZA", { day: "numeric", month: "short", timeZone: tz }),
    });
    start = end;
  }
  return out;
}

/* ─────────────── Aggregate-in-SQL usage ─────────────── */

/**
 * Period usage computed in POSTGRES, not by shipping raw samples to the app.
 *
 * `usageFromRawReadings` needs every sample in the period — ~32 700 rows for a
 * month of 1/min metering on two meters. Postgres executes that query in ~50 ms
 * and then spends ~12 SECONDS serialising the result to the client. The work was
 * never the problem; the transfer was.
 *
 * Almost none of it is needed. Energy registers are cumulative (rules.md 1), so
 * a period's energy is `last − first`: two rows per meter. Only peak demand is
 * genuinely per-interval, and that reduces to a single `max()` server-side.
 *
 * Verified against the full-scan path on real data (93 640 readings): active and
 * reactive energy match to three decimals, because this differences the very same
 * register endpoints `deriveMeterIntervals` telescopes between.
 *
 * `intervalStarts` / `intervalActiveKwh` are NOT returned — the caller supplies
 * the season/TOU split separately (see `usageWindowsForPricing`), because a
 * single period-wide total cannot be attributed to a TOU band.
 */
export interface SqlUsageTotals {
  activeKwh: number;
  reactiveKvarh: number;
  maxDemandKva: number;
  intervalCount: number;
}

/**
 * SQL for {@link SqlUsageTotals}. Parameters: $1 site id, $2 window start,
 * $3 window end (exclusive).
 *
 * Energy: per meter, the last register in the window minus the first, summed
 * across meters. A negative delta is a meter reset or register rollover, never
 * negative usage (rules.md 1), so it clamps at 0.
 *
 * Demand: the maximum site-wide interval, read from the PRE-COMPUTED
 * `demand_intervals`. Deriving it from raw samples here would mean scanning them
 * again, which is the cost this exists to avoid. When the table has no rows for
 * the window the result is null and the caller falls back — see
 * `readingsBillToDate`.
 */
export const SQL_USAGE_TOTALS = `
with per_meter as (
  select
    r.meter_id,
    (array_agg(r.energy_import_kwh   order by r.measured_at asc ))[1] as k_first,
    (array_agg(r.energy_import_kwh   order by r.measured_at desc))[1] as k_last,
    (array_agg(r.energy_import_kvarh order by r.measured_at asc ))[1] as q_first,
    (array_agg(r.energy_import_kvarh order by r.measured_at desc))[1] as q_last,
    count(*) as samples
  from readings r
  join meters m on m.id = r.meter_id
  where m.site_id = $1 and r.measured_at >= $2 and r.measured_at < $3
  group by r.meter_id
),
energy as (
  select
    coalesce(sum(greatest(k_last - k_first, 0)), 0) as active_kwh,
    coalesce(sum(greatest(q_last - q_first, 0)), 0) as reactive_kvarh,
    coalesce(sum(samples), 0)                       as samples
  from per_meter
),
site_intervals as (
  select interval_start, sum(avg_demand_kva) as site_kva
  from demand_intervals
  where site_id = $1 and interval_start >= $2 and interval_start < $3
  group by interval_start
),
demand as (
  select max(site_kva) as max_demand_kva, count(*)::int as interval_count
  from site_intervals
)
select
  energy.active_kwh,
  energy.reactive_kvarh,
  energy.samples,
  demand.max_demand_kva,
  demand.interval_count
from energy, demand`;

/**
 * SQL that materialises `demand_intervals` for one site from the raw `readings`
 * the Pi pushes, entirely inside Postgres. Parameters: $1 site id, $2 window
 * start, $3 window end (exclusive), $4 interval minutes, $5 snap seconds,
 * $6 near-boundary milliseconds.
 *
 * Why this exists. `workers.aggregateDemandIntervals` is the app-side equivalent,
 * but it reads `readings.time` / `active_energy_kwh` — columns the deployed
 * firmware does not write (it writes `measured_at` / `energy_import_kwh`, and in
 * production those are the ONLY columns that exist). It also loads a meter's
 * entire history into memory. So on a direct-to-Neon site it cannot run, which is
 * why `demand_intervals` sits empty and every live read falls back to a full scan.
 *
 * Boundary handling matches `deriveMeterIntervals`, and that fidelity is the whole
 * point — an interval's energy is the register at its END boundary minus the
 * register at its START boundary, where a boundary snaps to the last sample at or
 * just after it. Meters timestamp an on-the-half-hour reading a few milliseconds
 * late (10:30:00.001), so anchoring strictly at or before the boundary would drop
 * that sample and under-read the interval. An earlier approximation that simply
 * took the last sample INSIDE each bucket understated peak demand by 0.3% — at
 * R461/kVA that is real money off a customer's bill.
 */
export const SQL_MATERIALIZE_INTERVALS = `
with snapped as (
  select
    r.meter_id,
    m.site_id,
    r.measured_at,
    r.energy_import_kwh   as k,
    r.energy_import_kvarh as q,
    r.energy_kvah         as v,
    to_timestamp(
      floor(extract(epoch from (r.measured_at - make_interval(secs => $5))) / ($4 * 60))
      * ($4 * 60)
    ) as bucket
  from readings r
  join meters m on m.id = r.meter_id
  where m.site_id = $1
    and r.measured_at >= ($2::timestamptz - make_interval(mins => $4))
    and r.measured_at <  $3
),
edges as (
  select
    meter_id, site_id, bucket,
    (array_agg(k           order by measured_at desc))[1] as k_end,
    (array_agg(q           order by measured_at desc))[1] as q_end,
    (array_agg(v           order by measured_at desc))[1] as v_end,
    (array_agg(measured_at order by measured_at asc ))[1] as first_at,
    (array_agg(measured_at order by measured_at desc))[1] as last_at,
    count(*)::int as n
  from snapped
  group by meter_id, site_id, bucket
),
deltas as (
  select
    meter_id, site_id, bucket, n, first_at, last_at,
    k_end - lag(k_end) over w as kwh,
    q_end - lag(q_end) over w as kvarh,
    v_end - lag(v_end) over w as kvah
  from edges
  window w as (partition by meter_id order by bucket)
)
insert into demand_intervals
  (meter_id, site_id, interval_start, interval_minutes, active_energy_kwh,
   reactive_energy_kvarh, avg_demand_kw, avg_demand_kva, sample_count,
   expected_samples, is_complete, source)
select
  meter_id, site_id, bucket, $4,
  round(greatest(kwh,   0)::numeric, 3),
  round(greatest(kvarh, 0)::numeric, 3),
  round((greatest(kwh,  0) / ($4 / 60.0))::numeric, 3),
  round((greatest(kvah, 0) / ($4 / 60.0))::numeric, 3),
  n,
  $4,
  (extract(epoch from (first_at - bucket)) * 1000 <= $6
   and extract(epoch from ((bucket + make_interval(mins => $4)) - last_at)) * 1000 <= $6),
  'live'
from deltas
where kwh is not null and bucket >= $2
on conflict (meter_id, interval_start, interval_minutes) do update set
  active_energy_kwh     = excluded.active_energy_kwh,
  reactive_energy_kvarh = excluded.reactive_energy_kvarh,
  avg_demand_kw         = excluded.avg_demand_kw,
  avg_demand_kva        = excluded.avg_demand_kva,
  sample_count          = excluded.sample_count,
  expected_samples      = excluded.expected_samples,
  is_complete           = excluded.is_complete`;

/** Snap tolerance (s) and near-boundary window (ms), so callers bind the same values. */
export const SQL_BOUNDARY_SNAP_SECONDS = BOUNDARY_SNAP_MS / 1000;
export const SQL_NEAR_BOUNDARY_MS = NEAR_BOUNDARY_MS;
