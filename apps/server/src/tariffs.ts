export interface TariffRate {
  chargeType: "active_energy" | "demand" | "reactive_energy" | "fixed" | "ancillary";
  unit: "c_per_kwh" | "r_per_kva" | "c_per_kvarh" | "r_per_day" | "r_per_month";
  rateValue: number;
  season: "high" | "low" | "all";
  touPeriod: "peak" | "standard" | "offpeak" | "all";
  blockThresholdKwh?: number;
  /**
   * Human label for this exact rate row, as the published schedule names it
   * ("Service charge", "Block 2: 351-500 kWh"). Carried through to
   * {@link PricingBreakdown.details} so a bill can name every line it charges
   * instead of showing an unattributable amount.
   */
  label?: string;
  /** Where the rate comes from — document, page, or rule reference. */
  source?: string;
  /**
   * Whether this line counts toward a percentage surcharge's base.
   *
   * Defaults to true for every tariff charge. Set false for levies that ride on
   * top of the tariff rather than forming part of it — the 6 c/kWh network
   * surcharge is the case that matters: City Power levies the 2% business
   * surcharge on the tariff charges and then adds the network surcharge, so
   * including it in the base would surcharge a surcharge.
   */
  inSurchargeBase?: boolean;
}

/**
 * A percentage levy applied on top of a tariff's own charges (City Power's 2%
 * "Business and Large Power User" surcharge).
 *
 * `basis` is required when enabled: the source documents never state what the
 * percentage is levied on, so an unstated basis is a configuration error rather
 * than something to guess. "all_tariff_charges" is the basis confirmed against
 * real landlord bills — energy + demand + reactive + service + capacity.
 */
