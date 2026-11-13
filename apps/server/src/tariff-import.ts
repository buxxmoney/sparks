/**
 * Convert a published utility tariff schedule (the JSON under `tariffs/`) into the
 * shape `priceUsage` consumes. PURE — no DB, no clock, no file I/O.
 *
 * The source documents are transcriptions of a utility's approved schedule and
 * carry more than rate rows: season month ranges, time-of-use period definitions,
 * and a `billing_rules` block holding calculations a rate row cannot express. This
 * module converts what maps cleanly and REPORTS what does not, rather than
 * silently dropping it — an unreported gap becomes a wrong number on a customer's
 * bill.
 *
 * See `.claude/decisions.md` for the gap analysis behind `unsupported`.
 */
import type { SurchargeRule, TariffProfile, TariffRate, TouSchedule } from "./tariffs";

/* ─────────────── Source document shape ─────────────── */

export interface CojInterval {
  start: string;
  end: string;
}

export interface CojDayType {
  peak?: CojInterval[];
  standard?: CojInterval[];
  off_peak?: CojInterval[];
}

export interface CojEnergyCharge {
  season: "all" | "summer" | "winter";
  period: "all" | "peak" | "standard" | "off_peak";
  block: number | null;
  up_to_kwh: number | null;
  rate_c_per_kwh: number;
}

export interface CojTariff {
  id: string;
  category: string;
  name: string;
  energy_structure: "block" | "seasonal_block" | "tou" | "seasonal_flat" | string;
  energy_charges: CojEnergyCharge[];
  fixed_charges?: Record<string, number | null> | null;
  demand_charges?: { demand_r_per_kva?: number | null } | null;
  reactive_energy_charge?: { rate_c_per_kvarh?: number | null; rule_ref?: string } | null;
  notes?: string[];
}

export interface CojSchedule {
  meta: {
    issuer: string;
    financial_year: string;
    currency: string;
    title?: string;
    document_date?: string;
    sources?: Record<string, string>;
  };
  seasons: { summer: { months: number[] }; winter: { months: number[] } };
  network_surcharge?: {
    rate_c_per_kwh: number;
    residential_exemption?: { exempt_first_kwh_per_month?: number } | null;
  } | null;
  surcharges?: Array<{
    id: string;
    rate_percent: number;
    default_apply: boolean;
    basis?: string | null;
    applies_to_categories?: string[];
    source?: string;
  }>;
  billing_rules?: Record<string, unknown>;
  tou_periods?: { day_types?: Record<string, CojDayType> };
  tariffs: CojTariff[];
}

/* ─────────────── Conversion ─────────────── */

// The source names seasons summer/winter; the pricer's vocabulary is low/high
// (high = the expensive season). For COJ, winter is high.
const SEASON: Record<string, TariffRate["season"]> = {
  all: "all",
  summer: "low",
  winter: "high",
};

const PERIOD: Record<string, TariffRate["touPeriod"]> = {
  all: "all",
  peak: "peak",
  standard: "standard",
  off_peak: "offpeak",
};

/**
 * Expand a day type's time RANGES into the hour→band map `TouSchedule` expects.
 * `"24:00"` means end-of-day; ranges are start-inclusive / end-exclusive, so an
 * hour is assigned to the band whose range contains it.
 *
 * Without this, a TOU tariff prices to ZERO: `bandForInterval` returns null when a
 * profile carries no hour map, tagging every interval TOU "all", and a schedule
 * whose rates are all band-specific then matches nothing.
 */
export function hourMapFromDayType(
  dayType: CojDayType,
): Record<string, "peak" | "standard" | "offpeak"> {
  const map: Record<string, "peak" | "standard" | "offpeak"> = {};
  const bands: Array<[keyof CojDayType, "peak" | "standard" | "offpeak"]> = [
    ["peak", "peak"],
    ["standard", "standard"],
    ["off_peak", "offpeak"],
  ];
  for (const [sourceKey, band] of bands) {
    for (const interval of dayType[sourceKey] ?? []) {
      const start = Number.parseInt(interval.start.slice(0, 2), 10);
      const end = interval.end === "24:00" ? 24 : Number.parseInt(interval.end.slice(0, 2), 10);
      for (let h = start; h < end; h++) map[String(h)] = band;
    }
  }
  return map;
}

