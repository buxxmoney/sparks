export interface TariffRate {
  chargeType: "active_energy" | "demand" | "reactive_energy" | "fixed" | "ancillary";
  unit: "c_per_kwh" | "r_per_kva" | "c_per_kvarh" | "r_per_day" | "r_per_month";
  rateValue: number;
  season: "high" | "low" | "all";
  touPeriod: "peak" | "standard" | "offpeak" | "all";
  blockThresholdKwh?: number;
}

/**
 * Time-of-use schedule consumed by {@link priceUsage}. Stored per-profile as the
 * `tou_schedule` jsonb column (docs/02 §3). All fields optional so a flat tariff
 * needs no schedule at all.
 *
 * - `highSeasonMonths` — calendar months (1–12) that count as the high-demand
 *   season. Defaults to the SA Eskom high season (June–August).
 * - `weekday` / `weekend` — map each local hour ("0".."23") to a TOU band. Hours
 *   not listed default to "offpeak". If neither map is present the schedule can't
 *   identify a band, so intervals are tagged TOU "all" (only all-period rates
 *   apply). `weekend` defaults to `weekday` when omitted.
 */
export interface TouSchedule {
  highSeasonMonths?: number[];
  weekday?: Record<string, "peak" | "standard" | "offpeak">;
  weekend?: Record<string, "peak" | "standard" | "offpeak">;
}

/**
 * Structural billing rules a rate table alone cannot express. Every field is
 * optional; an absent field means "charge exactly what was measured". Sources:
 * City Power "Schedule of Approved Tariffs FY26/27" p7 (minimum demand rule,
 * 6c/kWh network surcharge) and Eskom "Schedule of Standard Prices Apr 2026"
 * ¶14 of the tariff definitions (30% reactive-energy allowance), both verified
 * to the cent against Life Grand Cafe's Feb–May 2026 landlord bills.
 */
export interface PricingRules {
  /**
   * Billed demand = max(measured peak kVA, this floor). City Power LV Demand:
   * the monthly demand charge uses the GREATER of 70 kVA, the measured demand,
   * or 80% of the average of the three highest demands in the rolling preceding
   * 12 months — this field carries the contractual floor (70 for LPU LV).
   */
  minDemandKva?: number;
  /**
   * Reactive-energy free allowance as a fraction of active kWh: billed kvarh =
   * max(0, kvarh − f × kWh). SA standard is 0.3 (i.e. charged only below 0.96
   * power factor); verified exactly on all three reference bills.
   */
  reactiveAllowanceFactorOfKwh?: number;
  /**
   * Eskom charges excess reactive energy only in the high-demand season
   * (Jun–Aug); City Power charges it year-round (bills show reactive charges in
   * Feb–May). Default false = year-round.
   */
  reactiveHighSeasonOnly?: boolean;
  /**
   * Percent-of-bill levy: surcharge = f × (active + demand + reactive + fixed),
   * computed on the cents-rounded lines, EXCLUDING ancillary (per-kWh riders)
   * — matching the City of Joburg 2c/R business surcharge base on the bills.
   */
  surchargeFractionOfSubtotal?: number;
  /** VAT fraction (0.15 in SA). `totalCents` stays ex-VAT (what reconciliation
   * compares); `vatCents`/`totalInclVatCents` are derived for display. */
  vatFraction?: number;
}

/**
 * A verbatim citation from a published tariff document backing part of this
 * profile — surfaced in the customer-facing "how we calculated this" view.
 * `tariffScheduleId` links the uploaded reference PDF (tariff_schedules) the
 * quote was transcribed from, when one is on file.
 */
export interface TariffSourceCitation {
  title: string;
  page?: string;
  quote: string;
  /** Which lines/rules this quote backs: chargeType names ("demand",
   * "reactive_energy", "ancillary", "surcharge", "active_energy") or "rates". */
  appliesTo?: string[];
  tariffScheduleId?: string;
}

