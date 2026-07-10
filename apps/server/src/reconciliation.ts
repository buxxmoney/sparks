import type { BillingPeriod } from "@sparks/db";
import { type PricingBreakdown, type TariffProfile, type UsageData, priceUsage } from "./tariffs";

/** A zero-filled pricing breakdown (no charges). */
export function emptyBreakdown(): PricingBreakdown {
  return {
    activeEnergyCents: 0,
    demandCents: 0,
    reactiveEnergyCents: 0,
    fixedCents: 0,
    ancillaryCents: 0,
    totalCents: 0,
    details: [],
  };
}

/**
 * Price a period that may be split across several effective-dated tariff
 * segments (e.g. a billing period crossing a tariff change). PURE.
 *
 * Per-CONSUMPTION charges (active + reactive energy) accumulate across segments — each
 * slice's usage is priced under its own tariff and summed. Period-LEVEL charges are
 * applied EXACTLY ONCE for the whole period, never per segment (which would double-count
 * a monthly service fee or demand charge on a period that crosses a tariff change):
 *  - fixed / ancillary (r_per_month): from the tariff in effect at period END (last segment).
 *  - demand (peak): the largest segment demand charge (the period peak priced under its rate).
 * A single-segment period (the common case) is unchanged — identical to a plain `priceUsage`.
 */
export function priceSegments(
  segments: Array<{ usage: UsageData; profile: TariffProfile }>,
): PricingBreakdown {
  if (segments.length === 0) return emptyBreakdown();

  const priced = segments.map((seg) => priceUsage(seg.usage, seg.profile));

  // Per-consumption charges sum across segments.
  const activeEnergyCents = priced.reduce((s, p) => s + p.activeEnergyCents, 0);
  const reactiveEnergyCents = priced.reduce((s, p) => s + p.reactiveEnergyCents, 0);

  // Period-level charges once: fixed/ancillary from the period-end tariff, demand = peak.
  const last = priced[priced.length - 1];
  const fixedCents = last.fixedCents;
  const ancillaryCents = last.ancillaryCents;
  const peakDemand = priced.reduce((m, p) => (p.demandCents > m.demandCents ? p : m), priced[0]);
  const demandCents = peakDemand.demandCents;

  // Details mirror the cents: every segment's active/reactive lines, plus ONE set of the
  // period-level lines (from the segments they were taken from).
  const details: PricingBreakdown["details"] = [];
  for (const p of priced) {
    details.push(...p.details.filter((d) => d.chargeType === "active_energy" || d.chargeType === "reactive_energy"));
  }
  details.push(...last.details.filter((d) => d.chargeType === "fixed" || d.chargeType === "ancillary"));
  details.push(...peakDemand.details.filter((d) => d.chargeType === "demand"));

  return {
    activeEnergyCents,
    demandCents,
    reactiveEnergyCents,
    fixedCents,
    ancillaryCents,
    totalCents: activeEnergyCents + demandCents + reactiveEnergyCents + fixedCents + ancillaryCents,
    details,
  };
}

export interface ComponentComparisonRow {
  key: string; // active | demand | reactive | fixed
  label: string;
  chargedCents: number;
  // null when there is no landlord tariff on file yet (expected charge undetermined).
  expectedLandlordCents: number | null;
  expectedCeilingCents: number;
  discrepancyVsLandlordCents: number | null; // charged − expected(landlord); >0 = overcharged
  discrepancyVsCeilingCents: number;
}

/**
 * Compare the invoice's confirmed per-component charges against what the meter ×
 * tariff says they should be, component by component (active / demand / reactive /
 * fixed). Positive discrepancy = the landlord charged more than the tariff allows.
 * PURE.
 */
export function buildComponentComparison(
  landlord: PricingBreakdown | null,
  ceiling: PricingBreakdown | null,
  invoice: {
    confirmedActiveCents: number | null;
    confirmedDemandCents: number | null;
    confirmedReactiveCents: number | null;
    confirmedFixedCents: number | null;
  },
): ComponentComparisonRow[] {
  const rows = [
    {
      key: "active",
      label: "Active energy",
      charged: invoice.confirmedActiveCents ?? 0,
      expL: landlord ? landlord.activeEnergyCents : null,
      expC: ceiling?.activeEnergyCents ?? 0,
    },
    {
      key: "demand",
      label: "Demand",
      charged: invoice.confirmedDemandCents ?? 0,
      expL: landlord ? landlord.demandCents : null,
      expC: ceiling?.demandCents ?? 0,
    },
    {
      key: "reactive",
      label: "Reactive energy",
      charged: invoice.confirmedReactiveCents ?? 0,
      expL: landlord ? landlord.reactiveEnergyCents : null,
      expC: ceiling?.reactiveEnergyCents ?? 0,
    },
    {
      key: "fixed",
      label: "Fixed / service",
      charged: invoice.confirmedFixedCents ?? 0,
      expL: landlord ? landlord.fixedCents + landlord.ancillaryCents : null,
      expC: (ceiling?.fixedCents ?? 0) + (ceiling?.ancillaryCents ?? 0),
    },
  ];
  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    chargedCents: r.charged,
    expectedLandlordCents: r.expL,
    expectedCeilingCents: r.expC,
    discrepancyVsLandlordCents: r.expL === null ? null : r.charged - r.expL,
    discrepancyVsCeilingCents: r.charged - r.expC,
  }));
}