/** Season name as the published schedule prints it, for use in a line label. */
const SEASON_LABEL: Record<string, string> = {
  summer: "Summer",
  winter: "Winter",
  all: "",
};

const PERIOD_LABEL: Record<string, string> = {
  peak: "Peak",
  standard: "Standard",
  off_peak: "Off-peak",
  all: "",
};

/**
 * Name one energy rate row the way its own table names it, so a bill line reads
 * "Winter · Block 2: 501-1 000 kWh" rather than an anonymous energy charge.
 * `lowerBound` is the previous block's upper bound, which the source leaves
 * implicit (blocks are consecutive) but a reader needs to verify the tiering.
 */
export function energyRateLabel(row: CojEnergyCharge, lowerBound: number): string {
  const parts: string[] = [];
  const season = SEASON_LABEL[row.season];
  const period = PERIOD_LABEL[row.period];
  if (season) parts.push(season);
  if (period) parts.push(period);

  if (row.block != null) {
    const from = lowerBound + 1;
    const range =
      row.up_to_kwh != null
        ? `${formatKwh(from)}-${formatKwh(row.up_to_kwh)} kWh`
        : `above ${formatKwh(lowerBound)} kWh`;
    parts.push(`Block ${row.block}: ${range}`);
  } else if (parts.length === 0) {
    parts.push("Energy");
  }

  return parts.join(" · ");
}

/** Thin-space thousands grouping, matching how the UI prints quantities. */
function formatKwh(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
}

/**
 * Turn a `fixed_charges` key into the name the schedule gives it. The FY26/27
 * schedule renamed the FY25/26 "Network charge" to "Capacity charge" (same
 * charge), so the label follows the newer document.
 */
