import { describe, expect, it } from "bun:test";
import {
  type RawReadingRow,
  average,
  bucketEnergyByCalendar,
  bucketIntervals,
  deriveMeterIntervals,
  peakDemandKva,
  registerDelta,
  windowEnergy,
} from "../live-readings";

// Build a raw sample. Energy registers are CUMULATIVE (kWh/kVArh); power is in WATTS/VA.
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

describe("registerDelta", () => {
  it("is last − first for a monotonic cumulative register", () => {
    const rows = [
      sample("m", "2026-07-15T00:00:00Z", { energyImportKwh: 1000 }),
      sample("m", "2026-07-15T00:10:00Z", { energyImportKwh: 1004 }),
      sample("m", "2026-07-15T00:20:00Z", { energyImportKwh: 1007 }),
    ];
    expect(registerDelta(rows, (r) => r.energyImportKwh)).toBe(7);
  });

  it("clamps a backwards delta (meter reset / rollover) to 0", () => {
    const rows = [
      sample("m", "2026-07-15T00:00:00Z", { energyImportKwh: 100 }),
      sample("m", "2026-07-15T00:10:00Z", { energyImportKwh: 105 }),
      sample("m", "2026-07-15T00:20:00Z", { energyImportKwh: 50 }),
      sample("m", "2026-07-15T00:30:00Z", { energyImportKwh: 52 }),
    ];
    // last(52) − first(100) = −48 → clamped, never a max−min spread of 55.
    expect(registerDelta(rows, (r) => r.energyImportKwh)).toBe(0);
  });

  it("returns null when no sample carries the field", () => {
    const rows = [sample("m", "2026-07-15T00:00:00Z", { powerTotalW: 500 })];
    expect(registerDelta(rows, (r) => r.energyImportKwh)).toBeNull();
  });
});

describe("average", () => {
  it("means only the samples that carry the field", () => {
    const rows = [
      sample("m", "2026-07-15T00:00:00Z", { powerTotalW: 2000 }),
      sample("m", "2026-07-15T00:01:00Z", {}),
      sample("m", "2026-07-15T00:02:00Z", { powerTotalW: 4000 }),
    ];
    expect(average(rows, (r) => r.powerTotalW)).toBe(3000);
  });
});

describe("windowEnergy", () => {
  it("sums each meter's register delta across the window", () => {
    const rows = [
      sample("m1", "2026-07-15T00:00:00Z", { energyImportKwh: 100, energyImportKvarh: 10 }),
      sample("m1", "2026-07-15T00:30:00Z", { energyImportKwh: 110, energyImportKvarh: 12 }),
      sample("m2", "2026-07-15T00:00:00Z", { energyImportKwh: 50, energyImportKvarh: 5 }),
      sample("m2", "2026-07-15T00:30:00Z", { energyImportKwh: 57, energyImportKvarh: 6 }),
    ];
    const e = windowEnergy(rows);
    expect(e.activeEnergyKwh).toBe("17.000"); // (110−100) + (57−50)
    expect(e.reactiveEnergyKvarh).toBe("3.000"); // (12−10) + (6−5)
  });

  it("is zero for an empty window", () => {
    expect(windowEnergy([])).toEqual({ activeEnergyKwh: "0.000", reactiveEnergyKvarh: "0.000" });
  });
});

