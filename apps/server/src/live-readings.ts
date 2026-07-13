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

/** Arithmetic mean of a field across samples. null if no samples carry it. */
export function average(
  samples: RawReadingRow[],
  pick: (r: RawReadingRow) => number | null,
): number | null {
  let sum = 0;
  let n = 0;
  for (const s of samples) {
    const v = num(pick(s));
    if (v === null) continue;
    sum += v;
    n += 1;
  }
  return n === 0 ? null : sum / n;
}

/** Clock-aligned bucket start (epoch seconds) for a timestamp. */
function bucketStartSec(epochMs: number, intervalSec: number): number {
  const epochSec = Math.floor(epochMs / 1000);
  return Math.floor(epochSec / intervalSec) * intervalSec;
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

function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

// Monday-start week containing d, at 00:00 UTC.
function weekStartUtc(d: Date): Date {
  const dow = d.getUTCDay(); // 0=Sun … 6=Sat
  const sinceMonday = (dow + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday));
}

/**
 * Bucket raw samples by calendar week (Monday-start) or month, oldest→newest, each bucket's
 * energy = the per-meter register delta within it (via windowEnergy). Grouping is in UTC —
 * matching the prior calendar-month behaviour. PURE.
 */
export function bucketEnergyByCalendar(rows: RawReadingRow[], unit: "week" | "month"): EnergyBucket[] {
  const groups = new Map<number, RawReadingRow[]>(); // key = bucket-start epoch ms
  for (const r of rows) {
    const start = unit === "month" ? monthStartUtc(r.measuredAt) : weekStartUtc(r.measuredAt);
    const key = start.getTime();
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }

  return [...groups.entries()]
    .sort((a, z) => a[0] - z[0])
    .map(([key, group]) => {
      const start = new Date(key);
      const end =
        unit === "month"
          ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
          : new Date(key + 7 * 24 * 60 * 60 * 1000);
      const energy = windowEnergy(group);
      const label =
        unit === "month"
          ? start.toLocaleDateString("en-ZA", { month: "short", year: "2-digit", timeZone: "UTC" })
          : start.toLocaleDateString("en-ZA", { day: "numeric", month: "short", timeZone: "UTC" });
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
 * Peak demand (kVA) over a window: the highest clock-aligned interval average of apparent
 * power across the site. Demand charges bill the peak *interval average*, never the
 * instantaneous spike, so we bucket first, average within each bucket, then take the max.
 */
export function peakDemandKva(rows: RawReadingRow[], intervalMinutes: number): string {
  const intervalSec = Math.max(1, intervalMinutes) * 60;
  const buckets = new Map<number, RawReadingRow[]>();
  for (const r of rows) {
    const b = bucketStartSec(r.measuredAt.getTime(), intervalSec);
    const arr = buckets.get(b);
    if (arr) arr.push(r);
    else buckets.set(b, [r]);
  }
  let peak = 0;
  for (const samples of buckets.values()) {
    const avgVa = average(samples, (s) => s.vaTotal);
    if (avgVa !== null) {
      const kva = avgVa / 1000;
      if (kva > peak) peak = kva;
    }
  }
  return peak.toFixed(3);
}

/**
 * Bucket raw samples into clock-aligned intervals (oldest→newest) for the load chart.
 * Per interval: energy = per-meter register delta summed; demand = per-meter average
 * instantaneous power (W→kW, VA→kVA) summed across meters. A field is null when no
 * sample in the interval carried it (so the chart can gap rather than plot a false 0).
 */
export function bucketIntervals(rows: RawReadingRow[], intervalMinutes: number): IntervalRow[] {
  const intervalSec = Math.max(1, intervalMinutes) * 60;
  // bucketStart → meterId → samples
  const buckets = new Map<number, Map<string, RawReadingRow[]>>();
  for (const r of rows) {
    const b = bucketStartSec(r.measuredAt.getTime(), intervalSec);
    let perMeter = buckets.get(b);
    if (!perMeter) {
      perMeter = new Map();
      buckets.set(b, perMeter);
    }
    const arr = perMeter.get(r.meterId);
    if (arr) arr.push(r);
    else perMeter.set(r.meterId, [r]);
  }

  const out: IntervalRow[] = [];
  for (const [bucketStart, perMeter] of [...buckets.entries()].sort((a, z) => a[0] - z[0])) {
    let active = 0;
    let reactive = 0;
    let kw = 0;
    let kva = 0;
    let haveActive = false;
    let haveReactive = false;
    let haveKw = false;
    let haveKva = false;
    for (const samples of perMeter.values()) {
      const a = registerDelta(samples, (s) => s.energyImportKwh);
      if (a !== null) {
        active += a;
        haveActive = true;
      }
      const re = registerDelta(samples, (s) => s.energyImportKvarh);
      if (re !== null) {
        reactive += re;
        haveReactive = true;
      }
      const pw = average(samples, (s) => s.powerTotalW);
      if (pw !== null) {
        kw += pw / 1000;
        haveKw = true;
      }
      const va = average(samples, (s) => s.vaTotal);
      if (va !== null) {
        kva += va / 1000;
        haveKva = true;
      }
    }
    out.push({
      intervalStart: new Date(bucketStart * 1000).toISOString(),
      intervalMinutes,
      activeEnergyKwh: haveActive ? active.toFixed(3) : null,
      reactiveEnergyKvarh: haveReactive ? reactive.toFixed(3) : null,
      avgDemandKw: haveKw ? kw.toFixed(3) : null,
      avgDemandKva: haveKva ? kva.toFixed(3) : null,
      isComplete: true,
    });
  }
  return out;
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
 * Interval energy = the cumulative register at the interval END boundary minus the value at
 * its START boundary (each = the last reading at or before that boundary). This attributes
 * boundary-straddling consumption to the right interval, handles single-sample intervals, and
 * Σ interval deltas telescopes to (last register − first register), conserving energy — the
 * same method as workers.aggregateDemandIntervals (task 5). Demand = energy / interval-hours.
 * A backwards delta (register rollover / meter reset) clamps to 0. Emits only intervals that
 * contain at least one sample.
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
  const intervalEnergy = (field: EnergyRegister, s: number, e: number): number => {
    const a = registerAtOrBefore(field, s);
    const b = registerAtOrBefore(field, e);
    if (a === null || b === null) return 0;
    const d = b - a;
    return d < 0 ? 0 : d;
  };

  const hours = intervalMinutes / 60;
  const expectedSamples = Math.ceil((intervalMinutes * 60) / 60);
  const out: DerivedMeterInterval[] = [];
  for (let s = startMs; s <= lastMs; s += intervalMs) {
    const e = s + intervalMs;
    const sampleCount = sorted.filter(
      (r) => r.measuredAt.getTime() >= s && r.measuredAt.getTime() < e,
    ).length;
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
      isComplete: sampleCount >= expectedSamples * 0.9,
    });
  }
  return out;
}