export function fixedChargeLabel(key: string): string {
  const known: Record<string, string> = {
    service_charge_r_per_month: "Service charge",
    capacity_charge_r_per_month: "Capacity charge",
    network_charge_r_per_month: "Network charge",
    admin_charge_r_per_month: "Administration charge",
  };
  if (known[key]) return known[key];
  // Unknown key: de-snake it and drop the unit suffix rather than showing raw JSON.
  return key
    .replace(/_r_per_(month|day)$/, "")
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

/** One-line citation for every rate taken from this schedule. */
/** The `minimum_demand` rule from the schedule, when it covers this tariff. */
function minimumDemandRule(schedule: CojSchedule, tariff: CojTariff) {
  const rule = (
    schedule.billing_rules as
      | {
          minimum_demand?: {
            applies_to_confirmed?: string[];
            components_kva?: Array<{ type: string; kva?: number; fraction?: number }>;
          };
        }
      | undefined
  )?.minimum_demand;
  if (!rule?.applies_to_confirmed?.includes(tariff.id)) return null;
  return rule;
}

/**
 * The fixed kVA floor billed demand may not fall below, or null when this tariff
 * has no minimum-demand rule. Taken from the schedule's `components_kva` so the
 * number lives in the source document, not in code.
 */
export function minimumDemandFloor(schedule: CojSchedule, tariff: CojTariff): number | null {
  const rule = minimumDemandRule(schedule, tariff);
  const fixed = rule?.components_kva?.find((c) => c.type === "fixed")?.kva;
  return typeof fixed === "number" ? fixed : null;
}

/** The look-back leg of the minimum-demand rule — reported, not yet applied. */
function minimumDemandLookback(
  schedule: CojSchedule,
  tariff: CojTariff,
): { fraction: number } | null {
  const rule = minimumDemandRule(schedule, tariff);
  const c = rule?.components_kva?.find((x) => x.type === "preceding_12m_top3_average_fraction");
  return typeof c?.fraction === "number" ? { fraction: c.fraction } : null;
}

function citation(schedule: CojSchedule): string {
  const { issuer, title, financial_year, document_date } = schedule.meta;
  const doc = title ?? `Schedule of Approved Tariffs ${financial_year}`;
  return document_date ? `${issuer} — ${doc} (${document_date})` : `${issuer} — ${doc}`;
}

/** A charge the source defines but the pricer cannot yet express. */
export interface UnsupportedRule {
  rule: string;
  effect: string;
}

export interface ConvertedTariff {
  id: string;
  name: string;
  currency: string;
  profile: TariffProfile;
  /**
   * Charges present in the source that `priceUsage` does NOT apply. Non-empty
   * means the computed total is incomplete — surface it, never ignore it.
   */
  unsupported: UnsupportedRule[];
}

/**
 * Convert one tariff from a schedule into a `TariffProfile`, plus the list of
 * source rules that don't survive the conversion.
 *
 * Units: rates are stored exactly as the source publishes them (energy in c/kWh,
 * reactive in c/kVArh, the rest in Rand), each tagged with its `unit`. The pricer
 * converts to Rand on read, so the stored figure always matches the printed
 * schedule and can be checked against it line by line.
 */
export function convertTariff(schedule: CojSchedule, tariffId: string): ConvertedTariff {
  const tariff = schedule.tariffs.find((t) => t.id === tariffId);
  if (!tariff) throw new Error(`tariff "${tariffId}" not found in schedule`);

  const cite = citation(schedule);

  // Block lower bounds are implicit in the source (blocks are consecutive within a
  // season), so they're tracked here to label each block with its full range.
  const previousUpperBound = new Map<string, number>();
  const rates: TariffRate[] = tariff.energy_charges.map((r) => {
    const seasonKey = `${r.season}|${r.period}`;
    const lowerBound = previousUpperBound.get(seasonKey) ?? 0;
    if (r.up_to_kwh != null) previousUpperBound.set(seasonKey, r.up_to_kwh);
    return {
      chargeType: "active_energy",
      unit: "c_per_kwh",
      // Stored as PUBLISHED (cents), tagged c_per_kwh — the pricer converts on
      // read. Dividing here as well would price every energy rate at 1/100th.
      rateValue: r.rate_c_per_kwh,
      season: SEASON[r.season] ?? "all",
      touPeriod: PERIOD[r.period] ?? "all",
      label: energyRateLabel(r, lowerBound),
      source: cite,
      ...(r.up_to_kwh != null ? { blockThresholdKwh: r.up_to_kwh } : {}),
    };
  });

  // Service and capacity ("network") charges are both flat R/month lines.
  for (const [name, value] of Object.entries(tariff.fixed_charges ?? {})) {
    if (typeof value === "number" && value > 0) {
      rates.push({
        chargeType: "fixed",
        unit: "r_per_month",
        rateValue: value,
        season: "all",
        touPeriod: "all",
        label: fixedChargeLabel(name),
        source: cite,
      });
    }
  }

  if (tariff.demand_charges?.demand_r_per_kva) {
    rates.push({
      chargeType: "demand",
      unit: "r_per_kva",
      rateValue: tariff.demand_charges.demand_r_per_kva,
      season: "all",
      touPeriod: "all",
      label: "Demand charge",
      source: cite,
    });
  }

  // The 6 c/kWh network surcharge: levied on every customer on top of the tariff.
  // Emitted as a per-kWh ancillary and kept OUT of the percentage-surcharge base,
  // because the 2% is levied on the tariff's own charges and this is added after.
  //
  // Residential customers get the first 500 kWh/month free of it — a marginal
  // exemption the flat rate row cannot express, so residential tariffs report it
  // as unsupported instead of silently overcharging.
  const residentialExempt =
    tariff.category === "residential" &&
    (schedule.network_surcharge?.residential_exemption?.exempt_first_kwh_per_month ?? 0) > 0;
  if (schedule.network_surcharge?.rate_c_per_kwh && !residentialExempt) {
    rates.push({
      chargeType: "ancillary",
      unit: "c_per_kwh",
      rateValue: schedule.network_surcharge.rate_c_per_kwh,
      season: "all",
      touPeriod: "all",
      label: "Network surcharge",
      source: cite,
      inSurchargeBase: false,
    });
  }

  // NOTE: deliberately NOT emitting a reactive_energy rate — see `unsupported`.
  // The source bills only the kVArh above a free allowance, which a flat rate row
  // cannot express; emitting one would overcharge every affected customer.

  const touSchedule: TouSchedule = { highSeasonMonths: schedule.seasons.winter.months };
  const dayTypes = schedule.tou_periods?.day_types;
  if (tariff.energy_structure === "tou" && dayTypes) {
    if (dayTypes.weekday) touSchedule.weekday = hourMapFromDayType(dayTypes.weekday);
    // `TouSchedule` has a single weekend map; the source distinguishes Saturday
    // from Sunday (and public holidays). Saturday is the closer of the two to a
    // generic weekend, so it stands in — reported as unsupported below.
    if (dayTypes.saturday) touSchedule.weekend = hourMapFromDayType(dayTypes.saturday);
  }

  // Percentage surcharges that apply to this tariff's category (business / LPU).
  const surcharges: SurchargeRule[] = (schedule.surcharges ?? [])
    .filter((sc) => (sc.applies_to_categories ?? []).includes(tariff.category))
    .map((sc) => ({
      id: sc.id,
      ratePercent: sc.rate_percent,
      enabled: sc.default_apply,
      // `priceUsage` rejects an enabled surcharge with no basis rather than
      // guessing what the percentage is levied on.
      basis: (sc.basis ?? null) as SurchargeRule["basis"],
      label: `${sc.rate_percent}% business surcharge`,
      source: sc.source ?? cite,
    }));

  // The fixed leg of the minimum-demand rule, read from the schedule rather than
  // hardcoded. Only tariffs the source confirms it applies to get a floor.
  const minimumDemandKva = minimumDemandFloor(schedule, tariff);

  return {
    id: tariff.id,
    name: tariff.name,
    currency: schedule.meta.currency,
    profile: {
      touSchedule: touSchedule as unknown as Record<string, unknown>,
      rates,
      ...(surcharges.length > 0 ? { surcharges } : {}),
      ...(minimumDemandKva ? { minimumDemandKva } : {}),
    },
    unsupported: unsupportedFor(schedule, tariff),
  };
}

/** Source rules that `priceUsage` cannot currently apply to this tariff. */
function unsupportedFor(schedule: CojSchedule, tariff: CojTariff): UnsupportedRule[] {
  const out: UnsupportedRule[] = [];

  if (tariff.reactive_energy_charge?.rate_c_per_kvarh) {
    out.push({
      rule: "reactive_energy_allowance",
      effect:
        "Reactive energy is billed only above a free allowance (kVArh beyond 30% of kWh). " +
        "No reactive charge is applied, so the total UNDER-states the bill for a low-power-factor site.",
    });
  }

  // The fixed leg of the minimum-demand rule is applied (see minimumDemandFloor).
  // The 12-month look-back leg is NOT: it needs demand history from outside this
  // billing period, so it stays disclosed rather than silently omitted.
  const lookback = minimumDemandLookback(schedule, tariff);
  if (lookback) {
    out.push({
      rule: "minimum_demand_lookback",
      effect:
        `Billed demand is the greater of measured demand, the ${minimumDemandFloor(schedule, tariff) ?? 70} kVA minimum, and ` +
        `${Math.round(lookback.fraction * 100)}% of the average of the three highest demands in the preceding 12 months. ` +
        "The first two are applied; the look-back is not, so the total may UNDER-state the bill for a site whose demand has fallen.",
    });
  }

  // The network surcharge IS applied now (a per-kWh ancillary), except for
  // residential customers, whose first 500 kWh/month are exempt — a marginal
  // allowance a flat rate row cannot express.
  const exemptKwh =
    schedule.network_surcharge?.residential_exemption?.exempt_first_kwh_per_month ?? 0;
  if (schedule.network_surcharge?.rate_c_per_kwh && tariff.category === "residential" && exemptKwh > 0) {
    out.push({
      rule: "network_surcharge_residential_exemption",
      effect:
        `The ${schedule.network_surcharge.rate_c_per_kwh} c/kWh network surcharge applies only above ${exemptKwh} kWh per month for residential customers. That marginal exemption is not modelled, so the surcharge is omitted entirely and the total UNDER-states the bill.`,
    });
  }

  for (const s of schedule.surcharges ?? []) {
    if (!s.default_apply && ["business", "industrial"].includes(tariff.category)) {
      out.push({
        rule: s.id,
        effect:
          `A ${s.rate_percent}% surcharge may apply to this category. The source does not state what it is levied on, so it is not applied.`,
      });
    }
  }

  if (tariff.energy_structure === "tou") {
    out.push({
      rule: "tou_day_types",
      effect:
        "The schedule defines separate Sunday and public-holiday periods; the pricer has only weekday + " +
        "weekend (Saturday stands in). Sundays and public holidays are priced at Saturday's bands.",
    });
  }

  return out;
}