export interface ReconciliationData {
  billingPeriodId: string;
  measuredActiveKwh: number;
  measuredMaxDemandKva: number;
  measuredReactiveKvarh: number;
  expectedLandlordCents: number | null;
  expectedCeilingCents: number;
  chargedTotalCents: number;
  discrepancyVsLandlordCents: number | null;
  discrepancyVsCeilingCents: number;
  dataIntegrityStatus: "clean" | "gaps_present";
  gapCount: number;
  gapMinutesTotal: number;
  breakdown: {
    landlord: {
      usage: UsageData;
      pricing: ReturnType<typeof priceUsage> | null;
    };
    ceiling: {
      usage: UsageData;
      pricing: ReturnType<typeof priceUsage>;
    };
    invoice: {
      confirmedActiveCents: number | null;
      confirmedDemandCents: number | null;
      confirmedReactiveCents: number | null;
      confirmedFixedCents: number | null;
      confirmedTotalCents: number | null;
    };
    components: ComponentComparisonRow[];
  };
}

export async function generateReconciliation(
  billingPeriod: BillingPeriod,
  _site: { id: string; timezone: string; demandIntervalMinutes: number },
  measuredData: {
    activeKwh: number;
    maxDemandKva: number;
    reactiveKvarh: number;
  },
  landlordPricing: PricingBreakdown | null,
  ceilingPricing: PricingBreakdown | null,
  invoiceData: {
    confirmedActiveCents: number | null;
    confirmedDemandCents: number | null;
    confirmedReactiveCents: number | null;
    confirmedFixedCents: number | null;
    confirmedTotalCents: number | null;
  },
  dataGapInfo: {
    gapCount: number;
    gapMinutesTotal: number;
  },
): Promise<ReconciliationData> {
  // Aggregate usage retained for display in the stored breakdown; the authoritative
  // pricing (which may be split across effective-dated tariff segments) is passed in.
  const usage: UsageData = {
    activeKwh: measuredData.activeKwh,
    maxDemandKva: measuredData.maxDemandKva,
    reactiveKvarh: measuredData.reactiveKvarh,
  };

  const chargedTotal = invoiceData.confirmedTotalCents || 0;
  // No landlord tariff on file yet ⇒ expected charge (and thus the discrepancy) is
  // undetermined. Store null rather than a misleading 0, so the recon shows "pending"
  // and the operator determines it during review.
  const discrepancyVsLandlord = landlordPricing ? chargedTotal - landlordPricing.totalCents : null;
  const discrepancyVsCeiling = ceilingPricing ? chargedTotal - ceilingPricing.totalCents : null;

  return {
    billingPeriodId: billingPeriod.id,
    measuredActiveKwh: measuredData.activeKwh,
    measuredMaxDemandKva: measuredData.maxDemandKva,
    measuredReactiveKvarh: measuredData.reactiveKvarh,
    expectedLandlordCents: landlordPricing ? landlordPricing.totalCents : null,
    expectedCeilingCents: ceilingPricing?.totalCents || 0,
    chargedTotalCents: chargedTotal,
    discrepancyVsLandlordCents: discrepancyVsLandlord,
    discrepancyVsCeilingCents: discrepancyVsCeiling || 0,
    dataIntegrityStatus: dataGapInfo.gapCount > 0 ? "gaps_present" : "clean",
    gapCount: dataGapInfo.gapCount,
    gapMinutesTotal: dataGapInfo.gapMinutesTotal,
    breakdown: {
      landlord: {
        usage,
        pricing: landlordPricing,
      },
      ceiling: {
        usage,
        pricing: ceilingPricing || {
          activeEnergyCents: 0,
          demandCents: 0,
          reactiveEnergyCents: 0,
          fixedCents: 0,
          ancillaryCents: 0,
          totalCents: 0,
          details: [],
        },
      },
      invoice: invoiceData,
      components: buildComponentComparison(landlordPricing, ceilingPricing, invoiceData),
    },
  };
}
