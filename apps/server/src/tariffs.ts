export interface TariffRate {
  chargeType: "active_energy" | "demand" | "reactive_energy" | "fixed" | "ancillary";
  unit: "c_per_kwh" | "r_per_kva" | "c_per_kvarh" | "r_per_day" | "r_per_month";
  rateValue: number;
  season: "high" | "low" | "all";
  touPeriod: "peak" | "standard" | "offpeak" | "all";
  blockThresholdKwh?: number;
}

export interface TariffProfile {
  touSchedule?: Record<string, unknown>;
  rates: TariffRate[];
}

export interface UsageData {
  activeKwh: number;
  maxDemandKva: number;
  reactiveKvarh: number;
  intervalStarts?: Date[];
}

export interface PricingBreakdown {
  activeEnergyCents: number;
  demandCents: number;
  reactiveEnergyCents: number;
  fixedCents: number;
  ancillaryCents: number;
  totalCents: number;
  details: Array<{
    chargeType: string;
    rateValue: number;
    unit: string;
    season: string;
    touPeriod: string;
    amountCents: number;
  }>;
}

export function priceUsage(usage: UsageData, profile: TariffProfile): PricingBreakdown {
  const details: PricingBreakdown["details"] = [];
  let activeEnergyCents = 0;
  let demandCents = 0;
  let reactiveEnergyCents = 0;
  let fixedCents = 0;
  let ancillaryCents = 0;

  const defaultSeason = "all";
  const defaultTouPeriod = "all";

  for (const rate of profile.rates) {
    const season = rate.season || defaultSeason;
    const touPeriod = rate.touPeriod || defaultTouPeriod;
    const rateValue = rate.rateValue;

    let amountCents = 0;

    if (rate.chargeType === "active_energy") {
      if (season === "all" && touPeriod === "all") {
        amountCents = Math.round(usage.activeKwh * rateValue * 100);
      }
    } else if (rate.chargeType === "demand") {
      if (season === "all" && touPeriod === "all") {
        amountCents = Math.round(usage.maxDemandKva * rateValue * 100);
      }
    } else if (rate.chargeType === "reactive_energy") {
      if (season === "all" && touPeriod === "all") {
        amountCents = Math.round(usage.reactiveKvarh * rateValue * 100);
      }
    } else if (rate.chargeType === "fixed") {
      amountCents = Math.round(rateValue * 100);
    } else if (rate.chargeType === "ancillary") {
      amountCents = Math.round(rateValue * 100);
    }

    if (amountCents > 0) {
      if (rate.chargeType === "active_energy") {
        activeEnergyCents += amountCents;
      } else if (rate.chargeType === "demand") {
        demandCents += amountCents;
      } else if (rate.chargeType === "reactive_energy") {
        reactiveEnergyCents += amountCents;
      } else if (rate.chargeType === "fixed") {
        fixedCents += amountCents;
      } else if (rate.chargeType === "ancillary") {
        ancillaryCents += amountCents;
      }

      details.push({
        chargeType: rate.chargeType,
        rateValue,
        unit: rate.unit,
        season: rate.season || "all",
        touPeriod: rate.touPeriod || "all",
        amountCents,
      });
    }
  }

  const totalCents = activeEnergyCents + demandCents + reactiveEnergyCents + fixedCents + ancillaryCents;

  return {
    activeEnergyCents,
    demandCents,
    reactiveEnergyCents,
    fixedCents,
    ancillaryCents,
    totalCents,
    details,
  };
}