export interface SurchargeRule {
  id: string;
  ratePercent: number;
  enabled: boolean;
  basis: "all_tariff_charges" | null;
  label?: string;
  source?: string;
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

export interface TariffProfile {
  touSchedule?: Record<string, unknown>;
  rates: TariffRate[];
  /** Percentage surcharges levied on top of this tariff's charges. */
  surcharges?: SurchargeRule[];
  /**
   * Floor on billed demand, in kVA. Industrial tariffs bill the GREATER of
   * measured demand and a minimum, so a quiet month is still charged at the
   * floor — billing raw measured demand under-states the bill.
   *
   * City Power's full rule is max(measured, 70, 80% of the average of the three
   * highest demands in the preceding 12 months). Only the fixed 70 kVA leg is
   * modelled here; the 12-month look-back needs demand history this period's
   * data cannot supply, and stays reported via `notApplied` until it is wired up.
   */
  minimumDemandKva?: number;
  /**
   * VAT rate as a fraction (0.15 for 15%). Published tariff rates are all
   * VAT-exclusive, so this is applied once to the charge total rather than
   * being baked into any individual rate.
   */
  vatFraction?: number;
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
}

export interface PricingBreakdown {
  activeEnergyCents: number;
  demandCents: number;
  reactiveEnergyCents: number;
  fixedCents: number;
  ancillaryCents: number;
  /**
   * Sum of the charges above, EXCLUDING VAT. This is the figure the line items
   * reconcile against — every published rate in the schedule is VAT-exclusive.
   */
  totalCents: number;
  /** VAT on `totalCents`, rounded once. Zero when the tariff defines no VAT rate. */
  vatCents: number;
  /** What the customer actually pays: `totalCents + vatCents`. */
  totalInclVatCents: number;
  details: Array<{
    chargeType: string;
    rateValue: number;
    unit: string;
    season: string;
    touPeriod: string;
    amountCents: number;
    label?: string;
    source?: string;
    /**
     * The measured input this line was charged on, in the rate's own unit
     * (kWh for energy, kVA for demand, kVArh for reactive). Null for flat
     * charges, which bill a fixed amount regardless of usage. With `rateValue`
     * this makes each line arithmetically checkable: quantity x rate = amount.
     */
    quantity: number | null;
  }>;
}

/**
 * Does pricing this tariff depend on WHEN within the day energy was used?
 *
 * Only a time-of-use tariff does. Everything else — flat, seasonal, inclining
 * block — prices totals, and a total is two register readings. This is what lets
 * a caller skip per-interval data entirely for most tariffs.
 */
export function tariffNeedsIntervals(profile: TariffProfile): boolean {
  const schedule = (profile.touSchedule ?? {}) as TouSchedule;
  return (
    schedule.weekday !== undefined ||
    schedule.weekend !== undefined ||
    profile.rates.some((r) => r.chargeType === "active_energy" && r.touPeriod !== "all")
  );
}

/** Does this tariff bill on peak demand (a demand or per-kVA charge, or a demand floor)? */
export function tariffNeedsDemand(profile: TariffProfile): boolean {
  return (
    (profile.minimumDemandKva ?? 0) > 0 ||
    profile.rates.some((r) => r.chargeType === "demand" || r.unit === "r_per_kva")
  );
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

/**
 * A rate's value in RAND, converted from the unit it is stored in.
 *
 * `tariff_rates` holds the PUBLISHED figure alongside the unit it was published
 * in — "284.96" tagged `c_per_kwh`, exactly as the schedule prints it, which is
 * what the profile's `sources` citations quote. The pricer works in Rand, so the
 * conversion has to happen somewhere; doing it here, at the single point where a
 * rate is read for arithmetic, keeps the stored data faithful to the document.
 *
 * Previously this did not exist and every caller used `rate.rateValue` directly,
 * which silently priced every cents-denominated rate 100x too high. See
 * .claude/decisions.md — it was invisible locally because the JSON importer
 * pre-divides, so only DB-loaded tariffs were affected.
 */
function rateInRand(rate: TariffRate): number {
  switch (rate.unit) {
    case "c_per_kwh":
    case "c_per_kvarh":
      return rate.rateValue / 100;
    default:
      // r_per_kva / r_per_month / r_per_day are already Rand.
      return rate.rateValue;
  }
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

  // Per-rate accumulated Rand amount; rounded to cents once at the end.
  const rateRand = new Array<number>(profile.rates.length).fill(0);
  // Per-rate billed quantity in the rate's own unit, so each line can show the
  // arithmetic (quantity x rate = amount) rather than just a total.
  const rateQty = new Array<number | null>(profile.rates.length).fill(null);
  const addQty = (index: number, qty: number) => {
    rateQty[index] = (rateQty[index] ?? 0) + qty;
  };

  const activeRates = profile.rates
    .map((rate, index) => ({ rate, index }))
    .filter((r) => r.rate.chargeType === "active_energy");
  const blockMode = activeRates.some((r) => r.rate.blockThresholdKwh !== undefined);

  if (blockMode) {
    // ── Inclining block: tier the active energy, PER SEASON ─────────────────
    // Every active rate is a tier; its blockThresholdKwh is the upper bound of
    // the consumption it prices. The final tier may omit the threshold (treated
    // as unbounded).
    //
    // Seasonal-block tariffs (COJ "Business Conventional/Prepaid" and friends)
    // publish a full set of blocks for EACH season. Tiering across all of them
    // at once would interleave the two seasons' thresholds and let whichever
    // season's rows sort first absorb the energy — pricing a winter period at
    // summer rates. So the energy is split by season first, and each season's
    // kWh is tiered only against that season's own blocks.
    //
    // This also restarts the ladder at the season boundary for a period that
    // straddles it. That is DELIBERATE and matches the source: COJ states block
    // thresholds are per calendar month (FY25/26 header "Consumption block
    // kWh/month"), and both season boundaries — 31 August and 31 May — fall on
    // month ends. So splitting there IS the per-calendar-month rule, not a
    // departure from it.
    //
    // Running one ladder across the whole period instead was tried and reverted:
    // it charges ~R1 115 (2.8%) MORE on a real straddling period, by denying the
    // customer a first block the schedule grants them each month. See
    // .claude/decisions.md.
    const seasonKwh = new Map<Season | "all", number>();
    for (const [key, kwh] of buckets) {
      const [seasonKey] = key.split("|");
      const season = (seasonKey === "high" || seasonKey === "low" ? seasonKey : "all") as
        | Season
        | "all";
      seasonKwh.set(season, (seasonKwh.get(season) ?? 0) + kwh);
    }

    for (const [season, kwh] of seasonKwh) {
      // This season's tiers, most specific first: a season-specific block set
      // when the tariff has one, otherwise the season-agnostic ("all") blocks.
      const seasonRates = activeRates.filter((r) => r.rate.season === season);
      const tiers =
        seasonRates.length > 0
          ? seasonRates
          : activeRates.filter((r) => r.rate.season === "all");

      const ordered = [...tiers].sort(
        (a, b) =>
          (a.rate.blockThresholdKwh ?? Number.POSITIVE_INFINITY) -
          (b.rate.blockThresholdKwh ?? Number.POSITIVE_INFINITY),
      );
      let lowerBound = 0;
      for (const { rate, index } of ordered) {
        const upperBound = rate.blockThresholdKwh ?? Number.POSITIVE_INFINITY;
        const kwhInTier = Math.max(0, Math.min(kwh, upperBound) - lowerBound);
        rateRand[index] += kwhInTier * rateInRand(rate);
        addQty(index, kwhInTier);
        lowerBound = upperBound;
      }
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
        rateRand[best.index] += kwh * rateInRand(best.rate);
        addQty(best.index, kwh);
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

  // Demand is billed on the GREATER of what was measured and the tariff's floor.
  // A site that ran quietly all period still pays the minimum, so pricing raw
  // measured demand would under-state the bill on every industrial tariff.
  const billedDemandKva = Math.max(usage.maxDemandKva, profile.minimumDemandKva ?? 0);

  profile.rates.forEach((rate, index) => {
    if (rate.chargeType === "active_energy") return;
    if (!seasonPresent(rate)) return;
    if (rate.chargeType === "demand") {
      rateRand[index] += billedDemandKva * rateInRand(rate);
      addQty(index, billedDemandKva);
    } else if (rate.chargeType === "reactive_energy") {
      rateRand[index] += usage.reactiveKvarh * rateInRand(rate);
      addQty(index, usage.reactiveKvarh);
    } else if (rate.chargeType === "fixed" || rate.chargeType === "ancillary") {
      // "Ancillary" covers both genuinely flat add-ons and per-unit levies — the
      // 6 c/kWh network surcharge is stored as an ancillary c_per_kwh rate. So the
      // UNIT decides the basis, not the charge type: a per-kWh ancillary that
      // billed flat would charge 6 cents for a whole month's electricity.
      if (rate.unit === "c_per_kwh") {
        rateRand[index] += usage.activeKwh * rateInRand(rate);
        addQty(index, usage.activeKwh);
      } else if (rate.unit === "c_per_kvarh") {
        rateRand[index] += usage.reactiveKvarh * rateInRand(rate);
        addQty(index, usage.reactiveKvarh);
      } else if (rate.unit === "r_per_kva") {
        // Capacity/network charges levied per kVA ride on the same billed
        // demand as the demand charge itself, floor included.
        rateRand[index] += billedDemandKva * rateInRand(rate);
        addQty(index, billedDemandKva);
      } else {
        // r_per_month / r_per_day: flat for the period, whatever the usage.
        rateRand[index] += rateInRand(rate);
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

  profile.rates.forEach((rate, index) => {
    const amountCents = Math.round(rateRand[index] * 100);
    if (amountCents <= 0) return;

    if (rate.chargeType === "active_energy") activeEnergyCents += amountCents;
    else if (rate.chargeType === "demand") demandCents += amountCents;
    else if (rate.chargeType === "reactive_energy") reactiveEnergyCents += amountCents;
    else if (rate.chargeType === "fixed") fixedCents += amountCents;
    else if (rate.chargeType === "ancillary") ancillaryCents += amountCents;

    details.push({
      chargeType: rate.chargeType,
      rateValue: rate.rateValue,
      unit: rate.unit,
      season: rate.season || "all",
      touPeriod: rate.touPeriod || "all",
      amountCents,
      quantity: rateQty[index],
      ...(rate.label !== undefined ? { label: rate.label } : {}),
      ...(rate.source !== undefined ? { source: rate.source } : {}),
    });
  });

  // ── Percentage surcharges ─────────────────────────────────────────────────
  // Computed from the ROUNDED line items above, so the base is exactly the set of
  // figures the customer can see and add up — not an unrounded intermediate they
  // could never reproduce.
  //
  // Ordering matters and is deliberate: the base excludes the 6 c/kWh network
  // surcharge (and any non-municipal charge), because City Power levies the 2% on
  // the tariff's own charges and adds the network surcharge afterwards. Every
  // rate counts toward the base unless it opts out via `inSurchargeBase: false`.
  for (const surcharge of profile.surcharges ?? []) {
    if (!surcharge.enabled) continue;
    if (surcharge.basis === null || surcharge.basis === undefined) {
      // The documents do not say what the percentage is levied on. Guessing would
      // silently produce a wrong bill, so this is a configuration error.
      throw new Error(
        `Surcharge "${surcharge.id}" is enabled but has no basis. Set basis to "all_tariff_charges" (or disable it) — the levy cannot be applied without one.`,
      );
    }

    let baseCents = 0;
    profile.rates.forEach((rate, index) => {
      if (rate.inSurchargeBase === false) return;
      baseCents += Math.max(0, Math.round(rateRand[index] * 100));
    });
    if (baseCents <= 0) continue;

    // round_half_up at the cents boundary. Math.round already rounds .5 away from
    // zero for positives, and a surcharge base is never negative.
    const amountCents = Math.round(baseCents * (surcharge.ratePercent / 100));
    if (amountCents <= 0) continue;

    ancillaryCents += amountCents;
    details.push({
      chargeType: "ancillary",
      rateValue: surcharge.ratePercent,
      unit: "percent",
      season: "all",
      touPeriod: "all",
      amountCents,
      // The base is the "quantity" this percentage was applied to, so the line
      // shows its own arithmetic like every other.
      quantity: baseCents / 100,
      label: surcharge.label ?? `${surcharge.ratePercent}% surcharge`,
      ...(surcharge.source !== undefined ? { source: surcharge.source } : {}),
    });
  }

  const totalCents =
    activeEnergyCents + demandCents + reactiveEnergyCents + fixedCents + ancillaryCents;

  // VAT is levied once on the whole VAT-exclusive charge total, not per line.
  // Rounding per line and summing would drift from the figure on the municipal
  // bill, so this rounds exactly once (rule 5).
  const vatCents = profile.vatFraction
    ? Math.round(totalCents * profile.vatFraction)
    : 0;

  return {
    activeEnergyCents,
    demandCents,
    reactiveEnergyCents,
    fixedCents,
    ancillaryCents,
    totalCents,
    vatCents,
    totalInclVatCents: totalCents + vatCents,
    details,
  };
}

/* ─────────────── Customer-facing bill lines ─────────────── */

/**
 * One charge on a customer's bill, carrying everything needed to justify it:
 * what it is, which rate produced it, what quantity it was charged on, and which
 * document that rate comes from. The UI renders these verbatim — it must never
 * invent a label or re-derive an amount, or the displayed bill stops matching the
 * priced one.
 */
export interface BillLine {
  /** Stable key for React lists and for matching a line across refreshes. */
  key: string;
  /** Which section of the bill this line belongs under. */
  group: "active_energy" | "demand" | "reactive_energy" | "fixed" | "ancillary";
  /** The name the published tariff schedule gives this charge. */
  label: string;
  /** Measured input the charge was applied to, in `quantityUnit`. Null for flat charges. */
  quantity: number | null;
  quantityUnit: string | null;
  /** The published rate, and the unit it is published in. */
  rateValue: number;
  rateUnit: string;
  /** Rate rendered as the schedule prints it, e.g. "417.67 c/kWh". */
  rateDisplay: string;
  amountCents: number;
  /** Citation for the rate — the document and edition it was read from. */
  source: string | null;
  season: string;
  touPeriod: string;
}

const QUANTITY_UNIT: Record<string, string | null> = {
  // A percentage levy's "quantity" is the Rand base it was applied to.
  percent: "R",
  c_per_kwh: "kWh",
  r_per_kva: "kVA",
  c_per_kvarh: "kVArh",
  r_per_month: null,
  r_per_day: null,
};

/** How each rate unit is printed on a bill line, matching the published schedule. */
export function rateDisplayFor(rateValue: number, unit: string): string {
  switch (unit) {
    // Rates are stored as published, so the figure is already the one printed in
    // the utility's schedule — it is shown verbatim, with no conversion.
    case "c_per_kwh":
      return `${rateValue.toFixed(2)} c/kWh`;
    case "c_per_kvarh":
      return `${rateValue.toFixed(2)} c/kVArh`;
    case "r_per_kva":
      return `R ${rateValue.toFixed(2)}/kVA`;
    case "r_per_month":
      return `R ${rateValue.toFixed(2)}/month`;
    case "r_per_day":
      return `R ${rateValue.toFixed(2)}/day`;
    case "percent":
      return `${rateValue}% of charges`;
    default:
      return String(rateValue);
  }
}

// Bill order: what was consumed, then what capacity cost, then the flat charges —
// the order a utility invoice presents them.
const GROUP_ORDER: Record<string, number> = {
  active_energy: 0,
  demand: 1,
  reactive_energy: 2,
  fixed: 3,
  ancillary: 4,
};

/**
 * Turn a {@link PricingBreakdown}'s per-rate details into customer-facing bill
 * lines, in the order an invoice presents them.
 *
 * Lines are derived from the SAME details the totals are summed from, so the
 * itemisation cannot drift from the headline figure. `priceSegments` may emit two
 * details for one rate when a period spans a tariff change; those are kept
 * separate rather than merged, because they were charged at different rates.
 */
export function billLines(pricing: PricingBreakdown): BillLine[] {
  return pricing.details
    .map((d, i) => ({ d, i }))
    .sort((a, b) => {
      const g = (GROUP_ORDER[a.d.chargeType] ?? 9) - (GROUP_ORDER[b.d.chargeType] ?? 9);
      if (g !== 0) return g;
      // Within a group, largest charge first — the lines a customer most wants to
      // account for sit at the top.
      if (b.d.amountCents !== a.d.amountCents) return b.d.amountCents - a.d.amountCents;
      return a.i - b.i;
    })
    .map(({ d, i }) => ({
      key: `${d.chargeType}:${d.season}:${d.touPeriod}:${i}`,
      group: d.chargeType as BillLine["group"],
      label: d.label ?? d.chargeType,
      quantity: d.quantity,
      quantityUnit: QUANTITY_UNIT[d.unit] ?? null,
      rateValue: d.rateValue,
      rateUnit: d.unit,
      rateDisplay: rateDisplayFor(d.rateValue, d.unit),
      amountCents: d.amountCents,
      source: d.source ?? null,
      season: d.season,
      touPeriod: d.touPeriod,
    }));
}
