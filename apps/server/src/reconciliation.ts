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
 * segments (e.g. a billing period crossing a tariff change). Each segment prices
 * its own slice of usage against the profile effective for that slice; the
 * results are summed. A single-segment period (the common case) is identical to
 * a plain `priceUsage`. PURE.
 */
export function priceSegments(
  segments: Array<{ usage: UsageData; profile: TariffProfile }>,
): PricingBreakdown {
  const acc = emptyBreakdown();
  for (const seg of segments) {
    const p = priceUsage(seg.usage, seg.profile);
    acc.activeEnergyCents += p.activeEnergyCents;
    acc.demandCents += p.demandCents;
    acc.reactiveEnergyCents += p.reactiveEnergyCents;
    acc.fixedCents += p.fixedCents;
    acc.ancillaryCents += p.ancillaryCents;
    acc.totalCents += p.totalCents;
    acc.details.push(...p.details);
  }
  return acc;
}

export interface ComponentComparisonRow {
  key: string; // active | demand | reactive | fixed
  label: string;
  chargedCents: number;
  expectedLandlordCents: number;
  expectedCeilingCents: number;
  discrepancyVsLandlordCents: number; // charged − expected(landlord); >0 = overcharged
  discrepancyVsCeilingCents: number;
}

/**
 * Compare the invoice's confirmed per-component charges against what the meter ×
 * tariff says they should be, component by component (active / demand / reactive /
 * fixed). Positive discrepancy = the landlord charged more than the tariff allows.
 * PURE.
 */
export function buildComponentComparison(
  landlord: PricingBreakdown,
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
      expL: landlord.activeEnergyCents,
      expC: ceiling?.activeEnergyCents ?? 0,
    },
    {
      key: "demand",
      label: "Demand",
      charged: invoice.confirmedDemandCents ?? 0,
      expL: landlord.demandCents,
      expC: ceiling?.demandCents ?? 0,
    },
    {
      key: "reactive",
      label: "Reactive energy",
      charged: invoice.confirmedReactiveCents ?? 0,
      expL: landlord.reactiveEnergyCents,
      expC: ceiling?.reactiveEnergyCents ?? 0,
    },
    {
      key: "fixed",
      label: "Fixed / service",
      charged: invoice.confirmedFixedCents ?? 0,
      expL: landlord.fixedCents + landlord.ancillaryCents,
      expC: (ceiling?.fixedCents ?? 0) + (ceiling?.ancillaryCents ?? 0),
    },
  ];
  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    chargedCents: r.charged,
    expectedLandlordCents: r.expL,
    expectedCeilingCents: r.expC,
    discrepancyVsLandlordCents: r.charged - r.expL,
    discrepancyVsCeilingCents: r.charged - r.expC,
  }));
}

export interface ReconciliationData {
  billingPeriodId: string;
  measuredActiveKwh: number;
  measuredMaxDemandKva: number;
  measuredReactiveKvarh: number;
  expectedLandlordCents: number;
  expectedCeilingCents: number;
  chargedTotalCents: number;
  discrepancyVsLandlordCents: number;
  discrepancyVsCeilingCents: number;
  dataIntegrityStatus: "clean" | "gaps_present";
  gapCount: number;
  gapMinutesTotal: number;
  breakdown: {
    landlord: {
      usage: UsageData;
      pricing: ReturnType<typeof priceUsage>;
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
  landlordPricing: PricingBreakdown,
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
  const discrepancyVsLandlord = chargedTotal - landlordPricing.totalCents;
  const discrepancyVsCeiling = ceilingPricing ? chargedTotal - ceilingPricing.totalCents : null;

  return {
    billingPeriodId: billingPeriod.id,
    measuredActiveKwh: measuredData.activeKwh,
    measuredMaxDemandKva: measuredData.maxDemandKva,
    measuredReactiveKvarh: measuredData.reactiveKvarh,
    expectedLandlordCents: landlordPricing.totalCents,
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
