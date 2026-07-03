import type { BillingPeriod } from "@sparks/db";
import { priceUsage, type UsageData, type TariffProfile } from "./tariffs";

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
  landlordProfile: TariffProfile,
  ceilingProfile: TariffProfile | null,
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
  const usage: UsageData = {
    activeKwh: measuredData.activeKwh,
    maxDemandKva: measuredData.maxDemandKva,
    reactiveKvarh: measuredData.reactiveKvarh,
  };

  const landlordPricing = priceUsage(usage, landlordProfile);
  const ceilingPricing = ceilingProfile ? priceUsage(usage, ceilingProfile) : null;

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
        pricing: ceilingPricing || { activeEnergyCents: 0, demandCents: 0, reactiveEnergyCents: 0, fixedCents: 0, ancillaryCents: 0, totalCents: 0, details: [] },
      },
      invoice: invoiceData,
    },
  };
}
