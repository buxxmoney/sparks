/**
 * Seed a site with realistic measured data so the dashboard + reconciliation show
 * non-zero numbers WITHOUT hand-signing the device HMAC path (which the live
 * /device/commission + /ingest routes and the test suite already cover).
 *
 * Inserts: a device + meter for the site, a full current-month billing period,
 * and one day (24 × 60-min) of demand_intervals. Idempotent-ish: re-running adds
 * another day of intervals; billing period + device/meter are only created once.
 *
 * Usage (from apps/server):
 *   bun scripts/seed-demo-data.ts <siteId>
 *
 * Targets the same DB as the dev server (loads apps/server/.env).
 */
import "dotenv/config";
import {
  billingPeriods,
  demandIntervals,
  devices,
  getDb,
  meters,
  siteTariffAssignments,
  sites,
  tariffProfiles,
  tariffRates,
} from "@sparks/db";
import { and, eq } from "drizzle-orm";

const siteId = process.argv[2];
if (!siteId) {
  console.error("Usage: bun scripts/seed-demo-data.ts <siteId>");
  process.exit(1);
}

const db = getDb();

const site = await db.query.sites.findFirst({ where: eq(sites.id, siteId) });
if (!site) {
  console.error(
    `✗ No site with id "${siteId}". Create the site first (operator → /admin or /sites/new).`,
  );
  process.exit(1);
}

// Device + meter (reuse if the site already has one).
let meter = await db.query.meters.findFirst({ where: eq(meters.siteId, siteId) });
if (!meter) {
  const [device] = await db
    .insert(devices)
    .values({
      siteId,
      serialNumber: `demo-device-${Date.now()}`,
      hardwareModel: "rpi",
      apiKeyHash: "demo-seed-not-a-real-key",
      status: "online",
      lastSeenAt: new Date(),
    })
    .returning();
  [meter] = await db
    .insert(meters)
    .values({
      deviceId: device.id,
      siteId,
      serialNumber: `demo-meter-${Date.now()}`,
      model: "SDM630MCT",
      midCertifiedVariant: true,
      midCertificateRef: "MID/DEMO-2026-001",
      ctRatioPrimary: 100,
      ctRatioSecondary: 5,
      phaseConfig: "3P4W",
      installedByName: "Demo Installer",
      installerRegistration: "ELE-DEMO",
      commissionedAt: new Date(),
    })
    .returning();
  console.log(`  + created device + meter for site`);
}

// Current-month billing period (calendar month, half-open).
const now = new Date();
const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

let period = await db.query.billingPeriods.findFirst({
  where: and(eq(billingPeriods.siteId, siteId), eq(billingPeriods.periodStart, periodStart)),
});
if (!period) {
  [period] = await db
    .insert(billingPeriods)
    .values({
      siteId,
      periodStart,
      periodEnd,
      boundaryInclusivity: "half_open",
      demandIntervalMinutes: site.demandIntervalMinutes ?? 30,
      label: periodStart.toLocaleString("en-ZA", { month: "long", year: "numeric" }),
      source: "generated",
      status: "open",
    })
    .returning();
  console.log(`  + created billing period ${period.label}`);
}

