/**
 * Read-only verification of the peak-demand calculation. Prints the arithmetic so it can be
 * checked by hand, then reproduces the real production peak from the raw `readings` table.
 * Writes NOTHING.
 *
 * Usage (from apps/server):  bun scripts/verify-peak-demand.ts [siteId]
 *
 * Demand of a clock-aligned interval = (apparent-energy register at the interval END boundary
 * − register at the START boundary) ÷ interval-hours. Each boundary register is snapped to its
 * on-the-boundary sample with a small tolerance, because meters timestamp the :00/:30 reading a
 * millisecond or two late. This is exactly how billing reconciliation charges demand, so the
 * dashboard peak matches the bill.
 */
import "dotenv/config";
import { getDb } from "@sparks/db";
import { sql } from "drizzle-orm";
import { peakDemandKva, deriveMeterIntervals, type RawReadingRow } from "../src/live-readings";

const db = getDb();
const toNum = (v: unknown) => (v == null ? null : Number.isNaN(Number(v)) ? null : Number(v));
const fmt = (n: number) => n.toFixed(3);
const SNAP_MS = 5_000; // must match BOUNDARY_SNAP_MS in live-readings.ts

// A fully-sampled 30-min bucket: 30 one-per-minute samples, apparent register starting at
// `firstReg`. Samples land 1ms after each minute (mimicking the meter's slightly-late clock).
function fullBucket(meterId: string, startIso: string, firstReg: number): RawReadingRow[] {
  const t0 = new Date(startIso).getTime();
  const rows: RawReadingRow[] = [];
  for (let i = 0; i < 30; i++) {
    rows.push({
      meterId,
      measuredAt: new Date(t0 + i * 60_000 + 1),
      energyImportKwh: null,
      energyImportKvarh: null,
      apparentEnergyKvah: firstReg + i * 0.001,
      powerTotalW: null,
      vaTotal: null,
    });
  }
  return rows;
}

// ────────────────────────── PART 1: hand-checkable synthetic example ──────────────────────────
function part1() {
  console.log("═══ PART 1 — worked example you can verify by hand ═══\n");
  // Three consecutive fully-sampled 30-min buckets ⇒ two complete intervals.
  const rows = [
    ...fullBucket("demo", "2026-07-15T00:00:00Z", 100),
    ...fullBucket("demo", "2026-07-15T00:30:00Z", 105),
    ...fullBucket("demo", "2026-07-15T01:00:00Z", 113),
  ];
  console.log("Interval A [00:00 → 00:30):");
  console.log("   register at start = 100.000 kVAh, at end = 105.000 kVAh");
  console.log("   demand = (105.000 − 100.000) ÷ 0.5 h = 10.000 kVA\n");
  console.log("Interval B [00:30 → 01:00):");
  console.log("   register at start = 105.000 kVAh, at end = 113.000 kVAh");
  console.log("   demand = (113.000 − 105.000) ÷ 0.5 h = 16.000 kVA   ← the higher interval\n");
  console.log("   → peak = max(10.000, 16.000) = 16.000 kVA");
  const got = peakDemandKva(rows, 30);
  console.log(`   peakDemandKva() returns: ${got} kVA  ${got === "16.000" ? "✓" : "✗ MISMATCH"}\n`);
}

// ────────────────────────── PART 2: the gap guard, demonstrated ──────────────────────────
function part2() {
  console.log("═══ PART 2 — a MISSED-READING (gap) interval is refused, not billed ═══\n");
  const rows: RawReadingRow[] = [
    // Two full buckets ⇒ one complete interval [00:30,01:00) = 16 kVA (the real peak).
    ...fullBucket("demo", "2026-07-15T00:30:00Z", 105),
    ...fullBucket("demo", "2026-07-15T01:00:00Z", 113),
  ];
  // A sparse bucket [01:30,02:00): meter dropped out, only 3 of ~30 samples, register leaps to
  // 200. The interval [01:00,01:30) reading into it computes a phantom ~174 kVA.
  for (const [iso, reg] of [
    ["2026-07-15T01:30:00.001Z", 200],
    ["2026-07-15T01:40:00.001Z", 260],
    ["2026-07-15T01:50:00.001Z", 320],
  ] as const) {
    rows.push({
      meterId: "demo",
      measuredAt: new Date(iso),
      energyImportKwh: null,
      energyImportKvarh: null,
      apparentEnergyKvah: reg,
      powerTotalW: null,
      vaTotal: null,
    });
  }

  console.log("Every derived interval, with its completeness flag:");
  for (const iv of deriveMeterIntervals(rows, 30)) {
    console.log(
      `   ${iv.intervalStart.toISOString()}  demand=${iv.avgDemandKva.padStart(8)} kVA  samples=${String(iv.sampleCount).padStart(2)}/${iv.expectedSamples}  complete=${iv.isComplete}`,
    );
  }
  const got = peakDemandKva(rows, 30);
  console.log(`\n   The 01:00 interval computes a huge demand but is complete=false (gap ahead).`);
  console.log(`   peakDemandKva() skips it and returns: ${got} kVA  ${got === "16.000" ? "✓ gap ignored" : "✗ gap leaked"}\n`);
}

