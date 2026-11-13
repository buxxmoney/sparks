/**
 * Live bill estimation: raw readings → per-interval usage → tariff pricing.
 *
 * Covers the pure half of `readings.billToDate` — `usageFromRawReadings` composed
 * with `priceUsage`. Both are pure, so the whole pricing path is testable without a
 * database; the procedure itself only adds the DB fetch and the billing-period
 * window (exercised in billing.test.ts).
 */
import { describe, expect, it } from "bun:test";
import { type RawReadingRow, usageFromRawReadings } from "../live-readings";
import { type TariffProfile, type UsageData, priceUsage } from "../tariffs";

function sample(
  meterId: string,
  iso: string,
  fields: Partial<Omit<RawReadingRow, "meterId" | "measuredAt">> = {},
): RawReadingRow {
  return {
    meterId,
    measuredAt: new Date(iso),
    energyImportKwh: fields.energyImportKwh ?? null,
    energyImportKvarh: fields.energyImportKvarh ?? null,
    apparentEnergyKvah: fields.apparentEnergyKvah ?? null,
    powerTotalW: fields.powerTotalW ?? null,
    vaTotal: fields.vaTotal ?? null,
  };
}

/**
 * A meter ramping its cumulative registers at a constant rate, sampled every
 * `stepMin` minutes from `startIso` for `count` samples. Registers start at the
 * given bases so deltas — not absolute values — drive every assertion.
 */
function ramp(
  meterId: string,
  startIso: string,
  count: number,
  stepMin: number,
  perStep: { kwh: number; kvarh: number; kvah: number },
  base = { kwh: 10_000, kvarh: 4_000, kvah: 11_000 },
): RawReadingRow[] {
  const t0 = new Date(startIso).getTime();
  const out: RawReadingRow[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      sample(meterId, new Date(t0 + i * stepMin * 60_000).toISOString(), {
        energyImportKwh: base.kwh + i * perStep.kwh,
        energyImportKvarh: base.kvarh + i * perStep.kvarh,
        apparentEnergyKvah: base.kvah + i * perStep.kvah,
      }),
    );
  }
  return out;
}

describe("usageFromRawReadings", () => {
  it("totals energy by register delta and reports demand as an interval average", () => {
    // 1 kWh/min for 60 min on a 30-min interval ⇒ 30 kWh per interval ⇒ 60 kW.
    // kVAh ramps at 1.1/min ⇒ 33 kVAh per interval ⇒ 66 kVA.
    const rows = ramp("m1", "2026-09-01T00:00:00Z", 61, 1, { kwh: 1, kvarh: 0.4, kvah: 1.1 });
    const u = usageFromRawReadings(rows, 30);

    expect(u.activeKwh).toBeCloseTo(60, 6);
    expect(u.reactiveKvarh).toBeCloseTo(24, 6);
    expect(u.maxDemandKva).toBeCloseTo(66, 6);
    // Two full 30-min intervals, plus the trailing bucket holding the 60-min sample.
    // That last bucket has no second boundary yet, so it contributes 0 kWh — harmless,
    // since pricing consumes the per-interval array rather than dividing a total.
    expect(u.intervalCount).toBe(3);
    expect(u.intervalActiveKwh).toEqual([30, 30, 0]);
  });

  it("sums across meters — a site is priced as one supply point", () => {
    const a = ramp("m1", "2026-09-01T00:00:00Z", 31, 1, { kwh: 1, kvarh: 0.4, kvah: 1.1 });
    const b = ramp("m2", "2026-09-01T00:00:00Z", 31, 1, { kwh: 2, kvarh: 0.8, kvah: 2.2 });
    const u = usageFromRawReadings([...a, ...b], 30);

    expect(u.activeKwh).toBeCloseTo(90, 6); // 30 (m1) + 60 (m2)
    expect(u.maxDemandKva).toBeCloseTo(198, 6); // 66 (m1) + 132 (m2)
    expect(u.intervalCount).toBe(2); // the full interval + the trailing boundary sample
  });

  it("never lets an incomplete interval set peak demand", () => {
    // A dense first interval, then a long dropout whose resumption carries a huge
    // register jump. The straddling interval's demand is bogus and must be ignored.
    const dense = ramp("m1", "2026-09-01T00:00:00Z", 31, 1, { kwh: 1, kvarh: 0.4, kvah: 1.1 });
    const afterGap = sample("m1", "2026-09-01T03:00:00Z", {
      energyImportKwh: 20_000,
      energyImportKvarh: 8_000,
      apparentEnergyKvah: 22_000,
    });
    const u = usageFromRawReadings([...dense, afterGap], 30);

    // Peak stays the honest 66 kVA from the complete interval, not the spike.
    expect(u.maxDemandKva).toBeCloseTo(66, 6);
    // The bucket where sampling resumes holds a single sample, so it has no second
    // boundary to delta against and contributes nothing. The estimate therefore
    // UNDER-reports energy across a dropout rather than inventing a spike — the
    // conservative direction for a figure we show as money.
    expect(u.activeKwh).toBeCloseTo(30, 6);
  });

  it("returns a zero-interval result for an empty period", () => {
    const u = usageFromRawReadings([], 30);
    expect(u.intervalCount).toBe(0);
    expect(u.activeKwh).toBe(0);
    expect(u.maxDemandKva).toBe(0);
  });
});

