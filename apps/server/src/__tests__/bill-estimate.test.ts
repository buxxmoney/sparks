import { describe, expect, it } from "bun:test";
import {
  elapsedFraction,
  projectedTotalCents,
  resolveEstimatePeriod,
  usageFromIntervals,
} from "../bill-estimate";
import type { PricingBreakdown } from "../tariffs";

const utc = (y: number, mo: number, d: number, h = 0) => new Date(Date.UTC(y, mo - 1, d, h));

describe("resolveEstimatePeriod", () => {
  const now = utc(2026, 7, 25, 12);

  it("prefers a materialized period containing now", () => {
    const p = resolveEstimatePeriod(now, {
      containingPeriod: { periodStart: utc(2026, 7, 20), periodEnd: utc(2026, 8, 20) },
      policy: { recurrence: "day_of_month", anchorDay: 1 },
      latestInvoicePeriodEnd: utc(2026, 7, 10),
    });
    expect(p.basis).toBe("billing_period");
    expect(p.periodStart).toEqual(utc(2026, 7, 20));
    expect(p.periodEnd).toEqual(utc(2026, 8, 20));
  });

  it("falls back to the saved policy when no period contains now", () => {
    const p = resolveEstimatePeriod(now, {
      policy: { recurrence: "day_of_month", anchorDay: 15 },
      latestInvoicePeriodEnd: utc(2026, 7, 10),
    });
    expect(p.basis).toBe("policy");
    expect(p.periodStart).toEqual(utc(2026, 7, 15));
    expect(p.periodEnd).toEqual(utc(2026, 8, 15));
  });

  it("infers a day_of_month cycle from the latest invoice period end", () => {
    // Last invoice covered ...–Jul 24 ⇒ current period is Jul 24 – Aug 24.
    const p = resolveEstimatePeriod(now, { latestInvoicePeriodEnd: utc(2026, 7, 24) });
    expect(p.basis).toBe("inferred_from_invoice");
    expect(p.periodStart).toEqual(utc(2026, 7, 24));
    expect(p.periodEnd).toEqual(utc(2026, 8, 24));
  });

  it("ignores an invoice period ending in the future and defaults to the calendar month", () => {
    const p = resolveEstimatePeriod(now, { latestInvoicePeriodEnd: utc(2026, 8, 2) });
    expect(p.basis).toBe("calendar_month");
    expect(p.periodStart).toEqual(utc(2026, 7, 1));
    expect(p.periodEnd).toEqual(utc(2026, 8, 1));
  });

  it("defaults to the calendar month with nothing to go on", () => {
    const p = resolveEstimatePeriod(now, {});
    expect(p.basis).toBe("calendar_month");
    expect(p.periodStart).toEqual(utc(2026, 7, 1));
    expect(p.periodEnd).toEqual(utc(2026, 8, 1));
  });
});

describe("usageFromIntervals", () => {
  it("sums energy, counts gaps, and takes the peak from complete intervals only", () => {
    const usage = usageFromIntervals([
      {
        intervalStart: utc(2026, 7, 1, 0),
        activeEnergyKwh: "10.000",
        reactiveEnergyKvarh: "2.000",
        avgDemandKva: "20.000",
        isComplete: true,
      },
      {
        intervalStart: utc(2026, 7, 1, 1),
        activeEnergyKwh: "5.000",
        reactiveEnergyKvarh: null,
        // Boundary-gap interval with a bogus sky-high demand: must not set the peak.
        avgDemandKva: "999.000",
        isComplete: false,
      },
      {
        intervalStart: utc(2026, 7, 1, 2),
        activeEnergyKwh: null,
        reactiveEnergyKvarh: "1.500",
        avgDemandKva: "35.000",
        isComplete: true,
      },
    ]);
    expect(usage.activeEnergyKwh).toBe("15.000");
    expect(usage.reactiveEnergyKvarh).toBe("3.500");
    expect(usage.maxDemandKva).toBe("35.000");
    expect(usage.intervalCount).toBe(3);
    expect(usage.incompleteIntervals).toBe(1);
  });

  it("is all zeroes on no intervals", () => {
    const usage = usageFromIntervals([]);
    expect(usage.activeEnergyKwh).toBe("0.000");
    expect(usage.maxDemandKva).toBe("0.000");
    expect(usage.intervalCount).toBe(0);
  });
});

describe("elapsedFraction", () => {
  const period = { periodStart: utc(2026, 7, 1), periodEnd: utc(2026, 7, 31) };

  it("is the linear fraction of the period elapsed", () => {
    expect(elapsedFraction(period, utc(2026, 7, 16))).toBeCloseTo(0.5, 5);
  });

  it("clamps to [0, 1]", () => {
    expect(elapsedFraction(period, utc(2026, 6, 20))).toBe(0);
    expect(elapsedFraction(period, utc(2026, 8, 5))).toBe(1);
  });
});

describe("projectedTotalCents", () => {
  const breakdown: PricingBreakdown = {
    activeEnergyCents: 40_000,
    demandCents: 30_000,
    reactiveEnergyCents: 10_000,
    fixedCents: 5_000,
    ancillaryCents: 1_000,
    surchargeCents: 0,
    totalCents: 86_000,
    vatCents: 0,
    totalInclVatCents: 86_000,
    details: [],
  };

  it("scales consumption charges and holds period-level charges", () => {
    // Half the period elapsed: energy doubles, demand/fixed/ancillary stay.
    expect(projectedTotalCents(breakdown, 0.5)).toBe(100_000 + 36_000);
  });

  it("is the to-date total at period end", () => {
    expect(projectedTotalCents(breakdown, 1)).toBe(86_000);
  });

  it("declines to project in the first days of a period", () => {
    expect(projectedTotalCents(breakdown, 0.01)).toBeNull();
  });
});
