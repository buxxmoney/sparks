/**
 * CENTS-EXACT reproduction of Life Grand Cafe's (Mall of the South, unit F112,
 * meter ELON079925) landlord bills against the City Power "LV Demand Non-TOU"
 * tariff — the "JHB E LVD NON-TOU" lines on the Metronomic reading returns for
 * MAR 26, APR 26 and MAY 26. Every consumption figure and every expected Rand
 * amount below is transcribed from those bills; the REDEFINE rooftop-generation
 * lines are excluded (a separate landlord register our meter does not see).
 *
 * Tariff structure verified against:
 *  - City Power "Schedule of Approved Tariffs FY26/27" (1 Jul 2026): Industrial
 *    LV rate card (p5), 6c/kWh network surcharge (p7), and the Minimum Demand
 *    Charge Determination (p7): billed demand = greater of 70 kVA, measured
 *    demand, or 80% of the avg of the 3 highest demands in the rolling 12 months.
 *  - Eskom "Schedule of Standard Prices" (1 Apr 2026), tariff definitions ¶14:
 *    reactive energy is charged only in excess of 30% of kWh (0.96 PF).
 *  - The bills themselves for the FY25/26 rates used here (every FY26/27 rate is
 *    these +9.01%, confirming the tariff identification).
 *
 * NOTE on totals: Metronomic prints each line rounded to cents but sums the
 * UNROUNDED values into its subtotal, so a printed subtotal can drift ≤1c from
 * the printed lines (APR 26 does). We match every printed LINE exactly and
 * define the total as the sum of those lines.
 */
import { describe, expect, it } from "bun:test";
import { type TariffProfile, type UsageData, priceUsage } from "../tariffs";

/** City Power LV Demand Non-TOU, FY25/26 rates AS PUBLISHED (cents for c_per_*
 * units, Rand for r_per_*). Feb–May is the low-demand ("summer") season. */
const CITY_POWER_LVD_FY2526: TariffProfile = {
  touSchedule: {}, // non-TOU: no band maps; high season defaults to Jun–Aug
  rates: [
    // JHB E LVD NON-TOU ACTIVE ENERGY (summer). Winter (Jun–Aug) FY25/26 row
    // derived from FY26/27 ÷ 1.0901; unused by these summer-period bills.
    {
      chargeType: "active_energy",
      unit: "c_per_kwh",
      rateValue: 261.41,
      season: "low",
      touPeriod: "all",
    },
    {
      chargeType: "active_energy",
      unit: "c_per_kwh",
      rateValue: 306.23,
      season: "high",
      touPeriod: "all",
    },
    // JHB E LVD NON-TOU NETWORK DEMAND — R/kVA, all season.
    { chargeType: "demand", unit: "r_per_kva", rateValue: 423.1, season: "all", touPeriod: "all" },
    // JHB E LVD NON-TOU REACTIVE ENERGY — R/kVArh on the excess over 30% of kWh.
    {
      chargeType: "reactive_energy",
      unit: "c_per_kvarh",
      rateValue: 42.43,
      season: "all",
      touPeriod: "all",
    },
    // JHB E LVD NON-TOU NETWORK SURCH — 6c/kWh rider that stacks on the energy rate.
    {
      chargeType: "ancillary",
      unit: "c_per_kwh",
      rateValue: 6,
      season: "all",
      touPeriod: "all",
    },
    // JHB E LVD NON-TOU SERV + NETWORK — flat monthly charges.
    {
      chargeType: "fixed",
      unit: "r_per_month",
      rateValue: 1401.44,
      season: "all",
      touPeriod: "all",
    },
    {
      chargeType: "fixed",
      unit: "r_per_month",
      rateValue: 2140.13,
      season: "all",
      touPeriod: "all",
    },
  ],
  rules: {
    minDemandKva: 70, // City Power minimum demand (FY26/27 schedule p7)
    reactiveAllowanceFactorOfKwh: 0.3, // 0.96 PF allowance (Eskom defs ¶14)
    surchargeFractionOfSubtotal: 0.02, // JHB BUSINESS SURCH: 2c/R on the lines excl. the 6c rider
    vatFraction: 0.15,
  },
};

