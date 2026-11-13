/**
 * Customer-facing bill itemisation: `billLines` over a `PricingBreakdown`, and the
 * provenance `convertTariff` attaches so each line can name and cite itself.
 *
 * The invariant these guard: a customer must be able to account for every cent of
 * the headline total from the lines shown. Both halves are pure, so the whole path
 * is testable without a database.
 */
import { describe, expect, it } from "bun:test";
import { type CojSchedule, convertTariff } from "../tariff-import";
import {
  SQL_BOUNDARY_SNAP_SECONDS,
  SQL_MATERIALIZE_INTERVALS,
} from "../live-readings";
import { billLines, priceUsage } from "../tariffs";

const schedule = (await Bun.file(
  new URL("../../../../tariffs/2026/2027-COJ.json", import.meta.url),
).json()) as CojSchedule;

/** A month of half-hourly intervals on a flat load, in the low (summer) season. */
function septemberUsage(kwPerInterval: number) {
  const starts: Date[] = [];
  const kwh: number[] = [];
  for (let day = 1; day <= 20; day++) {
    for (let half = 0; half < 48; half++) {
      starts.push(new Date(Date.UTC(2026, 8, day, Math.floor(half / 2), (half % 2) * 30)));
      kwh.push(kwPerInterval / 2);
    }
  }
  return {
    activeKwh: kwh.reduce((sum, k) => sum + k, 0),
    maxDemandKva: 91.2,
    reactiveKvarh: 2_400,
    intervalStarts: starts,
    intervalActiveKwh: kwh,
    timezone: "Africa/Johannesburg",
  };
}

describe("SQL interval materialisation", () => {
  // The SQL in live-readings mirrors `deriveMeterIntervals`. These lock the two
  // pieces that were wrong in earlier drafts and would silently misbill:
  //   - boundary snapping (a meter stamps :30 as :30:00.001; missing that sample
  //     under-read peak demand by 0.3%, ~R49 on one period at R461/kVA)
  //   - telescoping across bucket boundaries (energy lost between the last sample
  //     of one interval and the first of the next understated energy by 3.3%)
  it("keeps the boundary-snap tolerance below the sampling cadence", () => {
    // The snap must be far larger than millisecond jitter yet far smaller than
    // the ~60s cadence, or it reaches into the next real sample and pulls a
    // later interval's energy (or a meter reset) into this one.
    expect(SQL_BOUNDARY_SNAP_SECONDS).toBeGreaterThan(0.1);
    expect(SQL_BOUNDARY_SNAP_SECONDS).toBeLessThan(30);
  });

  it("snaps buckets back by the tolerance so a late boundary sample anchors its own interval", () => {
    // The SQL floors (measured_at - snap) into buckets. A sample at 10:30:00.001
    // must therefore land in the 10:30 bucket, not 10:00.
    expect(SQL_MATERIALIZE_INTERVALS).toContain("make_interval(secs => $5)");
    // And energy must come from the PREVIOUS bucket's closing register, which is
    // what conserves energy across the boundary.
    expect(SQL_MATERIALIZE_INTERVALS).toContain("lag(k_end) over w");
  });

  it("never writes negative energy from a meter reset", () => {
    // A cumulative register going backwards is a rollover, not negative usage.
    expect(SQL_MATERIALIZE_INTERVALS).toContain("greatest(kwh,   0)");
    expect(SQL_MATERIALIZE_INTERVALS).toContain("greatest(kvarh, 0)");
  });

  it("is idempotent, so re-materialising a window cannot double-count", () => {
    expect(SQL_MATERIALIZE_INTERVALS).toContain("on conflict");
    expect(SQL_MATERIALIZE_INTERVALS).toContain("do update set");
  });
});

