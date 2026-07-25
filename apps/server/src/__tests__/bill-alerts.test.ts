import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  alertDeliveries,
  alerts,
  billingPeriods,
  getDb,
  meters,
  siteAccess,
  siteTariffAssignments,
  sites,
  tariffProfiles,
  tariffRates,
  user,
} from "@sparks/db";
import { eq, inArray, sql } from "drizzle-orm";
import { evaluateBillThresholds } from "../routers";

// Proof of the live bill-alert sweep: a site with a Rand threshold gets one
// in-app/email/SMS alert when its estimate crosses the threshold, deduped to once
// per billing period. Email/SMS are no-ops under NODE_ENV=test, so this exercises
// the full dispatch and asserts the persisted alert.

const db = getDb();
const orgId = "bill-alert-org";
const ownerUserId = "bill-alert-owner";

let siteId: string;
let meterId: string;

async function seedRaw(iso: string, kwh: number, kvah: number) {
  await db.execute(sql`
    INSERT INTO readings (meter_id, "time", measured_at, energy_import_kwh, energy_kvah)
    VALUES (${meterId}, ${iso}, ${iso}, ${kwh}, ${kvah})
  `);
}

async function billThresholdAlerts() {
  return db.select().from(alerts).where(eq(alerts.siteId, siteId));
}

beforeEach(async () => {
  // A recipient reachable via a site-access grant (no org row needed).
  await db
    .insert(user)
    .values({ id: ownerUserId, name: "Owner", email: "bill-alert-owner@example.com" })
    .onConflictDoNothing();

  const [site] = await db
    .insert(sites)
    .values({
      organizationId: orgId,
      name: "Bill Alert Site",
      timezone: "Africa/Johannesburg",
      demandIntervalMinutes: 30,
      status: "active",
      billAlertThresholdCents: 1_000_000, // R10,000
      billAlertBasis: "actual",
    })
    .returning();
  siteId = site.id;

  await db.insert(siteAccess).values({ siteId, userId: ownerUserId, role: "owner" });

  const [meter] = await db
    .insert(meters)
    .values({ siteId, serialNumber: `bill-alert-${Date.now()}`, model: "SDM630" })
    .returning();
  meterId = meter.id;

  // A concrete billing period containing our reference instant, so the estimate's
  // window is deterministic (not calendar-month-relative).
  await db.insert(billingPeriods).values({
    siteId,
    periodStart: new Date("2026-08-01T00:00:00Z"),
    periodEnd: new Date("2026-09-01T00:00:00Z"),
    boundaryInclusivity: "half_open",
    demandIntervalMinutes: 30,
    label: "Aug 2026",
    source: "manual",
    status: "open",
  });

  // Landlord tariff: flat R2.50/kWh active energy (stored as published cents).
  const [profile] = await db
    .insert(tariffProfiles)
    .values({
      organizationId: orgId,
      name: "Bill Alert Tariff",
      type: "landlord_stated",
      source: "custom",
      currency: "ZAR",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    })
    .returning();
  await db.insert(tariffRates).values({
    tariffProfileId: profile.id,
    chargeType: "active_energy",
    unit: "c_per_kwh",
    rateValue: "250",
    season: "all",
    touPeriod: "all",
  });
  await db.insert(siteTariffAssignments).values({
    siteId,
    tariffProfileId: profile.id,
    role: "landlord",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  });

  // 8,000 kWh consumed inside the period → R20,000 estimate.
  await seedRaw("2026-08-10T00:00:00Z", 1000, 1000);
  await seedRaw("2026-08-10T00:30:00Z", 5000, 1006);
  await seedRaw("2026-08-10T01:00:00Z", 9000, 1011);
});

afterEach(async () => {
  const siteAlerts = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(eq(alerts.siteId, siteId));
  if (siteAlerts.length > 0) {
    await db.delete(alertDeliveries).where(
      inArray(
        alertDeliveries.alertId,
        siteAlerts.map((a) => a.id),
      ),
    );
  }
  await db.delete(alerts).where(eq(alerts.siteId, siteId));
  await db.execute(sql`DELETE FROM readings WHERE meter_id = ${meterId}`);
  await db.delete(siteTariffAssignments).where(eq(siteTariffAssignments.siteId, siteId));
  // tariff_rates cascade-delete with their profile.
  await db.delete(tariffProfiles).where(eq(tariffProfiles.organizationId, orgId));
  await db.delete(billingPeriods).where(eq(billingPeriods.siteId, siteId));
  await db.delete(meters).where(eq(meters.id, meterId));
  await db.delete(siteAccess).where(eq(siteAccess.siteId, siteId));
  await db.delete(sites).where(eq(sites.id, siteId));
  await db.delete(user).where(eq(user.id, ownerUserId));
});

const NOW = new Date("2026-08-15T00:00:00Z");

describe("evaluateBillThresholds", () => {
  it("fires one alert when the estimate crosses the threshold", async () => {
    const res = await evaluateBillThresholds(NOW);
    expect(res.fired).toBe(1);

    const created = await billThresholdAlerts();
    expect(created.length).toBe(1);
    expect(created[0].type).toBe("bill_threshold");
    expect(created[0].title).toContain("10,000.00");
    const payload = created[0].payload as { basisLabel?: string };
    expect(payload.basisLabel).toBe("charges so far");

    // last-fired marker was stamped with the period start.
    const site = await db.query.sites.findFirst({ where: eq(sites.id, siteId) });
    expect(site?.billAlertLastFiredPeriodStart?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("does not fire again in the same billing period (dedupe)", async () => {
    await evaluateBillThresholds(NOW);
    const second = await evaluateBillThresholds(NOW);
    expect(second.fired).toBe(0);
    expect((await billThresholdAlerts()).length).toBe(1);
  });

  it("does not fire when the estimate is below the threshold", async () => {
    await db
      .update(sites)
      .set({ billAlertThresholdCents: 5_000_000, billAlertLastFiredPeriodStart: null }) // R50,000
      .where(eq(sites.id, siteId));
    const res = await evaluateBillThresholds(NOW);
    expect(res.fired).toBe(0);
    expect((await billThresholdAlerts()).length).toBe(0);
  });

  it("ignores sites with no threshold set", async () => {
    await db
      .update(sites)
      .set({ billAlertThresholdCents: null, billAlertLastFiredPeriodStart: null })
      .where(eq(sites.id, siteId));
    const res = await evaluateBillThresholds(NOW);
    // Our site is not in the checked set at all.
    expect((await billThresholdAlerts()).length).toBe(0);
    expect(res.fired).toBe(0);
  });
});
