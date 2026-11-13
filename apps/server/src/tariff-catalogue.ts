/**
 * The published tariffs an operator can put a site on.
 *
 * Source of truth is the transcribed utility schedule under `tariffs/` — the same
 * JSON `convertTariff` turns into a priceable profile. This module lists what is
 * in it and shapes one tariff into the `tariff_profiles` / `tariff_rates` rows the
 * database stores, so "move this site to the Business tariff" is a pick from the
 * published schedule rather than an operator re-typing rates by hand.
 *
 * Everything except {@link loadSchedule} is PURE, so the row shaping is testable
 * without a database.
 */
import { readFileSync } from "node:fs";
import { type CojSchedule, type UnsupportedRule, convertTariff } from "./tariff-import";

/** Schedules on file, newest first. Add a line when a new financial year is transcribed. */
const SCHEDULE_FILES = ["../../../tariffs/2026/2027-COJ.json"];

/**
 * South African VAT. Every published rate is VAT-exclusive (`meta.vat_inclusive`
 * is false) and the schedule does not restate the statutory rate, so it is named
 * here once rather than appearing as a bare 0.15 at each use.
 */
const VAT_FRACTION = 0.15;

let cached: CojSchedule[] | null = null;

/** Read the schedules from disk once; they only change with a deploy. */
export function loadSchedules(): CojSchedule[] {
  if (!cached) {
    cached = SCHEDULE_FILES.map(
      (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf-8")) as CojSchedule,
    );
  }
  return cached;
}

export interface CatalogueEntry {
  /** Stable id within the schedule, e.g. "business_conventional_prepaid". */
  tariffId: string;
  /** Name as stored on the profile, e.g. "City Power Business Conventional/Prepaid FY26/27". */
  name: string;
  /** Name as the schedule prints it, without issuer or year. */
  shortName: string;
  category: string;
  energyStructure: string;
  issuer: string;
  financialYear: string;
  /** Source rules the pricer does not apply — a non-empty list means an incomplete total. */
  notApplied: UnsupportedRule[];
}

/** "2026/27" → "FY26/27", matching how existing library profiles are named. */
function financialYearLabel(fy: string): string {
  const m = /^(\d{2})?(\d{2})\/(\d{2})$/.exec(fy.trim());
  return m ? `FY${m[2]}/${m[3]}` : fy;
}

/** "City Power Johannesburg" → "City Power": the issuer as it prefixes a tariff name. */
function issuerPrefix(issuer: string): string {
  return issuer.replace(/\s+Johannesburg$/i, "");
}

export function profileName(schedule: CojSchedule, tariffName: string): string {
  return `${issuerPrefix(schedule.meta.issuer)} ${tariffName} ${financialYearLabel(schedule.meta.financial_year)}`;
}

/** Every tariff in the given schedules, in the order the schedule publishes them. PURE. */
export function listCatalogue(schedules: CojSchedule[]): CatalogueEntry[] {
  return schedules.flatMap((schedule) =>
    schedule.tariffs.map((t) => ({
      tariffId: t.id,
      name: profileName(schedule, t.name),
      shortName: t.name,
      category: t.category,
      energyStructure: t.energy_structure,
      issuer: schedule.meta.issuer,
      financialYear: schedule.meta.financial_year,
      notApplied: convertTariff(schedule, t.id).unsupported,
    })),
  );
}

export interface CatalogueProfileRows {
  profile: {
    name: string;
    type: "landlord_stated";
    source: "library";
    distributor: string;
    currency: string;
    touSchedule: Record<string, unknown>;
    pricingRules: {
      vatFraction: number;
      surchargeFractionOfSubtotal?: number;
      minDemandKva?: number;
    };
    sources: Array<{ title: string; appliesTo: string[] }>;
    effectiveFrom: Date;
  };
  rates: Array<{
    chargeType: "active_energy" | "demand" | "reactive_energy" | "fixed" | "ancillary";
    unit: "c_per_kwh" | "r_per_kva" | "c_per_kvarh" | "r_per_day" | "r_per_month";
    rateValue: string;
    season: "high" | "low" | "all";
    touPeriod: "peak" | "standard" | "offpeak" | "all";
    blockThresholdKwh: string | null;
    label: string | null;
    source: string | null;
  }>;
  notApplied: UnsupportedRule[];
}

/**
 * Shape one published tariff into the rows the database stores. PURE.
 *
 * The stored form has to round-trip through `buildTariffProfile` into the same
 * profile `convertTariff` produces, or the bill priced from the database would
 * differ from the one priced from the schedule. The two things a rate row cannot
 * carry are moved to `pricing_rules`, which is where `buildTariffProfile` reads
 * them back from:
 *   - the percentage surcharge → `surchargeFractionOfSubtotal`
 *   - the minimum-demand floor → `minDemandKva`
 * Only an ENABLED surcharge with a stated basis is stored; one the source leaves
 * ambiguous stays out and is reported via `notApplied` instead.
 */
export function catalogueProfileRows(
  schedules: CojSchedule[],
  tariffId: string,
): CatalogueProfileRows {
  const schedule = schedules.find((s) => s.tariffs.some((t) => t.id === tariffId));
  if (!schedule) throw new Error(`tariff "${tariffId}" is not in any schedule on file`);
  const converted = convertTariff(schedule, tariffId);

  const surcharge = (converted.profile.surcharges ?? []).find(
    (s) => s.enabled && s.basis === "all_tariff_charges",
  );

  const { title, document_date, issuer, financial_year } = schedule.meta;
  const docTitle = title ?? `Schedule of Approved Tariffs ${financial_year}`;

  return {
    profile: {
      name: profileName(schedule, converted.name),
      type: "landlord_stated",
      source: "library",
      distributor: issuer,
      currency: converted.currency,
      touSchedule: converted.profile.touSchedule ?? {},
      pricingRules: {
        vatFraction: VAT_FRACTION,
        ...(surcharge ? { surchargeFractionOfSubtotal: surcharge.ratePercent / 100 } : {}),
        ...(converted.profile.minimumDemandKva
          ? { minDemandKva: converted.profile.minimumDemandKva }
          : {}),
      },
      sources: [{ title: `${issuer} — ${docTitle}`, appliesTo: ["rates"] }],
      // The schedule takes effect on its document date (1 July, the municipal
      // financial year start). Without one, fall back to the epoch so the profile
      // is never treated as not-yet-effective.
      effectiveFrom: new Date(document_date ? `${document_date}T00:00:00Z` : 0),
    },
    rates: converted.profile.rates.map((r) => ({
      chargeType: r.chargeType,
      unit: r.unit,
      rateValue: String(r.rateValue),
      season: r.season,
      touPeriod: r.touPeriod,
      blockThresholdKwh: r.blockThresholdKwh != null ? String(r.blockThresholdKwh) : null,
      label: r.label ?? null,
      source: r.source ?? null,
    })),
    notApplied: converted.unsupported,
  };
}