/** One synthetic interval carrying the month's kWh — enough for priceUsage to
 * resolve the season the way the live pipeline does from real intervals. */
function usageFor(billMonthUtc: Date, kwh: number, kvarh: number, measuredKva: number): UsageData {
  return {
    activeKwh: kwh,
    maxDemandKva: measuredKva,
    reactiveKvarh: kvarh,
    intervalStarts: [billMonthUtc],
    intervalActiveKwh: [kwh],
    timezone: "Africa/Johannesburg",
  };
}

describe("City Power LV Demand Non-TOU — bill-exact reproduction", () => {
  it("MAR 26 bill (20 Feb–23 Mar): every line to the cent", () => {
    // Meter readings on the bill: 11,554.332 kWh, 6,366.924 kVArh, 17.957 kVA measured.
    const p = priceUsage(
      usageFor(new Date(Date.UTC(2026, 2, 1)), 11554.332, 6366.924, 17.957),
      CITY_POWER_LVD_FY2526,
    );
    expect(p.activeEnergyCents).toBe(3_020_418); // ACTIVE ENERGY      R30,204.18
    expect(p.demandCents).toBe(2_961_700); //       NETWORK DEMAND     R29,617.00 (70 kVA floor, not 17.957)
    expect(p.billedDemandKva).toBe(70);
    expect(p.reactiveEnergyCents).toBe(123_073); // REACTIVE ENERGY    R1,230.73  (2,900.624 excess kVArh)
    expect(p.ancillaryCents).toBe(69_326); //       NETWORK SURCH      R693.26    (6c/kWh)
    expect(p.fixedCents).toBe(354_157); //          SERV + NETWORK     R1,401.44 + R2,140.13
    expect(p.surchargeCents).toBe(129_187); //      BUSINESS SURCH     R1,291.87  (2% of R64,593.48)
    expect(p.totalCents).toBe(6_657_861); //        tenant electricity R66,578.61 (bill subtotal minus REDEFINE gen)

    // The transparency contract: each line carries its arithmetic and rule.
    const demandLine = p.details.find((d) => d.chargeType === "demand");
    expect(demandLine?.quantity).toBe(70);
    expect(demandLine?.quantityUnit).toBe("kVA");
    expect(demandLine?.note).toContain("70 kVA");
    const reactiveLine = p.details.find((d) => d.chargeType === "reactive_energy");
    expect(reactiveLine?.quantity).toBeCloseTo(2900.6244, 3);
    expect(reactiveLine?.note).toContain("free allowance");
    const surchLine = p.details.find((d) => d.chargeType === "surcharge");
    expect(surchLine?.quantity).toBeCloseTo(64_593.48, 2);
  });

  it("APR 26 bill (23 Mar–23 Apr): every line to the cent", () => {
    // 11,658.153 kWh, 6,850.868 kVArh, 17.847 kVA measured.
    const p = priceUsage(
      usageFor(new Date(Date.UTC(2026, 3, 1)), 11658.153, 6850.868, 17.847),
      CITY_POWER_LVD_FY2526,
    );
    expect(p.activeEnergyCents).toBe(3_047_558); // R30,475.58
    expect(p.demandCents).toBe(2_961_700); //       R29,617.00 (70 kVA floor)
    expect(p.reactiveEnergyCents).toBe(142_286); // R1,422.86 (3,353.422 excess kVArh)
    expect(p.ancillaryCents).toBe(69_949); //       R699.49
    expect(p.fixedCents).toBe(354_157);
    expect(p.surchargeCents).toBe(130_114); //      R1,301.14 (2% of R65,057.01)
    // Sum of the printed lines. The bill's own subtotal is 1c lower because
    // Metronomic sums unrounded line values (see file header).
    expect(p.totalCents).toBe(6_705_764); //        R67,057.64
  });

  it("MAY 26 bill (23 Apr–22 May): every line to the cent, incl. VAT", () => {
    // 10,223.157 kWh, 4,959.141 kVArh, 17.847 kVA measured.
    const p = priceUsage(
      usageFor(new Date(Date.UTC(2026, 4, 1)), 10223.157, 4959.141, 17.847),
      CITY_POWER_LVD_FY2526,
    );
    expect(p.activeEnergyCents).toBe(2_672_435); // R26,724.35
    expect(p.demandCents).toBe(2_961_700); //       R29,617.00 (70 kVA floor)
    expect(p.reactiveEnergyCents).toBe(80_286); //  R802.86 (1,892.194 excess kVArh)
    expect(p.ancillaryCents).toBe(61_339); //       R613.39
    expect(p.fixedCents).toBe(354_157);
    expect(p.surchargeCents).toBe(121_372); //      R1,213.72 (2% of R60,685.78)
    expect(p.totalCents).toBe(6_251_289); //        R62,512.89 = bill's R65,200.26 minus REDEFINE gen R2,687.37
    expect(p.vatCents).toBe(937_693); //            15% VAT on the ex-VAT total
    expect(p.totalInclVatCents).toBe(7_188_982);
  });

  it("charges the measured peak when it exceeds the 70 kVA floor", () => {
    const p = priceUsage(
      usageFor(new Date(Date.UTC(2026, 4, 1)), 10000, 3000, 85.5),
      CITY_POWER_LVD_FY2526,
    );
    expect(p.billedDemandKva).toBe(85.5);
    expect(p.demandCents).toBe(Math.round(85.5 * 423.1 * 100));
  });

  it("bills zero reactive energy at power factor better than 0.96", () => {
    // kvarh below 30% of kWh ⇒ fully inside the free allowance.
    const p = priceUsage(
      usageFor(new Date(Date.UTC(2026, 4, 1)), 10000, 2999, 17),
      CITY_POWER_LVD_FY2526,
    );
    expect(p.reactiveEnergyCents).toBe(0);
  });

  it("prices a July (winter/high season) month at the winter energy rate", () => {
    const p = priceUsage(
      usageFor(new Date(Date.UTC(2026, 6, 15)), 1000, 0, 17),
      CITY_POWER_LVD_FY2526,
    );
    expect(p.activeEnergyCents).toBe(306_230); // 1,000 kWh × 306.23 c/kWh
  });
});

