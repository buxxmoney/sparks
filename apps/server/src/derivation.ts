import { db, rawMeterReadings, readings } from "@sparks/db";
import { asc, eq, sql } from "drizzle-orm";
import { aggregateDemandIntervals, detectDataGaps } from "./workers";

/**
 * Derivation layer: turn the device's raw JSON payloads (raw_meter_readings) into the
 * structured `readings` rows the rest of the system already understands, then run the
 * existing aggregation → demand_intervals feed the graphs + reconciliation.
 *
 * This is deliberately SEPARATE from ingestion and from the raw store: raw_meter_readings
 * is the immutable source of truth, and this is "what we calculate from it". If the mapping
 * changes we just re-run it over the raw rows — the device contract and raw table never move.
 */

/** The structured fields we can populate from a raw payload; nulls where absent. */
export interface DerivedReading {
  activeEnergyKwh: string | null;
  reactiveEnergyKvarh: string | null;
  apparentEnergyKvah: string | null;
  totalPowerKw: string | null;
  totalApparentKva: string | null;
  powerFactor: string | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Sum the three per-phase fields (…_l1/_l2/_l3) when the total is absent. */
function sumPhases(r: Record<string, unknown>, prefix: string): number | null {
  const parts = [num(r[`${prefix}_l1`]), num(r[`${prefix}_l2`]), num(r[`${prefix}_l3`])];
  if (parts.every((p) => p === null)) return null;
  return parts.reduce<number>((acc, p) => acc + (p ?? 0), 0);
}

/**
 * Map one raw device payload to structured reading fields. PURE. The device sends
 * CUMULATIVE energy registers (kWh/kVArh/kVAh) and INSTANTANEOUS power in WATTS / VA:
 *   - active energy   ← energy_import_kwh   (consumption register)
 *   - reactive energy ← energy_import_kvarh
 *   - apparent energy ← energy_kvah         (drives demand kVA downstream)
 *   - power  kW  ← power_total (W) / 1000    (fallback: Σ power_lN)
 *   - apparent kVA ← va_total (VA) / 1000    (fallback: Σ va_lN)
 *   - power factor ← |kW / kVA|, clamped to ≤ 1 (device sends no PF directly)
 */
export function mapRawPayloadToReading(payload: unknown): DerivedReading {
  const readingsObj =
    payload && typeof payload === "object"
      ? ((payload as { readings?: unknown }).readings ?? {})
      : {};
  const r = (readingsObj && typeof readingsObj === "object" ? readingsObj : {}) as Record<
    string,
    unknown
  >;

  const importKwh = num(r.energy_import_kwh);
  const importKvarh = num(r.energy_import_kvarh);
  const kvah = num(r.energy_kvah);

  const powerW = num(r.power_total) ?? sumPhases(r, "power");
  const vaVa = num(r.va_total) ?? sumPhases(r, "va");
  const totalPowerKw = powerW !== null ? powerW / 1000 : null;
  const totalApparentKva = vaVa !== null ? vaVa / 1000 : null;
  const powerFactor =
    totalPowerKw !== null && totalApparentKva !== null && totalApparentKva > 0
      ? Math.min(1, Math.abs(totalPowerKw / totalApparentKva))
      : null;

  return {
    activeEnergyKwh: importKwh !== null ? importKwh.toFixed(3) : null,
    reactiveEnergyKvarh: importKvarh !== null ? importKvarh.toFixed(3) : null,
    apparentEnergyKvah: kvah !== null ? kvah.toFixed(3) : null,
    totalPowerKw: totalPowerKw !== null ? totalPowerKw.toFixed(3) : null,
    totalApparentKva: totalApparentKva !== null ? totalApparentKva.toFixed(3) : null,
    powerFactor: powerFactor !== null ? powerFactor.toFixed(4) : null,
  };
}

/**
 * Derive the given raw items into `readings` (upsert on (meter_id, time) so a re-derive
 * overwrites), then re-aggregate demand_intervals + gap detection for the meter. Used both
 * on ingest (pass the just-stored batch) and for backfills (pass all of a meter's raw rows).
 */
export async function deriveReadings(
  meterId: string,
  items: { recordedAt: Date; payload: unknown }[],
): Promise<{ derived: number }> {
  if (items.length === 0) return { derived: 0 };

  const rows = items.map((it) => {
    const d = mapRawPayloadToReading(it.payload);
    return {
      meterId,
      time: it.recordedAt,
      activeEnergyKwh: d.activeEnergyKwh,
      reactiveEnergyKvarh: d.reactiveEnergyKvarh,
      apparentEnergyKvah: d.apparentEnergyKvah,
      totalPowerKw: d.totalPowerKw,
      totalApparentKva: d.totalApparentKva,
      powerFactor: d.powerFactor,
      source: "live" as const,
    };
  });

  await db
    .insert(readings)
    .values(rows)
    .onConflictDoUpdate({
      target: [readings.meterId, readings.time],
      set: {
        activeEnergyKwh: sqlExcluded("active_energy_kwh"),
        reactiveEnergyKvarh: sqlExcluded("reactive_energy_kvarh"),
        apparentEnergyKvah: sqlExcluded("apparent_energy_kvah"),
        totalPowerKw: sqlExcluded("total_power_kw"),
        totalApparentKva: sqlExcluded("total_apparent_kva"),
        powerFactor: sqlExcluded("power_factor"),
      },
    });

  await aggregateDemandIntervals(meterId);
  await detectDataGaps(meterId);

  return { derived: rows.length };
}

// So the ON CONFLICT … SET writes the incoming (EXCLUDED) values. The column names are
// fixed literals from the schema, never user input, so sql.raw is safe here.
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}

/**
 * Re-derive ALL of a meter's structured readings from its raw payloads (e.g. after a
 * mapping change, or to backfill a meter ingested before derivation existed).
 */
export async function backfillReadingsForMeter(meterId: string): Promise<{ derived: number }> {
  const raws = await db
    .select({ recordedAt: rawMeterReadings.recordedAt, payload: rawMeterReadings.payload })
    .from(rawMeterReadings)
    .where(eq(rawMeterReadings.meterId, meterId))
    .orderBy(asc(rawMeterReadings.recordedAt));
  return deriveReadings(
    meterId,
    raws.map((r) => ({ recordedAt: r.recordedAt, payload: r.payload })),
  );
}