describe("bucketEnergyByCalendar", () => {
  it("buckets by calendar month, oldest→newest, energy = register delta per month", () => {
    const rows = [
      // June: 100 → 130 (30 kWh)
      sample("m", "2026-06-05T00:00:00Z", { energyImportKwh: 100 }),
      sample("m", "2026-06-25T00:00:00Z", { energyImportKwh: 130 }),
      // July: 130 → 175 (45 kWh)
      sample("m", "2026-07-03T00:00:00Z", { energyImportKwh: 130 }),
      sample("m", "2026-07-28T00:00:00Z", { energyImportKwh: 175 }),
    ];
    const out = bucketEnergyByCalendar(rows, "month");
    expect(out).toHaveLength(2);
    expect(out[0]?.periodStart).toBe("2026-06-01T00:00:00.000Z");
    expect(out[1]?.periodStart).toBe("2026-07-01T00:00:00.000Z");
    expect(out.map((b) => b.activeEnergyKwh)).toEqual(["30.000", "45.000"]);
  });

  it("buckets by calendar day", () => {
    const rows = [
      // 12 Jul: 100 → 108 (8 kWh)
      sample("m", "2026-07-12T02:00:00Z", { energyImportKwh: 100 }),
      sample("m", "2026-07-12T20:00:00Z", { energyImportKwh: 108 }),
      // 13 Jul: 108 → 114 (6 kWh)
      sample("m", "2026-07-13T05:00:00Z", { energyImportKwh: 108 }),
      sample("m", "2026-07-13T22:00:00Z", { energyImportKwh: 114 }),
    ];
    const out = bucketEnergyByCalendar(rows, "day");
    expect(out).toHaveLength(2);
    expect(out[0]?.periodStart).toBe("2026-07-12T00:00:00.000Z");
    expect(out[0]?.periodEnd).toBe("2026-07-13T00:00:00.000Z");
    expect(out[1]?.periodStart).toBe("2026-07-13T00:00:00.000Z");
    expect(out.map((b) => b.activeEnergyKwh)).toEqual(["8.000", "6.000"]);
  });

  it("buckets by Monday-start week", () => {
    // 2026-07-13 is a Monday; 2026-07-15 (Wed) is the same week; 2026-07-20 is the next Monday.
    const rows = [
      sample("m", "2026-07-13T06:00:00Z", { energyImportKwh: 10 }),
      sample("m", "2026-07-15T06:00:00Z", { energyImportKwh: 14 }), // same week → 4 kWh
      sample("m", "2026-07-20T06:00:00Z", { energyImportKwh: 14 }),
      sample("m", "2026-07-22T06:00:00Z", { energyImportKwh: 21 }), // next week → 7 kWh
    ];
    const out = bucketEnergyByCalendar(rows, "week");
    expect(out).toHaveLength(2);
    expect(out[0]?.periodStart).toBe("2026-07-13T00:00:00.000Z");
    expect(out[1]?.periodStart).toBe("2026-07-20T00:00:00.000Z");
    expect(out.map((b) => b.activeEnergyKwh)).toEqual(["4.000", "7.000"]);
  });

  it("is empty for no samples", () => {
    expect(bucketEnergyByCalendar([], "month")).toEqual([]);
  });
});

describe("peakDemandKva", () => {
  it("takes the highest interval AVERAGE, not an instantaneous spike", () => {
    const rows = [
      // Interval A [00:00,00:30): a 10 kVA instantaneous spike but averages to 6 kVA.
      sample("m", "2026-07-15T00:00:00Z", { vaTotal: 10000 }),
      sample("m", "2026-07-15T00:15:00Z", { vaTotal: 2000 }),
      // Interval B [00:30,01:00): steady 7 kVA — the true billable peak.
      sample("m", "2026-07-15T00:30:00Z", { vaTotal: 7000 }),
      sample("m", "2026-07-15T00:45:00Z", { vaTotal: 7000 }),
    ];
    expect(peakDemandKva(rows, 30)).toBe("7.000");
  });
});

describe("bucketIntervals", () => {
  it("buckets into clock-aligned intervals oldest→newest with per-interval energy + demand", () => {
    const base = "2026-07-15T00:00:00Z";
    const t = (min: number) => new Date(new Date(base).getTime() + min * 60000).toISOString();
    // Fed out of order to prove sorting. Registers rise; power is constant within each bucket.
    const rows = [
      // Bucket 2 [01:00,01:30): 1003→1006 (3 kWh), 6000 W → 6 kW.
      sample("m", t(60), { energyImportKwh: 1003, powerTotalW: 6000 }),
      sample("m", t(75), { energyImportKwh: 1006, powerTotalW: 6000 }),
      // Bucket 0 [00:00,00:30): 1000→1001 (1 kWh), 2000 W → 2 kW.
      sample("m", t(0), { energyImportKwh: 1000, powerTotalW: 2000 }),
      sample("m", t(15), { energyImportKwh: 1001, powerTotalW: 2000 }),
      // Bucket 1 [00:30,01:00): 1001→1003 (2 kWh), 4000 W → 4 kW.
      sample("m", t(30), { energyImportKwh: 1001, powerTotalW: 4000 }),
      sample("m", t(45), { energyImportKwh: 1003, powerTotalW: 4000 }),
    ];
    const out = bucketIntervals(rows, 30);
    expect(out).toHaveLength(3);
    expect(out.map((i) => i.intervalStart)).toEqual([t(0), t(30), t(60)]);
    expect(out.map((i) => i.avgDemandKw)).toEqual(["2.000", "4.000", "6.000"]);
    expect(out.map((i) => i.activeEnergyKwh)).toEqual(["1.000", "2.000", "3.000"]);
    expect(out[0]?.intervalMinutes).toBe(30);
  });

  it("sums energy and demand across meters within an interval", () => {
    const rows = [
      sample("m1", "2026-07-15T00:00:00Z", { energyImportKwh: 100, powerTotalW: 2000, vaTotal: 2200 }),
      sample("m1", "2026-07-15T00:15:00Z", { energyImportKwh: 103, powerTotalW: 2000, vaTotal: 2200 }),
      sample("m2", "2026-07-15T00:00:00Z", { energyImportKwh: 500, powerTotalW: 3000, vaTotal: 3100 }),
      sample("m2", "2026-07-15T00:15:00Z", { energyImportKwh: 504, powerTotalW: 3000, vaTotal: 3100 }),
    ];
    const out = bucketIntervals(rows, 30);
    expect(out).toHaveLength(1);
    expect(out[0]?.activeEnergyKwh).toBe("7.000"); // 3 + 4
    expect(out[0]?.avgDemandKw).toBe("5.000"); // 2 + 3
    expect(out[0]?.avgDemandKva).toBe("5.300"); // 2.2 + 3.1
  });

  it("nulls a metric when no sample in the interval carries it (so the chart can gap)", () => {
    const rows = [
      sample("m", "2026-07-15T00:00:00Z", { powerTotalW: 2000 }),
      sample("m", "2026-07-15T00:15:00Z", { powerTotalW: 2000 }),
    ];
    const out = bucketIntervals(rows, 30);
    expect(out[0]?.avgDemandKw).toBe("2.000");
    expect(out[0]?.activeEnergyKwh).toBeNull();
    expect(out[0]?.avgDemandKva).toBeNull();
  });

  it("returns nothing for no samples", () => {
    expect(bucketIntervals([], 30)).toEqual([]);
  });
});