describe("rate units", () => {
  // The bug this guards: `priceUsage` used to multiply `rateValue` directly and
  // assume Rand, while the DB stores the PUBLISHED figure tagged with its unit
  // ("284.96" + c_per_kwh). Every cents-denominated rate priced 100x too high —
  // R1.6m instead of R35k on a real two-week period. See .claude/decisions.md.
  it("reads a cents-denominated rate as cents, not Rand", () => {
    const profile = {
      rates: [
        {
          chargeType: "active_energy" as const,
          unit: "c_per_kwh" as const,
          rateValue: 284.96, // as published, and as stored in tariff_rates
          season: "all" as const,
          touPeriod: "all" as const,
        },
      ],
    };
    // 100 kWh at 284.96 c/kWh = R284.96 = 28 496 cents.
    const priced = priceUsage(
      { activeKwh: 100, maxDemandKva: 0, reactiveKvarh: 0 },
      profile,
    );
    expect(priced.activeEnergyCents).toBe(28_496);
  });

  it("leaves Rand-denominated rates alone", () => {
    const profile = {
      rates: [
        {
          chargeType: "demand" as const,
          unit: "r_per_kva" as const,
          rateValue: 461.22,
          season: "all" as const,
          touPeriod: "all" as const,
        },
        {
          chargeType: "fixed" as const,
          unit: "r_per_month" as const,
          rateValue: 1_527.71,
          season: "all" as const,
          touPeriod: "all" as const,
        },
      ],
    };
    const priced = priceUsage(
      { activeKwh: 0, maxDemandKva: 70, reactiveKvarh: 0 },
      profile,
    );
    expect(priced.demandCents).toBe(Math.round(70 * 461.22 * 100));
    expect(priced.fixedCents).toBe(152_771);
  });

  it("shows the published figure verbatim on the bill line", () => {
    const profile = {
      rates: [
        {
          chargeType: "reactive_energy" as const,
          unit: "c_per_kvarh" as const,
          rateValue: 46.25,
          season: "all" as const,
          touPeriod: "all" as const,
          label: "Reactive energy",
        },
      ],
    };
    const [line] = billLines(
      priceUsage({ activeKwh: 0, maxDemandKva: 0, reactiveKvarh: 1_000 }, profile),
    );
    // The customer must be able to find this exact number in the schedule.
    expect(line.rateDisplay).toBe("46.25 c/kVArh");
    expect(line.amountCents).toBe(46_250); // 1 000 kVArh x 46.25c = R462.50
  });
});

describe("block tariffs across a season boundary", () => {
  // COJ publishes a full block ladder per season, and states thresholds are per
  // CALENDAR MONTH ("Consumption block kWh/month"). Both season boundaries —
  // 31 August and 31 May — are month ends, so restarting the ladder at the
  // boundary IS the per-month rule rather than a departure from it. A single
  // ladder across the period was tried and reverted: it overcharges by denying a
  // first block the schedule grants each month. See .claude/decisions.md.
  const seasonalBlocks = {
    rates: [
      { chargeType: "active_energy" as const, unit: "c_per_kwh" as const, rateValue: 100, season: "low" as const, touPeriod: "all" as const, blockThresholdKwh: 500, label: "Summer block 1" },
      { chargeType: "active_energy" as const, unit: "c_per_kwh" as const, rateValue: 200, season: "low" as const, touPeriod: "all" as const, label: "Summer block 2" },
      { chargeType: "active_energy" as const, unit: "c_per_kwh" as const, rateValue: 300, season: "high" as const, touPeriod: "all" as const, blockThresholdKwh: 500, label: "Winter block 1" },
      { chargeType: "active_energy" as const, unit: "c_per_kwh" as const, rateValue: 400, season: "high" as const, touPeriod: "all" as const, label: "Winter block 2" },
    ],
  };

  /** Half the energy in winter (late August), half in summer (early September). */
  function straddling(totalKwh: number) {
    const starts: Date[] = [];
    const kwh: number[] = [];
    for (let d = 20; d <= 31; d++) { starts.push(new Date(Date.UTC(2026, 7, d, 10))); kwh.push(totalKwh / 24); }
    for (let d = 1; d <= 12; d++) { starts.push(new Date(Date.UTC(2026, 8, d, 10))); kwh.push(totalKwh / 24); }
    return {
      activeKwh: kwh.reduce((s, k) => s + k, 0),
      maxDemandKva: 0,
      reactiveKvarh: 0,
      intervalStarts: starts,
      intervalActiveKwh: kwh,
      timezone: "Africa/Johannesburg",
    };
  }

  it("tiers each side of the season boundary against its own month's blocks", () => {
    // 1 000 kWh split evenly: 500 in winter, 500 in summer. Each side is its own
    // calendar month, so each fills its own block 1 exactly.
    const priced = priceUsage(straddling(1_000), seasonalBlocks);
    const expected = Math.round((500 * 1 + 500 * 3) * 100); // summer b1 + winter b1
    expect(priced.activeEnergyCents).toBe(expected);
  });

  it("charges every kWh exactly once across the boundary", () => {
    const priced = priceUsage(straddling(1_000), seasonalBlocks);
    const qty = priced.details.reduce((s, d) => s + (d.quantity ?? 0), 0);
    expect(qty).toBeCloseTo(1_000, 6);
  });

  it("still escalates into higher blocks within one season", () => {
    // 2 000 kWh: 1 000 per side, so each side's block 1 (500) fills and the
    // remainder spills into block 2 — the ladder is not disabled, only restarted
    // at the month/season boundary.
    const priced = priceUsage(straddling(2_000), seasonalBlocks);
    const expected = Math.round((500 * 1 + 500 * 2 + 500 * 3 + 500 * 4) * 100);
    expect(priced.activeEnergyCents).toBe(expected);
  });
});