describe("Eskom-style rules the CoJ profile doesn't use", () => {
  it("accrues r_per_day charges by the period's day count", () => {
    // Eskom service/administration charges are R/POD/day (schedule defs ¶12–13).
    const profile: TariffProfile = {
      rates: [
        {
          chargeType: "fixed",
          unit: "r_per_day",
          rateValue: 14.94,
          season: "all",
          touPeriod: "all",
        },
      ],
      rules: {},
    };
    const p = priceUsage(
      { activeKwh: 0, maxDemandKva: 0, reactiveKvarh: 0, periodDays: 28 },
      profile,
    );
    expect(p.fixedCents).toBe(Math.round(14.94 * 28 * 100)); // R418.32
  });

  it("waives reactive charges outside the high-demand season when the Eskom rule is set", () => {
    const profile: TariffProfile = {
      rates: [
        {
          chargeType: "reactive_energy",
          unit: "c_per_kvarh",
          rateValue: 42.43,
          season: "all",
          touPeriod: "all",
        },
      ],
      rules: { reactiveAllowanceFactorOfKwh: 0.3, reactiveHighSeasonOnly: true },
    };
    const summer = priceUsage(usageForMonth(new Date(Date.UTC(2026, 4, 1))), profile);
    expect(summer.reactiveEnergyCents).toBe(0); // May = low season ⇒ waived
    const winter = priceUsage(usageForMonth(new Date(Date.UTC(2026, 6, 1))), profile);
    expect(winter.reactiveEnergyCents).toBe(Math.round((5000 - 0.3 * 10000) * (42.43 / 100) * 100));
  });
});

function usageForMonth(month: Date): UsageData {
  return {
    activeKwh: 10000,
    maxDemandKva: 20,
    reactiveKvarh: 5000,
    intervalStarts: [month],
    intervalActiveKwh: [10000],
    timezone: "Africa/Johannesburg",
  };
}
