/**
 * Seed the City Power "LV Demand Non-TOU" (a.k.a. Industrial LV / "JHB E LVD
 * NON-TOU") tariff cards into the shared library, for both roles, so operators
 * can assign them to Johannesburg sites (e.g. Life Grand Cafe, Mall of the South).
 *
 * Sources:
 *  - FY25/26 rates: transcribed from the Metronomic landlord bills for unit F112
 *    (MAR/APR/MAY 26) — verified cents-exact by tariffs-city-power.test.ts.
 *    (The winter energy rate is FY26/27 ÷ 1.0901, as bills only cover summer.)
 *  - FY26/27 rates: City Power "Schedule of Approved Tariffs FY26/27" (1 Jul 2026),
 *    Industrial LV card p5, 6c/kWh network surcharge p7, 70 kVA minimum demand p7.
 *
 * Idempotent: skips any profile whose (name, type) already exists. Writes ONLY
 * the library (organization_id NULL); assigns nothing to any site.
 *
 * Usage (from apps/server):  bun scripts/seed-city-power-tariffs.ts
 */
import "dotenv/config";
import { getDb, tariffProfiles, tariffRates } from "@sparks/db";
import { and, eq, isNull } from "drizzle-orm";

const db = getDb();

const RULES = {
  minDemandKva: 70,
  reactiveAllowanceFactorOfKwh: 0.3,
  surchargeFractionOfSubtotal: 0.02,
  vatFraction: 0.15,
};

interface Card {
  name: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  energyLow: number; // summer (Sep–May) c/kWh AS PUBLISHED
  energyHigh: number; // winter (Jun–Aug) c/kWh AS PUBLISHED
  demand: number; // R/kVA
  reactive: number; // c/kVArh on the excess over 30% of kWh
  networkSurchPerKwh: number; // c/kWh rider
  serviceMonthly: number;
  capacityMonthly: number;
}

const CARDS: Card[] = [
  {
    name: "City Power Industrial LV (Non-TOU) FY25/26",
    effectiveFrom: "2025-07-01T00:00:00Z",
    effectiveTo: "2026-07-01T00:00:00Z",
    energyLow: 261.41,
    energyHigh: 306.23,
    demand: 423.1,
    reactive: 42.43,
    networkSurchPerKwh: 6,
    serviceMonthly: 1401.44,
    capacityMonthly: 2140.13,
  },
  {
    name: "City Power Industrial LV (Non-TOU) FY26/27",
    effectiveFrom: "2026-07-01T00:00:00Z",
    effectiveTo: null,
    energyLow: 284.96,
    energyHigh: 333.79,
    demand: 461.22,
    reactive: 46.25,
    networkSurchPerKwh: 6,
    serviceMonthly: 1527.71,
    capacityMonthly: 2332.96,
  },
];

async function seedCard(card: Card, type: "landlord_stated" | "legal_ceiling") {
  const existing = await db.query.tariffProfiles.findFirst({
    where: and(
      eq(tariffProfiles.name, card.name),
      eq(tariffProfiles.type, type),
      isNull(tariffProfiles.organizationId),
    ),
  });
  if (existing) {
    console.log(`= exists: ${card.name} [${type}]`);
    return;
  }

  const [profile] = await db
    .insert(tariffProfiles)
    .values({
      organizationId: null,
      name: card.name,
      type,
      source: "library",
      supplyZone: "Johannesburg",
      distributor: "City Power Johannesburg",
      currency: "ZAR",
      touSchedule: {}, // non-TOU; high season defaults to Jun–Aug
      pricingRules: RULES,
      effectiveFrom: new Date(card.effectiveFrom),
      effectiveTo: card.effectiveTo ? new Date(card.effectiveTo) : null,
    })
    .returning({ id: tariffProfiles.id });

  const rows = [
    { chargeType: "active_energy", unit: "c_per_kwh", rateValue: card.energyLow, season: "low" },
    { chargeType: "active_energy", unit: "c_per_kwh", rateValue: card.energyHigh, season: "high" },
    { chargeType: "demand", unit: "r_per_kva", rateValue: card.demand, season: "all" },
    { chargeType: "reactive_energy", unit: "c_per_kvarh", rateValue: card.reactive, season: "all" },
    {
      chargeType: "ancillary",
      unit: "c_per_kwh",
      rateValue: card.networkSurchPerKwh,
      season: "all",
    },
    { chargeType: "fixed", unit: "r_per_month", rateValue: card.serviceMonthly, season: "all" },
    { chargeType: "fixed", unit: "r_per_month", rateValue: card.capacityMonthly, season: "all" },
  ] as const;

  await db.insert(tariffRates).values(
    rows.map((r) => ({
      tariffProfileId: profile.id,
      chargeType: r.chargeType,
      unit: r.unit,
      rateValue: String(r.rateValue),
      season: r.season,
      touPeriod: "all" as const,
    })),
  );
  console.log(`+ created: ${card.name} [${type}] (${rows.length} rates)`);
}

for (const card of CARDS) {
  await seedCard(card, "landlord_stated");
  await seedCard(card, "legal_ceiling");
}
console.log("done.");
process.exit(0);