describe("percentage surcharge", () => {
  // Industrial LV FY26/27 shape, in published units.
  const base = {
    rates: [
      { chargeType: "active_energy" as const, unit: "c_per_kwh" as const, rateValue: 284.96, season: "all" as const, touPeriod: "all" as const, label: "Energy" },
      { chargeType: "demand" as const, unit: "r_per_kva" as const, rateValue: 461.22, season: "all" as const, touPeriod: "all" as const, label: "Demand" },
      { chargeType: "fixed" as const, unit: "r_per_month" as const, rateValue: 1_527.71, season: "all" as const, touPeriod: "all" as const, label: "Service charge" },
      // Rides on top of the tariff, so it must not inflate the 2% base.
      { chargeType: "ancillary" as const, unit: "c_per_kwh" as const, rateValue: 6, season: "all" as const, touPeriod: "all" as const, label: "Network surcharge", inSurchargeBase: false },
    ],
    surcharges: [
      { id: "business_lpu_2pct_surcharge", ratePercent: 2, enabled: true, basis: "all_tariff_charges" as const, label: "2% business surcharge" },
    ],
  };
  const usage = { activeKwh: 1_000, maxDemandKva: 70, reactiveKvarh: 0 };

  it("levies the percentage on tariff charges only, excluding the network surcharge", () => {
    const priced = priceUsage(usage, base);
    const energy = Math.round(1_000 * 2.8496 * 100);     // R2 849.60
    const demand = Math.round(70 * 461.22 * 100);        // R32 285.40
    const fixed = Math.round(1_527.71 * 100);            // R1 527.71
    const network = Math.round(1_000 * 0.06 * 100);      // R60.00 — excluded

    const expectedSurcharge = Math.round((energy + demand + fixed) * 0.02);
    // The surcharge sits in ancillary alongside the network surcharge.
    expect(priced.ancillaryCents).toBe(network + expectedSurcharge);

    // Proof it excluded the network surcharge: including it would cost more.
    const ifIncluded = Math.round((energy + demand + fixed + network) * 0.02);
    expect(expectedSurcharge).toBeLessThan(ifIncluded);
  });

  it("computes the base from ROUNDED line items, so a customer can reproduce it", () => {
    const priced = priceUsage(usage, base);
    const line = billLines(priced).find((l) => l.label === "2% business surcharge");
    expect(line).toBeDefined();
    // The line reports the Rand base it was applied to, and 2% of it is the amount.
    expect(Math.round((line?.quantity ?? 0) * 100 * 0.02)).toBe(line?.amountCents ?? 0);
    expect(line?.rateDisplay).toBe("2% of charges");
  });

  it("refuses to apply an enabled surcharge with no stated basis", () => {
    // The source documents never say what the 2% is levied on. Guessing would
    // silently produce a wrong bill, so this must fail loudly.
    const bad = {
      ...base,
      surcharges: [{ id: "unclear", ratePercent: 2, enabled: true, basis: null }],
    };
    expect(() => priceUsage(usage, bad)).toThrow(/basis/i);
  });

  it("ignores a disabled surcharge", () => {
    const off = {
      ...base,
      surcharges: [{ ...base.surcharges[0], enabled: false }],
    };
    const priced = priceUsage(usage, off);
    // Only the network surcharge remains in ancillary.
    expect(priced.ancillaryCents).toBe(Math.round(1_000 * 0.06 * 100));
  });
});