export interface TariffProfile {
  touSchedule?: Record<string, unknown>;
  rates: TariffRate[];
  rules?: PricingRules;
  sources?: TariffSourceCitation[];
}

export interface UsageData {
  activeKwh: number;
  maxDemandKva: number;
  reactiveKvarh: number;
  /**
   * Start instant of each demand interval in the period. When present, active
   * energy is attributed to a TOU band + season per interval; when absent the
   * whole `activeKwh` is treated as a single untagged (all/all) bucket so flat
   * tariffs still price correctly.
   */
  intervalStarts?: Date[];
  /**
   * Active energy (kWh) per interval, aligned to `intervalStarts`. When omitted,
   * `activeKwh` is spread equally across the provided interval starts.
   */
  intervalActiveKwh?: number[];
  /** IANA timezone used to resolve each interval's local hour/month. */
  timezone?: string;
  /** Days in the billing period — multiplies `r_per_day` rates (Eskom service/
   * capacity charges are R/POD/day). Defaults to 30 when omitted. */
  periodDays?: number;
}

export interface PricingBreakdown {
  activeEnergyCents: number;
  demandCents: number;
  reactiveEnergyCents: number;
  fixedCents: number;
  ancillaryCents: number;
  /** Percent-of-subtotal levy (e.g. CoJ business surcharge); 0 when no rule. */
  surchargeCents: number;
  /** Ex-VAT total (active + demand + reactive + fixed + ancillary + surcharge)
   * — the number reconciliation compares against invoice subtotals. */
  totalCents: number;
  /** VAT on totalCents (0 when the profile has no vatFraction rule). */
  vatCents: number;
  totalInclVatCents: number;
  /** The kVA the demand charge was raised on — differs from the measured peak
   * when a minimum-demand floor applies (undefined when no demand rate). */
  billedDemandKva?: number;
  details: Array<{
    chargeType: string;
    rateValue: number;
    unit: string;
    season: string;
    touPeriod: string;
    amountCents: number;
    /** The measured/derived quantity this line multiplied by its rate — lets the
     * UI show the working ("10,223.157 kWh × R2.6141 = R26,724.35"). */
    quantity?: number;
    quantityUnit?: string;
    /** Plain-language rule applied to this line (demand floor, reactive
     * allowance, surcharge base) for the "how we calculated this" view. */
    note?: string;
  }>;
}

type Season = "high" | "low";
type TouBand = "peak" | "standard" | "offpeak";

const DEFAULT_HIGH_SEASON_MONTHS = [6, 7, 8];
const DEFAULT_TIMEZONE = "Africa/Johannesburg";

/** Resolve a UTC instant's local month/hour/weekend flag for a timezone (pure). */
function localParts(
  date: Date,
  timezone: string,
): { month: number; hour: number; weekend: boolean } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    month: "numeric",
    hour: "numeric",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const month = Number(get("month"));
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0; // some environments emit "24" for midnight
  const weekday = get("weekday");
  return { month, hour, weekend: weekday === "Sat" || weekday === "Sun" };
}

function seasonForMonth(month: number, highSeasonMonths: number[]): Season {
  return highSeasonMonths.includes(month) ? "high" : "low";
}

/** The TOU band for an interval, or null when the schedule can't identify one. */
function bandForInterval(date: Date, timezone: string, schedule: TouSchedule): TouBand | null {
  const hasMaps = schedule.weekday !== undefined || schedule.weekend !== undefined;
  if (!hasMaps) return null;
  const { hour, weekend } = localParts(date, timezone);
  const map = (weekend ? (schedule.weekend ?? schedule.weekday) : schedule.weekday) ?? {};
  return map[String(hour)] ?? "offpeak";
}

/** How specific a rate is — higher wins when several rates match one bucket. */
function specificity(rate: TariffRate): number {
  return (rate.season !== "all" ? 1 : 0) + (rate.touPeriod !== "all" ? 1 : 0);
}