describe("live pricing", () => {
  const flat: TariffProfile = {
    rates: [
      { chargeType: "active_energy", unit: "c_per_kwh", rateValue: 250, season: "all", touPeriod: "all" },
      { chargeType: "demand", unit: "r_per_kva", rateValue: 150, season: "all", touPeriod: "all" },
      { chargeType: "fixed", unit: "r_per_month", rateValue: 1_200, season: "all", touPeriod: "all" },
    ],
  };

  it("prices a flat tariff from raw readings", () => {
    const rows = ramp("m1", "2026-09-01T00:00:00Z", 61, 1, { kwh: 1, kvarh: 0.4, kvah: 1.1 });
    const u = usageFromRawReadings(rows, 30);
    const priced = priceUsage(
      { ...u, timezone: "Africa/Johannesburg" },
      flat,
    );

    // 60 kWh × R2.50 = R150; 66 kVA × R150 = R9 900; fixed R1 200.
    expect(priced.activeEnergyCents).toBe(15_000);
    expect(priced.demandCents).toBe(990_000);
    expect(priced.fixedCents).toBe(120_000);
    expect(priced.totalCents).toBe(1_125_000);
  });

  it("charges the full fixed charge regardless of how little of the period has elapsed", () => {
    // This is exactly why the live figure is cost-to-date and not a projection:
    // a fixed monthly charge does not accrue pro-rata, so it can't be extrapolated.
    const oneInterval = ramp("m1", "2026-09-01T00:00:00Z", 31, 1, { kwh: 1, kvarh: 0.4, kvah: 1.1 });
    const u = usageFromRawReadings(oneInterval, 30);
    const priced = priceUsage({ ...u, timezone: "Africa/Johannesburg" }, flat);

    expect(priced.fixedCents).toBe(120_000);
  });

  it("attributes energy to time-of-use bands using real interval timestamps", () => {
    // Peak 07:00–09:00 SAST (05:00–07:00 UTC), offpeak otherwise. Rates differ 4×,
    // so a flat total would be visibly wrong.
    const tou: TariffProfile = {
      touSchedule: {
        weekday: { "7": "peak", "8": "peak", "10": "offpeak", "11": "offpeak" },
        weekend: { "7": "peak", "8": "peak", "10": "offpeak", "11": "offpeak" },
      },
      rates: [
        { chargeType: "active_energy", unit: "c_per_kwh", rateValue: 400, season: "all", touPeriod: "peak" },
        { chargeType: "active_energy", unit: "c_per_kwh", rateValue: 100, season: "all", touPeriod: "offpeak" },
      ],
    };

    // One 30-min interval inside the peak window (07:00 SAST = 05:00 UTC) and one
    // inside offpeak (10:00 SAST = 08:00 UTC), 30 kWh each.
    const peak = ramp("m1", "2026-09-01T05:00:00Z", 31, 1, { kwh: 1, kvarh: 0, kvah: 1 });
    const off = ramp("m1", "2026-09-01T08:00:00Z", 31, 1, { kwh: 1, kvarh: 0, kvah: 1 },
      { kwh: 20_000, kvarh: 8_000, kvah: 22_000 });
    const u = usageFromRawReadings([...peak, ...off], 30);
    const priced = priceUsage({ ...u, timezone: "Africa/Johannesburg" }, tou);

    // 30 kWh × R4 (peak) + 30 kWh × R1 (offpeak) = R150 — not 60 × either rate.
    expect(priced.activeEnergyCents).toBe(15_000);
  });
});