describe("billLines", () => {
  it("itemises a block tariff so the lines sum to the total", () => {
    const tariff = convertTariff(schedule, "business_conventional_prepaid");
    const pricing = priceUsage(septemberUsage(60), tariff.profile);
    const lines = billLines(pricing);

    // The headline figure must be fully accounted for by what the customer is shown.
    const sum = lines.reduce((total, l) => total + l.amountCents, 0);
    expect(sum).toBe(pricing.totalCents);

    // Every line names itself and cites where its rate came from — no line may
    // render as an unattributable amount. The citation differs per line: rate rows
    // cite the FY26/27 schedule, the 2% surcharge cites the annexure that imposes
    // it, so the assertion is that a source EXISTS and is substantive.
    for (const line of lines) {
      expect(line.label.length).toBeGreaterThan(0);
      expect(line.source?.length ?? 0).toBeGreaterThan(20);
    }
  });

  it("labels each consumption block with its own range and published rate", () => {
    const tariff = convertTariff(schedule, "business_conventional_prepaid");
    const pricing = priceUsage(septemberUsage(60), tariff.profile);
    const lines = billLines(pricing);

    const block1 = lines.find((l) => l.label.includes("Block 1"));
    expect(block1).toBeDefined();
    // Blocks are per-season; summer block 1 is the first 500 kWh at 380.52 c/kWh.
    expect(block1?.label).toBe("Summer · Block 1: 1-500 kWh");
    expect(block1?.rateDisplay).toBe("380.52 c/kWh");
    expect(block1?.quantity).toBe(500);
    expect(block1?.quantityUnit).toBe("kWh");
    // The arithmetic the UI prints must actually hold: quantity x rate = amount.
    expect(block1?.amountCents).toBe(Math.round(500 * 3.8052 * 100));
  });

  it("charges flat lines with no quantity, and names them from the schedule", () => {
    const tariff = convertTariff(schedule, "business_conventional_prepaid");
    const pricing = priceUsage(septemberUsage(60), tariff.profile);
    const lines = billLines(pricing);

    const service = lines.find((l) => l.label === "Service charge");
    expect(service).toBeDefined();
    // A fixed charge bills the same regardless of usage, so it carries no quantity —
    // showing one would imply the amount scales with consumption.
    expect(service?.quantity).toBeNull();
    expect(service?.quantityUnit).toBeNull();
    expect(service?.rateDisplay).toBe("R 890.45/month");
  });

  it("splits a TOU tariff into one line per period, plus demand", () => {
    const tariff = convertTariff(schedule, "industrial_lv_tou");
    const pricing = priceUsage(septemberUsage(60), tariff.profile);
    const lines = billLines(pricing);

    const energy = lines.filter((l) => l.group === "active_energy");
    const periods = energy.map((l) => l.touPeriod).sort();
    expect(periods).toEqual(["offpeak", "peak", "standard"]);

    // Demand is charged on the peak interval, in kVA — not on total energy.
    const demand = lines.find((l) => l.group === "demand");
    expect(demand?.quantityUnit).toBe("kVA");
    expect(demand?.quantity).toBe(91.2);
    expect(demand?.rateDisplay).toBe("R 461.28/kVA");

    expect(lines.reduce((total, l) => total + l.amountCents, 0)).toBe(pricing.totalCents);
  });

  it("groups lines in invoice order: energy, demand, then fixed charges", () => {
    const tariff = convertTariff(schedule, "industrial_lv_tou");
    const pricing = priceUsage(septemberUsage(60), tariff.profile);
    const groups = billLines(pricing).map((l) => l.group);

    // Each group's lines must be contiguous, so the UI can render sections without
    // reordering (and thus without restating) what the server sent.
    expect(groups.indexOf("demand")).toBeGreaterThan(groups.lastIndexOf("active_energy"));
    expect(groups.indexOf("fixed")).toBeGreaterThan(groups.lastIndexOf("demand"));
  });

  it("reports the charges it does not apply, rather than omitting them silently", () => {
    // Residential keeps a genuine gap: the network surcharge exempts the first
    // 500 kWh/month, a marginal allowance a flat rate row cannot express, so it is
    // omitted and must say so (rules.md 21a).
    const residential = convertTariff(schedule, "residential_single_phase_60a");
    expect(residential.unsupported.map((u) => u.rule)).toContain(
      "network_surcharge_residential_exemption",
    );
  });

  it("applies the network surcharge and the 2% business surcharge", () => {
    const tariff = convertTariff(schedule, "business_conventional_prepaid");

    // The 6 c/kWh network surcharge is now a real per-kWh line...
    const network = tariff.profile.rates.find((r) => r.label === "Network surcharge");
    expect(network).toBeDefined();
    expect(network?.unit).toBe("c_per_kwh");
    expect(network?.rateValue).toBe(6);
    // ...deliberately OUTSIDE the 2% base: City Power levies the percentage on the
    // tariff's own charges, then adds the network surcharge on top.
    expect(network?.inSurchargeBase).toBe(false);

    const surcharge = tariff.profile.surcharges?.[0];
    expect(surcharge?.ratePercent).toBe(2);
    expect(surcharge?.enabled).toBe(true);
    expect(surcharge?.basis).toBe("all_tariff_charges");

    // Neither is reported as missing any more — they are applied.
    const rules = tariff.unsupported.map((u) => u.rule);
    expect(rules).not.toContain("network_surcharge");
    expect(rules).not.toContain("business_lpu_2pct_surcharge");
  });

  it("does not levy the business surcharge on residential or agricultural tariffs", () => {
    for (const id of ["residential_single_phase_60a", "agriculture"]) {
      const t = convertTariff(schedule, id);
      expect(t.profile.surcharges ?? []).toHaveLength(0);
    }
  });
});