function rateMatchesBucket(
  rate: TariffRate,
  season: Season | "all",
  band: TouBand | "all",
): boolean {
  const seasonOk = rate.season === "all" || rate.season === season;
  const bandOk = rate.touPeriod === "all" || rate.touPeriod === band;
  return seasonOk && bandOk;
}

/**
 * Price measured usage against a tariff profile. PURE — no DB, no clock; all
 * time inputs arrive via `usage`. Integer cents throughout; `Math.round` is
 * applied only once per charge line at the cents boundary.
 *
 * Active energy is attributed per interval to a (season, TOU-band) bucket and
 * priced by the most specific matching rate, so high/low seasons and
 * peak/standard/offpeak periods are each charged at their own rate. Inclining
 * block tariffs (rates carrying `blockThresholdKwh`) tier the total active
 * energy instead. Demand/reactive/fixed/ancillary are scalar charges applied
 * for every rate whose season is present in the period (or "all").
 */
export function priceUsage(usage: UsageData, profile: TariffProfile): PricingBreakdown {
  const schedule = (profile.touSchedule ?? {}) as TouSchedule;
  const highSeasonMonths =
    Array.isArray(schedule.highSeasonMonths) && schedule.highSeasonMonths.length > 0
      ? schedule.highSeasonMonths
      : DEFAULT_HIGH_SEASON_MONTHS;
  const timezone = usage.timezone ?? DEFAULT_TIMEZONE;

  // ── Bucket active energy by (season, TOU band) ────────────────────────────
  // Each key is `${season}|${band}`; value is kWh. With no interval starts the
  // whole activeKwh lands in a single untagged (all/all) bucket.
  const buckets = new Map<string, number>();
  const presentSeasons = new Set<Season>();

  const starts = usage.intervalStarts ?? [];
  if (starts.length > 0) {
    const perInterval = usage.intervalActiveKwh;
    const equalShare = usage.activeKwh / starts.length;
    starts.forEach((start, i) => {
      const kwh = perInterval?.[i] ?? equalShare;
      const { month } = localParts(start, timezone);
      const season = seasonForMonth(month, highSeasonMonths);
      const band = bandForInterval(start, timezone, schedule);
      presentSeasons.add(season);
      const key = `${season}|${band ?? "all"}`;
      buckets.set(key, (buckets.get(key) ?? 0) + kwh);
    });
  } else {
    buckets.set("all|all", usage.activeKwh);
  }

  // Per-rate accumulated Rand amount; rounded to cents once at the end. The
  // parallel quantity is what the rate multiplied (kWh/kVA/kVArh/days) so each
  // detail line can show its arithmetic.
  const rateRand = new Array<number>(profile.rates.length).fill(0);
  const rateQty = new Array<number>(profile.rates.length).fill(0);

  // rateValue is stored as published on the utility schedule: cents for
  // `c_per_*` units (e.g. 261.41 c/kWh), Rand for `r_per_*` units.
  const rateRandPerUnit = (rate: TariffRate) =>
    rate.unit.startsWith("c_per_") ? rate.rateValue / 100 : rate.rateValue;

  const activeRates = profile.rates
    .map((rate, index) => ({ rate, index }))
    .filter((r) => r.rate.chargeType === "active_energy");
  const blockMode = activeRates.some((r) => r.rate.blockThresholdKwh !== undefined);

  if (blockMode) {
    // ── Inclining block: tier the total active energy ───────────────────────
    // Every active rate is a tier; its blockThresholdKwh is the upper bound of
    // the consumption it prices. The final tier may omit the threshold (treated
    // as unbounded).
    const ordered = [...activeRates].sort(
      (a, b) =>
        (a.rate.blockThresholdKwh ?? Number.POSITIVE_INFINITY) -
        (b.rate.blockThresholdKwh ?? Number.POSITIVE_INFINITY),
    );
    let lowerBound = 0;
    for (const { rate, index } of ordered) {
      const upperBound = rate.blockThresholdKwh ?? Number.POSITIVE_INFINITY;
      const kwhInTier = Math.max(0, Math.min(usage.activeKwh, upperBound) - lowerBound);
      rateRand[index] += kwhInTier * rateRandPerUnit(rate);
      rateQty[index] += kwhInTier;
      lowerBound = upperBound;
    }
  } else {
    // ── TOU/seasonal: price each bucket by its best-matching rate ────────────
    for (const [key, kwh] of buckets) {
      const [seasonKey, bandKey] = key.split("|");
      const season = (seasonKey === "high" || seasonKey === "low" ? seasonKey : "all") as
        | Season
        | "all";
      const band = (
        bandKey === "peak" || bandKey === "standard" || bandKey === "offpeak" ? bandKey : "all"
      ) as TouBand | "all";
      let best: { rate: TariffRate; index: number } | null = null;
      for (const candidate of activeRates) {
        if (!rateMatchesBucket(candidate.rate, season, band)) continue;
        if (!best || specificity(candidate.rate) > specificity(best.rate)) best = candidate;
      }
      if (best) {
        rateRand[best.index] += kwh * rateRandPerUnit(best.rate);
        rateQty[best.index] += kwh;
      }
    }
  }

  // ── Scalar charges: demand / reactive / fixed / ancillary ─────────────────
  // Applied for every rate whose season is "all" or present in the period. Well-
  // formed tariffs express seasonal variants as season-specific rows, so a
  // single-season period selects exactly one.
  const seasonPresent = (rate: TariffRate) =>
    rate.season === "all" || presentSeasons.size === 0
      ? rate.season === "all"
      : presentSeasons.has(rate.season as Season);

  const rules = profile.rules ?? {};
  const periodDays = usage.periodDays ?? 30;

  // Demand is billed on the greater of the measured peak and the tariff's
  // contractual floor (City Power: 70 kVA minimum for LPU LV).
  const hasDemandRate = profile.rates.some((r) => r.chargeType === "demand");
  const billedDemandKva = Math.max(usage.maxDemandKva, rules.minDemandKva ?? 0);

  // Reactive energy is billed only in excess of the free allowance (typically
  // 30% of kWh = below 0.96 PF), and for Eskom-style tariffs only when the
  // period touches the high-demand season.
  const allowance = (rules.reactiveAllowanceFactorOfKwh ?? 0) * usage.activeKwh;
  const highSeasonBlocked =
    rules.reactiveHighSeasonOnly === true && presentSeasons.size > 0 && !presentSeasons.has("high");
  const billedReactiveKvarh = highSeasonBlocked ? 0 : Math.max(0, usage.reactiveKvarh - allowance);

  profile.rates.forEach((rate, index) => {
    if (rate.chargeType === "active_energy") return;
    if (!seasonPresent(rate)) return;
    if (rate.chargeType === "demand") {
      rateRand[index] += billedDemandKva * rateRandPerUnit(rate);
      rateQty[index] = billedDemandKva;
    } else if (rate.chargeType === "reactive_energy") {
      rateRand[index] += billedReactiveKvarh * rateRandPerUnit(rate);
      rateQty[index] = billedReactiveKvarh;
    } else if (rate.chargeType === "fixed" || rate.chargeType === "ancillary") {
      // Unit-aware: R/day charges accrue per day (Eskom service charges are
      // R/POD/day); a c_per_kwh ancillary is an additive per-kWh rider (City
      // Power's 6c/kWh network surcharge) that stacks on the energy rate rather
      // than competing with it; R/month (and legacy unit-less rows) stay flat.
      if (rate.unit === "r_per_day") {
        rateRand[index] += rate.rateValue * periodDays;
        rateQty[index] = periodDays;
      } else if (rate.unit === "c_per_kwh") {
        rateRand[index] += rateRandPerUnit(rate) * usage.activeKwh;
        rateQty[index] = usage.activeKwh;
      } else {
        rateRand[index] += rate.rateValue;
        rateQty[index] = 1;
      }
    }
  });

  // ── Aggregate into the breakdown ──────────────────────────────────────────
  const details: PricingBreakdown["details"] = [];
  let activeEnergyCents = 0;
  let demandCents = 0;
  let reactiveEnergyCents = 0;
  let fixedCents = 0;
  let ancillaryCents = 0;

  const QTY_UNIT: Record<string, string> = {
    c_per_kwh: "kWh",
    r_per_kva: "kVA",
    c_per_kvarh: "kVArh",
    r_per_day: "days",
    r_per_month: "month",
  };

  profile.rates.forEach((rate, index) => {
    const amountCents = Math.round(rateRand[index] * 100);
    if (amountCents <= 0) return;

    if (rate.chargeType === "active_energy") activeEnergyCents += amountCents;
    else if (rate.chargeType === "demand") demandCents += amountCents;
    else if (rate.chargeType === "reactive_energy") reactiveEnergyCents += amountCents;
    else if (rate.chargeType === "fixed") fixedCents += amountCents;
    else if (rate.chargeType === "ancillary") ancillaryCents += amountCents;

    // The plain-language rule behind this line, when one adjusted the quantity.
    let note: string | undefined;
    if (rate.chargeType === "demand" && billedDemandKva > usage.maxDemandKva) {
      note = `Billed at the tariff's minimum demand: measured peak ${usage.maxDemandKva.toFixed(3)} kVA is below the ${rules.minDemandKva} kVA contractual floor.`;
    } else if (rate.chargeType === "reactive_energy" && allowance > 0) {
      note = `Charged on the excess over the free allowance: ${usage.reactiveKvarh.toFixed(3)} kVArh − ${rules.reactiveAllowanceFactorOfKwh} × ${usage.activeKwh.toFixed(3)} kWh = ${billedReactiveKvarh.toFixed(3)} kVArh.`;
    } else if (rate.chargeType === "ancillary" && rate.unit === "c_per_kwh") {
      note = "Per-kWh rider charged on all active energy, on top of the energy rate.";
    }

    details.push({
      chargeType: rate.chargeType,
      rateValue: rate.rateValue,
      unit: rate.unit,
      season: rate.season || "all",
      touPeriod: rate.touPeriod || "all",
      amountCents,
      quantity: rateQty[index],
      quantityUnit: QTY_UNIT[rate.unit] ?? rate.unit,
      note,
    });
  });

  // ── Percent-of-subtotal surcharge (CoJ business levy) ─────────────────────
  // Computed on the cents-rounded component lines, excluding ancillary per-kWh
  // riders — the base observed on the reference bills (their 2c/R surcharge base
  // omits the 6c/kWh network surcharge line).
  const surchargeBase = activeEnergyCents + demandCents + reactiveEnergyCents + fixedCents;
  const surchargeCents = rules.surchargeFractionOfSubtotal
    ? Math.round(surchargeBase * rules.surchargeFractionOfSubtotal)
    : 0;
  if (surchargeCents > 0) {
    details.push({
      chargeType: "surcharge",
      rateValue: rules.surchargeFractionOfSubtotal ?? 0,
      unit: "fraction_of_subtotal",
      season: "all",
      touPeriod: "all",
      amountCents: surchargeCents,
      quantity: surchargeBase / 100,
      quantityUnit: "R",
      note: "Percent levy on energy + demand + reactive + fixed charges (per-kWh riders excluded from the base).",
    });
  }

  const totalCents =
    activeEnergyCents +
    demandCents +
    reactiveEnergyCents +
    fixedCents +
    ancillaryCents +
    surchargeCents;
  const vatCents = rules.vatFraction ? Math.round(totalCents * rules.vatFraction) : 0;

  return {
    activeEnergyCents,
    demandCents,
    reactiveEnergyCents,
    fixedCents,
    ancillaryCents,
    surchargeCents,
    totalCents,
    vatCents,
    totalInclVatCents: totalCents + vatCents,
    billedDemandKva: hasDemandRate ? billedDemandKva : undefined,
    details,
  };
}