describe("seasonal block tariffs", () => {
  // Shape of COJ "Business Conventional/Prepaid": a full set of inclining blocks
  // published for EACH season. Real FY26/27 rates (c/kWh → R/kWh).
  const seasonalBlock: TariffProfile = {
    touSchedule: { highSeasonMonths: [6, 7, 8] }, // winter = Jun–Aug
    rates: [
      { chargeType: "active_energy", unit: "c_per_kwh", rateValue: 380.52, season: "low", touPeriod: "all", blockThresholdKwh: 500 },
      { chargeType: "active_energy", unit: "c_per_kwh", rateValue: 417.67, season: "low", touPeriod: "all", blockThresholdKwh: 1000 },
      { chargeType: "active_energy", unit: "c_per_kwh", rateValue: 437.99, season: "low", touPeriod: "all", blockThresholdKwh: 2000 },
      { chargeType: "active_energy", unit: "c_per_kwh", rateValue: 398.37, season: "high", touPeriod: "all", blockThresholdKwh: 500 },
      { chargeType: "active_energy", unit: "c_per_kwh", rateValue: 433.7, season: "high", touPeriod: "all", blockThresholdKwh: 1000 },
      { chargeType: "active_energy", unit: "c_per_kwh", rateValue: 453.06, season: "high", touPeriod: "all", blockThresholdKwh: 2000 },
    ],
  };

  // A day of half-hourly intervals in the given month, totalling `kwh`.
  function monthUsage(month: number, kwh: number): UsageData {
    const starts: Date[] = [];
    const each: number[] = [];
    for (let i = 0; i < 48; i++) {
      starts.push(new Date(Date.UTC(2027, month, 14, Math.floor(i / 2), (i % 2) * 30)));
      each.push(kwh / 48);
    }
    return {
      activeKwh: kwh,
      maxDemandKva: 0,
      reactiveKvarh: 0,
      intervalStarts: starts,
      intervalActiveKwh: each,
      timezone: "Africa/Johannesburg",
    };
  }

  it("tiers within the season's own blocks, not across both seasons", () => {
    // 400 kWh sits entirely in block 1. Summer 400 × R3.8052 = R1522.08;
    // winter 400 × R3.9837 = R1593.48.
    expect(priceUsage(monthUsage(0, 400), seasonalBlock).activeEnergyCents).toBe(152_208);
    expect(priceUsage(monthUsage(6, 400), seasonalBlock).activeEnergyCents).toBe(159_348);
  });

  it("prices a multi-block period at the right season's rates", () => {
    // 1500 kWh = 500@b1 + 500@b2 + 500@b3.
    // Summer: 500(3.8052 + 4.1767 + 4.3799) = R6180.90
    // Winter: 500(3.9837 + 4.3370 + 4.5306) = R6425.65
    expect(priceUsage(monthUsage(0, 1500), seasonalBlock).activeEnergyCents).toBe(618_090);
    expect(priceUsage(monthUsage(6, 1500), seasonalBlock).activeEnergyCents).toBe(642_565);
  });

  it("charges winter more than summer for identical usage", () => {
    // The regression this guards: both seasons previously returned the same
    // figure, because block tiering ignored season entirely.
    const summer = priceUsage(monthUsage(0, 1500), seasonalBlock).activeEnergyCents;
    const winter = priceUsage(monthUsage(6, 1500), seasonalBlock).activeEnergyCents;
    expect(winter).toBeGreaterThan(summer);
  });

  it("still tiers a season-agnostic block tariff across all its blocks", () => {
    // A plain inclining-block tariff (no season-specific rows) must behave
    // exactly as before: 1500 kWh = 500@2 + 500@3 + 500@4 = R4500.
    const flatBlocks: TariffProfile = {
      rates: [
        { chargeType: "active_energy", unit: "c_per_kwh", rateValue: 200, season: "all", touPeriod: "all", blockThresholdKwh: 500 },
        { chargeType: "active_energy", unit: "c_per_kwh", rateValue: 300, season: "all", touPeriod: "all", blockThresholdKwh: 1000 },
        { chargeType: "active_energy", unit: "c_per_kwh", rateValue: 400, season: "all", touPeriod: "all" },
      ],
    };
    expect(priceUsage(monthUsage(0, 1500), flatBlocks).activeEnergyCents).toBe(450_000);
  });
});