describe("minimum demand floor", () => {
  // Industrial LV FY26/27: R461.22/kVA, 70 kVA floor.
  const industrial = {
    rates: [
      {
        chargeType: "demand" as const,
        unit: "r_per_kva" as const,
        rateValue: 461.22,
        season: "all" as const,
        touPeriod: "all" as const,
        label: "Demand",
      },
    ],
    minimumDemandKva: 70,
  };

  it("bills the floor when measured demand falls below it", () => {
    // 40 kVA measured, but the tariff floors billed demand at 70.
    const priced = priceUsage({ activeKwh: 0, maxDemandKva: 40, reactiveKvarh: 0 }, industrial);
    expect(priced.demandCents).toBe(Math.round(70 * 461.22 * 100));
  });

  it("bills measured demand when it exceeds the floor", () => {
    const priced = priceUsage({ activeKwh: 0, maxDemandKva: 120, reactiveKvarh: 0 }, industrial);
    expect(priced.demandCents).toBe(Math.round(120 * 461.22 * 100));
  });

  it("bills the floor for a period with no measured demand at all", () => {
    // The floor is the point: a quiet month still owes the minimum.
    const priced = priceUsage({ activeKwh: 0, maxDemandKva: 0, reactiveKvarh: 0 }, industrial);
    expect(priced.demandCents).toBe(Math.round(70 * 461.22 * 100));
  });

  it("leaves tariffs without a floor billing raw measured demand", () => {
    const noFloor = { rates: industrial.rates };
    const priced = priceUsage({ activeKwh: 0, maxDemandKva: 40, reactiveKvarh: 0 }, noFloor);
    expect(priced.demandCents).toBe(Math.round(40 * 461.22 * 100));
  });

  it("applies the floor to per-kVA capacity charges too", () => {
    // A capacity charge stored as an ancillary r_per_kva rides on the same
    // billed demand as the demand charge itself.
    const withCapacity = {
      rates: [
        {
          chargeType: "ancillary" as const,
          unit: "r_per_kva" as const,
          rateValue: 10,
          season: "all" as const,
          touPeriod: "all" as const,
          label: "Capacity",
        },
      ],
      minimumDemandKva: 70,
    };
    const priced = priceUsage({ activeKwh: 0, maxDemandKva: 40, reactiveKvarh: 0 }, withCapacity);
    expect(priced.ancillaryCents).toBe(Math.round(70 * 10 * 100));
  });

  it("reports the floored quantity on the line item, not the measured one", () => {
    // The breakdown must show what was actually billed, or the customer cannot
    // reconcile the demand line against the rate.
    const lines = billLines(
      priceUsage({ activeKwh: 0, maxDemandKva: 40, reactiveKvarh: 0 }, industrial),
    );
    const demand = lines.find((l) => l.group === "demand");
    expect(demand?.quantity).toBeCloseTo(70, 6);
  });
});