describe("deriveMeterIntervals (billing)", () => {
  it("uses register-at-boundary energy that conserves across interval boundaries", () => {
    // 30-min intervals. Cumulative active (kWh) + apparent (kVAh) registers.
    const rows = [
      sample("m", "2026-07-13T00:00:00Z", { energyImportKwh: 1000, apparentEnergyKvah: 1010 }),
      sample("m", "2026-07-13T00:15:00Z", { energyImportKwh: 1002, apparentEnergyKvah: 1013 }),
      sample("m", "2026-07-13T00:30:00Z", { energyImportKwh: 1005, apparentEnergyKvah: 1017 }),
      sample("m", "2026-07-13T00:45:00Z", { energyImportKwh: 1009, apparentEnergyKvah: 1022 }),
    ];
    const out = deriveMeterIntervals(rows, 30);
    expect(out).toHaveLength(2);

    // [00:00,00:30): 1005−1000 = 5 kWh (boundary at 00:30); demand = 5 / 0.5h = 10 kW.
    expect(out[0]?.intervalStart.toISOString()).toBe("2026-07-13T00:00:00.000Z");
    expect(out[0]?.activeEnergyKwh).toBe("5.000");
    expect(out[0]?.avgDemandKw).toBe("10.000");
    expect(out[0]?.apparentEnergyKvah).toBe("7.000"); // 1017−1010
    expect(out[0]?.avgDemandKva).toBe("14.000"); // 7 / 0.5h

    // [00:30,01:00): 1009−1005 = 4 kWh.
    expect(out[1]?.activeEnergyKwh).toBe("4.000");

    // Σ interval energy telescopes to the total register delta (1009−1000 = 9) — conserved.
    const total = out.reduce((s, iv) => s + Number(iv.activeEnergyKwh), 0);
    expect(total).toBeCloseTo(9, 3);
  });

  it("clamps a backwards register (rollover / reset) to 0 energy", () => {
    const rows = [
      sample("m", "2026-07-13T00:00:00Z", { energyImportKwh: 100 }),
      sample("m", "2026-07-13T00:20:00Z", { energyImportKwh: 50 }),
    ];
    const out = deriveMeterIntervals(rows, 30);
    expect(out).toHaveLength(1);
    expect(out[0]?.activeEnergyKwh).toBe("0.000");
  });

  it("emits only intervals that contain at least one sample (skips gaps)", () => {
    const rows = [
      sample("m", "2026-07-13T00:00:00Z", { energyImportKwh: 10 }),
      sample("m", "2026-07-13T00:10:00Z", { energyImportKwh: 12 }),
      // gap over the next few intervals, then a sample two hours later
      sample("m", "2026-07-13T02:05:00Z", { energyImportKwh: 30 }),
    ];
    const out = deriveMeterIntervals(rows, 30);
    expect(out.map((iv) => iv.intervalStart.toISOString())).toEqual([
      "2026-07-13T00:00:00.000Z",
      "2026-07-13T02:00:00.000Z",
    ]);
  });

  it("returns nothing for no samples", () => {
    expect(deriveMeterIntervals([], 30)).toEqual([]);
  });
});
