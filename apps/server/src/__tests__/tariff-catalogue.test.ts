/**
 * The published-tariff catalogue: listing what an operator can pick, and shaping a
 * pick into the rows the database stores. Pure, so no database is needed.
 */
import { describe, expect, it } from "bun:test";
import { catalogueProfileRows, listCatalogue, loadSchedules } from "../tariff-catalogue";
import { convertTariff } from "../tariff-import";
import { type TariffProfile, type TariffRate, priceUsage } from "../tariffs";

const schedules = loadSchedules();

/**
 * Rebuild a priceable profile from stored rows the way `buildTariffProfile` does,
 * so the test exercises the same round trip a real bill goes through.
 */
function profileFromRows(rows: ReturnType<typeof catalogueProfileRows>): TariffProfile {
  const fraction = rows.profile.pricingRules.surchargeFractionOfSubtotal;
  return {
    touSchedule: rows.profile.touSchedule,
    rates: rows.rates.map(
      (r): TariffRate => ({
        chargeType: r.chargeType,
        unit: r.unit,
        rateValue: Number(r.rateValue),
        season: r.season,
        touPeriod: r.touPeriod,
        blockThresholdKwh: r.blockThresholdKwh ? Number(r.blockThresholdKwh) : undefined,
        ...(r.chargeType === "ancillary" && r.unit === "c_per_kwh"
          ? { inSurchargeBase: false }
          : {}),
      }),
    ),
    ...(fraction
      ? {
          surcharges: [
            {
              id: "percentage_surcharge",
              ratePercent: fraction * 100,
              enabled: true,
              basis: "all_tariff_charges" as const,
            },
          ],
        }
      : {}),
    ...(rows.profile.pricingRules.minDemandKva
      ? { minimumDemandKva: rows.profile.pricingRules.minDemandKva }
      : {}),
    vatFraction: rows.profile.pricingRules.vatFraction,
  };
}

/** A November (summer) fortnight of half-hourly intervals at a flat load. */
function novemberUsage(kwhPerInterval: number) {
  const intervalStarts: Date[] = [];
  const intervalActiveKwh: number[] = [];
  for (let day = 1; day <= 14; day++) {
    for (let slot = 0; slot < 48; slot++) {
      intervalStarts.push(new Date(Date.UTC(2026, 10, day, 0, slot * 30)));
      intervalActiveKwh.push(kwhPerInterval);
    }
  }
  const activeKwh = intervalActiveKwh.reduce((a, b) => a + b, 0);
  return {
    activeKwh,
    reactiveKvarh: activeKwh * 0.5,
    maxDemandKva: 30,
    intervalStarts,
    intervalActiveKwh,
    timezone: "Africa/Johannesburg",
  };
}