describe("VAT", () => {
  const flat = (vatFraction?: number) => ({
    rates: [
      {
        chargeType: "active_energy" as const,
        unit: "c_per_kwh" as const,
        rateValue: 100,
        season: "all" as const,
        touPeriod: "all" as const,
        label: "Energy",
      },
    ],
    ...(vatFraction !== undefined ? { vatFraction } : {}),
  });

  it("adds 15% VAT on top of the charge total", () => {
    // 100 kWh at 100 c/kWh = R100.00 = 10 000 cents.
    const priced = priceUsage({ activeKwh: 100, maxDemandKva: 0, reactiveKvarh: 0 }, flat(0.15));
    expect(priced.totalCents).toBe(10_000);
    expect(priced.vatCents).toBe(1_500);
    expect(priced.totalInclVatCents).toBe(11_500);
  });

  it("leaves the charge total VAT-exclusive so line items still reconcile", () => {
    const priced = priceUsage({ activeKwh: 100, maxDemandKva: 0, reactiveKvarh: 0 }, flat(0.15));
    const lineSum = priced.details.reduce((a, d) => a + d.amountCents, 0);
    expect(lineSum).toBe(priced.totalCents);
  });

  it("charges no VAT when the tariff defines none", () => {
    const priced = priceUsage({ activeKwh: 100, maxDemandKva: 0, reactiveKvarh: 0 }, flat());
    expect(priced.vatCents).toBe(0);
    expect(priced.totalInclVatCents).toBe(priced.totalCents);
  });

  it("rounds VAT once over the total, not per line", () => {
    // Three lines whose individual VAT amounts would each round up; rounding per
    // line and summing would overstate the VAT by a cent.
    const threeLines = {
      rates: [1, 1, 1].map((_, i) => ({
        chargeType: "ancillary" as const,
        unit: "r_per_month" as const,
        rateValue: 0.03,
        season: "all" as const,
        touPeriod: "all" as const,
        label: `Fee ${i + 1}`,
      })),
      vatFraction: 0.15,
    };
    const priced = priceUsage({ activeKwh: 0, maxDemandKva: 0, reactiveKvarh: 0 }, threeLines);
    // Total 9 cents; 15% = 1.35 -> 1 cent. Per-line would be 3 x round(0.45) = 0.
    expect(priced.totalCents).toBe(9);
    expect(priced.vatCents).toBe(1);
  });
});