// ────────────────────────── PART 3: reproduce the REAL production peak ──────────────────────────
async function part3(argSite?: string) {
  console.log("═══ PART 3 — the real peak from production raw readings ═══\n");
  const siteRows = (
    await db.execute(sql`SELECT s.id, s.name, s.demand_interval_minutes AS dim FROM sites s ORDER BY s.name`)
  ).rows as Record<string, unknown>[];
  const siteId = argSite ?? (siteRows[0]?.id as string | undefined);
  const site = siteRows.find((r) => r.id === siteId);
  if (!siteId || !site) return console.log("no site found");
  const interval = Number(site.dim ?? 30);
  console.log(`site: ${site.name}  (interval = ${interval} min)`);

  const meterIds = (
    (await db.execute(sql`SELECT id FROM meters WHERE site_id = ${siteId}`)).rows as Record<string, unknown>[]
  ).map((m) => String(m.id));
  if (meterIds.length === 0) return console.log("no meters");

  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const idList = sql.join(meterIds.map((id) => sql`${id}`), sql`, `);
  const res = await db.execute(sql`
    SELECT meter_id, measured_at, energy_import_kwh, energy_import_kvarh, energy_kvah, power_total, va_total
    FROM readings
    WHERE meter_id IN (${idList}) AND measured_at >= ${from} AND measured_at <= ${now}
    ORDER BY measured_at ASC`);
  const rows: RawReadingRow[] = (res.rows as Record<string, unknown>[]).map((r) => ({
    meterId: String(r.meter_id),
    measuredAt: new Date(r.measured_at as string),
    energyImportKwh: toNum(r.energy_import_kwh),
    energyImportKvarh: toNum(r.energy_import_kvarh),
    apparentEnergyKvah: toNum(r.energy_kvah),
    powerTotalW: toNum(r.power_total),
    vaTotal: toNum(r.va_total),
  }));
  console.log(`window: ${from.toISOString()} → ${now.toISOString()}  (${rows.length} samples)\n`);

  const byMeter = new Map<string, RawReadingRow[]>();
  for (const r of rows) (byMeter.get(r.meterId) ?? byMeter.set(r.meterId, []).get(r.meterId)!).push(r);
  let best: { when: string; kva: number; startReg: number; endReg: number; hours: number } | null = null;
  for (const samples of byMeter.values()) {
    const sorted = [...samples].sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
    // register at or before t (snapped by SNAP_MS), matching boundaryRegister in the code.
    const regAt = (t: number) => {
      let v: number | null = null;
      for (const r of sorted) {
        if (r.measuredAt.getTime() > t + SNAP_MS) break;
        if (r.apparentEnergyKvah !== null) v = r.apparentEnergyKvah;
      }
      return v ?? 0;
    };
    for (const iv of deriveMeterIntervals(samples, interval)) {
      if (!iv.isComplete) continue;
      const kva = Number(iv.avgDemandKva);
      if (best && kva <= best.kva) continue;
      const startMs = iv.intervalStart.getTime();
      best = {
        when: iv.intervalStart.toISOString(),
        kva,
        startReg: regAt(startMs),
        endReg: regAt(startMs + interval * 60_000),
        hours: interval / 60,
      };
    }
  }
  if (best) {
    console.log(`Peak interval: ${best.when}`);
    console.log(`   apparent register at start = ${fmt(best.startReg)} kVAh`);
    console.log(`   apparent register at end   = ${fmt(best.endReg)} kVAh`);
    console.log(`   demand = (${fmt(best.endReg)} − ${fmt(best.startReg)}) ÷ ${best.hours} h = ${fmt((best.endReg - best.startReg) / best.hours)} kVA\n`);
  }
  console.log(`peakDemandKva() over the whole month: ${peakDemandKva(rows, interval)} kVA`);
}

async function main() {
  part1();
  part2();
  await part3(process.argv[2]);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