// Landlord tariff + legal-ceiling tariff, assigned to the site. Reconciliation
// REQUIRES a landlord tariff effective during the period; the attorney-validated
// ceiling lets the sealed PDF generate. Only created once per org.
const existingLandlord = await db.query.siteTariffAssignments.findFirst({
  where: and(eq(siteTariffAssignments.siteId, siteId), eq(siteTariffAssignments.role, "landlord")),
});
if (!existingLandlord) {
  const [landlord] = await db
    .insert(tariffProfiles)
    .values({
      organizationId: site.organizationId,
      name: "Demo Landlord Tariff",
      type: "landlord_stated",
      source: "custom",
      currency: "ZAR",
      effectiveFrom: new Date("2020-01-01"),
    })
    .returning();
  await db.insert(tariffRates).values([
    {
      tariffProfileId: landlord.id,
      chargeType: "active_energy",
      unit: "c_per_kwh",
      rateValue: "2.20",
      season: "all",
      touPeriod: "all",
    },
    {
      tariffProfileId: landlord.id,
      chargeType: "demand",
      unit: "r_per_kva",
      rateValue: "95.00",
      season: "all",
      touPeriod: "all",
    },
    {
      tariffProfileId: landlord.id,
      chargeType: "fixed",
      unit: "r_per_month",
      rateValue: "350.00",
      season: "all",
      touPeriod: "all",
    },
  ]);
  await db.insert(siteTariffAssignments).values({
    siteId,
    tariffProfileId: landlord.id,
    role: "landlord",
    effectiveFrom: new Date("2020-01-01"),
  });

  const [ceiling] = await db
    .insert(tariffProfiles)
    .values({
      organizationId: site.organizationId,
      name: "Demo Legal Ceiling (NERSA)",
      type: "legal_ceiling",
      source: "custom",
      currency: "ZAR",
      effectiveFrom: new Date("2020-01-01"),
      validatedByAttorney: true,
    })
    .returning();
  await db.insert(tariffRates).values([
    {
      tariffProfileId: ceiling.id,
      chargeType: "active_energy",
      unit: "c_per_kwh",
      rateValue: "2.60",
      season: "all",
      touPeriod: "all",
    },
    {
      tariffProfileId: ceiling.id,
      chargeType: "demand",
      unit: "r_per_kva",
      rateValue: "110.00",
      season: "all",
      touPeriod: "all",
    },
  ]);
  await db.insert(siteTariffAssignments).values({
    siteId,
    tariffProfileId: ceiling.id,
    role: "legal_ceiling",
    effectiveFrom: new Date("2020-01-01"),
  });
  console.log(
    `  + created + assigned landlord tariff (R2.20/kWh, R95/kVA, R350 fixed) + attorney-validated ceiling`,
  );
}

// One day of hourly demand intervals with a realistic load curve.
const day = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), Math.min(now.getUTCDate(), 27)),
);
const rows = [];
for (let h = 0; h < 24; h++) {
  const intervalStart = new Date(day.getTime() + h * 3600_000);
  // Load higher during working hours (peak-ish), lower overnight.
  const daytime = h >= 7 && h <= 18;
  const activeKwh = daytime ? 45 + Math.round(Math.sin(((h - 7) / 11) * Math.PI) * 20) : 12;
  const demandKva = daytime ? 60 + Math.round(Math.sin(((h - 7) / 11) * Math.PI) * 25) : 18;
  rows.push({
    meterId: meter.id,
    siteId,
    intervalStart,
    intervalMinutes: 60,
    activeEnergyKwh: activeKwh.toFixed(3),
    reactiveEnergyKvarh: (activeKwh * 0.2).toFixed(3),
    avgDemandKw: (demandKva * 0.9).toFixed(3),
    avgDemandKva: demandKva.toFixed(3),
    avgPowerFactor: "0.9000",
    sampleCount: 60,
    expectedSamples: 60,
    isComplete: true,
    source: "live" as const,
  });
}

await db.insert(demandIntervals).values(rows).onConflictDoNothing();

const totalKwh = rows.reduce((s, r) => s + Number(r.activeEnergyKwh), 0);
const maxKva = Math.max(...rows.map((r) => Number(r.avgDemandKva)));
console.log(`✓ Seeded ${rows.length} demand intervals for ${day.toISOString().slice(0, 10)}`);
console.log(`  measured active energy ≈ ${totalKwh.toFixed(0)} kWh, max demand ≈ ${maxKva} kVA`);
console.log(
  `  billing period: ${period.label} (${periodStart.toISOString().slice(0, 10)} → ${periodEnd.toISOString().slice(0, 10)})`,
);
console.log(
  `\nNext: open the site dashboard (load shows), then Invoices → upload a PDF, or Reconciliation → generate.`,
);
process.exit(0);
