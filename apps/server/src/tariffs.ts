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

export interface TariffProfile {
  touSchedule?: Record<string, unknown>;
  rates: TariffRate[];
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

  // Per-rate accumulated Rand amount; rounded to cents once at the end.
  const rateRand = new Array<number>(profile.rates.length).fill(0);

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
      rateRand[index] += kwhInTier * rate.rateValue;
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
      if (best) rateRand[best.index] += kwh * best.rate.rateValue;
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

  profile.rates.forEach((rate, index) => {
    if (rate.chargeType === "active_energy") return;
    if (!seasonPresent(rate)) return;
    if (rate.chargeType === "demand") {
      rateRand[index] += usage.maxDemandKva * rate.rateValue;
    } else if (rate.chargeType === "reactive_energy") {
      rateRand[index] += usage.reactiveKvarh * rate.rateValue;
    } else if (rate.chargeType === "fixed" || rate.chargeType === "ancillary") {
      rateRand[index] += rate.rateValue;
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
    });
  });

  const totalCents =
    activeEnergyCents + demandCents + reactiveEnergyCents + fixedCents + ancillaryCents;

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