describe("tariff catalogue", () => {
  it("lists every tariff in the schedule under its stored name", () => {
    const entries = listCatalogue(schedules);
    expect(entries.length).toBe(schedules[0].tariffs.length);
    const business = entries.find((e) => e.tariffId === "business_conventional_prepaid");
    expect(business?.name).toBe("City Power Business Conventional/Prepaid FY26/27");
    expect(business?.category).toBe("business");
  });

  it("stores the business tariff's seasonal blocks, fixed charges and levies", () => {
    const rows = catalogueProfileRows(schedules, "business_conventional_prepaid");
    const energy = rows.rates.filter((r) => r.chargeType === "active_energy");
    // Five blocks for each of the two seasons; the top block of each is unbounded.
    expect(energy.length).toBe(10);
    expect(energy.filter((r) => r.blockThresholdKwh === null).length).toBe(2);
    expect(rows.rates.filter((r) => r.chargeType === "fixed").map((r) => r.rateValue)).toEqual([
      "890.45",
      "853.72",
    ]);
    // No demand charge on the business tariff, and so no minimum-demand floor.
    expect(rows.rates.some((r) => r.chargeType === "demand")).toBe(false);
    expect(rows.profile.pricingRules.minDemandKva).toBeUndefined();
    expect(rows.profile.pricingRules.surchargeFractionOfSubtotal).toBe(0.02);
    expect(rows.profile.pricingRules.vatFraction).toBe(0.15);
    expect(rows.profile.effectiveFrom.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("prices identically from stored rows and from the schedule", () => {
    for (const tariffId of ["business_conventional_prepaid", "industrial_lv", "industrial_lv_tou"]) {
      const usage = novemberUsage(5.5);
      const fromRows = priceUsage(usage, profileFromRows(catalogueProfileRows(schedules, tariffId)));
      const fromSchedule = priceUsage(usage, convertTariff(schedules[0], tariffId).profile);
      expect(fromRows.totalCents).toBe(fromSchedule.totalCents);
      expect(fromRows.totalCents).toBeGreaterThan(0);
    }
  });

  it("rejects a tariff that is not in the schedule", () => {
    expect(() => catalogueProfileRows(schedules, "no_such_tariff")).toThrow();
  });
});

describe("how much a tariff needs read", () => {
  it("prices block and seasonal tariffs from totals, and only TOU from intervals", () => {
    const { tariffNeedsDemand, tariffNeedsIntervals } = require("../tariffs");
    const profile = (id: string) => profileFromRows(catalogueProfileRows(schedules, id));
    expect(tariffNeedsIntervals(profile("business_conventional_prepaid"))).toBe(false);
    expect(tariffNeedsDemand(profile("business_conventional_prepaid"))).toBe(false);
    expect(tariffNeedsIntervals(profile("industrial_lv"))).toBe(false);
    expect(tariffNeedsDemand(profile("industrial_lv"))).toBe(true);
    expect(tariffNeedsIntervals(profile("industrial_lv_tou"))).toBe(true);
  });

  it("pricing a period as season pieces equals pricing its half-hours", () => {
    // A 23 Aug → 23 Sep period straddles the winter→summer boundary on 1 Sep.
    const starts: Date[] = [];
    const kwh: number[] = [];
    for (let t = Date.UTC(2026, 7, 22, 22); t < Date.UTC(2026, 8, 22, 22); t += 30 * 60_000) {
      starts.push(new Date(t));
      kwh.push(7.25);
    }
    const cut = Date.UTC(2026, 7, 31, 22); // 1 Sep 00:00 SAST
    const winter = kwh.filter((_, i) => starts[i].getTime() < cut).reduce((a, b) => a + b, 0);
    const summer = kwh.reduce((a, b) => a + b, 0) - winter;
    const base = { reactiveKvarh: 0, maxDemandKva: 0, timezone: "Africa/Johannesburg" };
    const p = profileFromRows(catalogueProfileRows(schedules, "business_conventional_prepaid"));
    const byInterval = priceUsage(
      { ...base, activeKwh: winter + summer, intervalStarts: starts, intervalActiveKwh: kwh },
      p,
    );
    const byPieces = priceUsage(
      {
        ...base,
        activeKwh: winter + summer,
        intervalStarts: [starts[0], new Date(cut)],
        intervalActiveKwh: [winter, summer],
      },
      p,
    );
    expect(byPieces.totalCents).toBe(byInterval.totalCents);
  });
});

describe("calendarWindows", () => {
  it("enumerates local-month buckets and clips the first to the requested start", () => {
    const { calendarWindows } = require("../live-readings");
    const w = calendarWindows(
      new Date("2026-08-22T22:00:00Z"),
      new Date("2026-09-22T22:00:00Z"),
      "month",
      "Africa/Johannesburg",
    );
    expect(w.length).toBe(2);
    expect(w[0].from.toISOString()).toBe("2026-08-22T22:00:00.000Z");
    expect(w[0].periodEnd.toISOString()).toBe("2026-08-31T22:00:00.000Z");
    expect(w[1].periodStart.toISOString()).toBe("2026-08-31T22:00:00.000Z");
  });
});
