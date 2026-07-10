import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb, sites, siteAccess, billingCyclePolicies, billingPeriods, devices, meters, demandIntervals, user } from "@sparks/db";
import type { AuthContext } from "../middleware";
import {
  sitesList,
  sitesGet,
  sitesCreate,
  sitesUpdate,
  sitesSetDefaultDemandInterval,
  sitesDelete,
  siteAccessList,
  siteAccessGrant,
  siteAccessRevoke,
  devicesGet,
  devicesList,
  devicesProvision,
  devicesRotateKey,
  metersGet,
  metersCreate,
  metersCommission,
  billingPoliciesGet,
  billingPoliciesSet,
  billingPeriodsList,
  billingPeriodsMaterialize,
  billingPeriodsUpsert,
  billingPeriodsClose,
  demandListIntervals,
  readingsEnergyByPeriod,
} from "../routers";
import { ForbiddenError, UnauthorizedError } from "../middleware";

const db = getDb();

describe("oRPC Routers", () => {
  const orgId = "test-org-001";
  const ownerUserId = "test-owner-001";
  const managerUserId = "test-manager-001";
  const otherUserId = "test-other-001";
  let siteId: string;
  let deviceId: string;
  let meterId: string;

  const ownerCtx: AuthContext = {
    userId: ownerUserId,
    sessionId: "session-001",
    organizationId: orgId,
  };

  const managerCtx: AuthContext = {
    userId: managerUserId,
    sessionId: "session-002",
    organizationId: orgId,
  };

  const otherCtx: AuthContext = {
    userId: otherUserId,
    sessionId: "session-003",
    organizationId: "other-org",
  };

  // Sparks internal operator — the only actor allowed to provision/remove sites.
  const operatorUserId = "test-operator-001";
  const operatorCtx: AuthContext = {
    userId: operatorUserId,
    sessionId: "session-op",
    organizationId: orgId,
  };

  beforeEach(async () => {
    // Seed the platform-operator user row that requirePlatformOperator reads.
    await db
      .insert(user)
      .values({ id: operatorUserId, email: "operator@sparks.test", isPlatformOperator: true })
      .onConflictDoNothing();

    // Create test site with owner access
    const siteResult = await db
      .insert(sites)
      .values({
        organizationId: orgId,
        name: "Test Site",
        timezone: "Africa/Johannesburg",
        demandIntervalMinutes: 30,
        status: "active",
      })
      .returning();

    siteId = siteResult[0].id;

    // Grant owner access
    await db.insert(siteAccess).values({
      siteId,
      userId: ownerUserId,
      role: "owner",
    });

    // Grant manager access
    await db.insert(siteAccess).values({
      siteId,
      userId: managerUserId,
      role: "site_manager",
    });

    // Create test device — ASSIGNED to the site, so the site owner can manage it
    // (unassigned devices are operator-only; see audit F2a/F2b).
    const deviceResult = await db
      .insert(devices)
      .values({
        siteId,
        serialNumber: `test-device-${Date.now()}`,
        hardwareModel: "rpi",
        connectivityMode: "lte",
        apiKeyHash: "testhash",
        status: "online",
      })
      .returning();

    deviceId = deviceResult[0].id;

    // Create test meter
    const meterResult = await db
      .insert(meters)
      .values({
        deviceId,
        siteId,
        serialNumber: `test-meter-${Date.now()}`,
        model: "SDM630MCT",
      })
      .returning();

    meterId = meterResult[0].id;
  });

  afterEach(async () => {
    await db.delete(siteAccess);
    await db.delete(meters);
    await db.delete(devices);
    await db.delete(billingPeriods);
    await db.delete(billingCyclePolicies);
    await db.delete(sites);
    await db.delete(user).where(eq(user.id, operatorUserId));
  });

  /* ─────────────── Demand (charts) Tests ─────────────── */

  describe("Demand Router — listIntervals", () => {
    it("returns clock-aligned intervals in the window, oldest→newest", async () => {
      const base = new Date("2026-07-15T00:00:00Z");
      // Insert three 30-min intervals out of order to prove ordering.
      await db.insert(demandIntervals).values([
        { meterId, siteId, intervalStart: new Date(base.getTime() + 60 * 60000), intervalMinutes: 30, activeEnergyKwh: "3.000", avgDemandKw: "6.000", avgDemandKva: "6.500", reactiveEnergyKvarh: "1.000", sampleCount: 30, expectedSamples: 30, isComplete: true },
        { meterId, siteId, intervalStart: base, intervalMinutes: 30, activeEnergyKwh: "1.000", avgDemandKw: "2.000", avgDemandKva: "2.200", reactiveEnergyKvarh: "0.500", sampleCount: 30, expectedSamples: 30, isComplete: true },
        { meterId, siteId, intervalStart: new Date(base.getTime() + 30 * 60000), intervalMinutes: 30, activeEnergyKwh: "2.000", avgDemandKw: "4.000", avgDemandKva: "4.300", reactiveEnergyKvarh: "0.800", sampleCount: 30, expectedSamples: 30, isComplete: true },
      ]);

      const res = await demandListIntervals(ownerCtx, {
        siteId,
        from: base.toISOString(),
        to: new Date(base.getTime() + 2 * 60 * 60000).toISOString(),
      });

      expect(res.intervals).toHaveLength(3);
      expect(res.intervals.map((i) => i.avgDemandKw)).toEqual(["2.000", "4.000", "6.000"]);
      expect(res.intervals[0]?.intervalStart).toBe(base.toISOString());
    });

    it("rejects a caller without access to the site", async () => {
      await expect(demandListIntervals(otherCtx, { siteId })).rejects.toThrow();
    });
  });

  /* ─────────────── Energy across billing periods ─────────────── */

  describe("Readings Router — energyByPeriod", () => {
    it("falls back to calendar-month buckets when the site has no billing periods", async () => {
      // Two intervals in the same month → one calendar bucket summing their energy.
      const base = new Date("2026-05-10T00:00:00Z");
      await db.insert(demandIntervals).values([
        { meterId, siteId, intervalStart: base, intervalMinutes: 30, activeEnergyKwh: "5.000", avgDemandKw: "1", avgDemandKva: "1", reactiveEnergyKvarh: "0.500", sampleCount: 30, expectedSamples: 30, isComplete: true },
        { meterId, siteId, intervalStart: new Date(base.getTime() + 30 * 60000), intervalMinutes: 30, activeEnergyKwh: "3.000", avgDemandKw: "1", avgDemandKva: "1", reactiveEnergyKvarh: "0.500", sampleCount: 30, expectedSamples: 30, isComplete: true },
      ]);

      const res = await readingsEnergyByPeriod(ownerCtx, { siteId });
      expect(res.basis).toBe("calendar_month");
      expect(res.periods).toHaveLength(1);
      expect(Number(res.periods[0]?.activeEnergyKwh)).toBeCloseTo(8, 3);
      expect(Number(res.periods[0]?.reactiveEnergyKvarh)).toBeCloseTo(1, 3);
    });

    it("buckets by real billing periods when the site has them", async () => {
      await db.insert(billingPeriods).values({
        siteId,
        periodStart: new Date("2026-06-01T00:00:00Z"),
        periodEnd: new Date("2026-07-01T00:00:00Z"),
        boundaryInclusivity: "half_open",
        demandIntervalMinutes: 30,
        label: "June 2026",
      });
      await db.insert(demandIntervals).values([
        // Inside the period → counted.
        { meterId, siteId, intervalStart: new Date("2026-06-15T00:00:00Z"), intervalMinutes: 30, activeEnergyKwh: "10.000", avgDemandKw: "1", avgDemandKva: "1", reactiveEnergyKvarh: "2.000", sampleCount: 30, expectedSamples: 30, isComplete: true },
        // Outside (next month) → excluded from the June bucket.
        { meterId, siteId, intervalStart: new Date("2026-07-15T00:00:00Z"), intervalMinutes: 30, activeEnergyKwh: "99.000", avgDemandKw: "1", avgDemandKva: "1", reactiveEnergyKvarh: "9.000", sampleCount: 30, expectedSamples: 30, isComplete: true },
      ]);

      const res = await readingsEnergyByPeriod(ownerCtx, { siteId });
      expect(res.basis).toBe("billing_period");
      expect(res.periods).toHaveLength(1);
      expect(res.periods[0]?.label).toBe("June 2026");
      expect(Number(res.periods[0]?.activeEnergyKwh)).toBeCloseTo(10, 3);
    });

    it("rejects a caller without access to the site", async () => {
      await expect(readingsEnergyByPeriod(otherCtx, { siteId })).rejects.toThrow();
    });
  });

  /* ─────────────── Sites Tests ─────────────── */

  describe("Sites Router", () => {
    it("should list sites in org", async () => {
      const result = await sitesList(ownerCtx, { organizationId: orgId });
      expect(result.sites).toHaveLength(1);
      expect(result.sites[0].name).toBe("Test Site");
    });

    it("should deny cross-org list", async () => {
      try {
        await sitesList(otherCtx, { organizationId: orgId });
        expect.unreachable();
      } catch (e) {
        expect(e instanceof ForbiddenError).toBe(true);
      }
    });

    it("should get site with access", async () => {
      const result = await sitesGet(ownerCtx, { siteId });
      expect(result.id).toBe(siteId);
      expect(result.name).toBe("Test Site");
    });

    it("should deny get site without access", async () => {
      try {
        await sitesGet(otherCtx, { siteId });
        expect.unreachable();
      } catch (e) {
        expect(e instanceof ForbiddenError || e instanceof UnauthorizedError).toBe(true);
      }
    });

    it("should create site as a platform operator", async () => {
      const result = await sitesCreate(operatorCtx, {
        organizationId: orgId,
        name: "New Site",
        timezone: "Africa/Johannesburg",
        demandIntervalMinutes: 15,
      });
      expect(result.name).toBe("New Site");
      expect(result.demandIntervalMinutes).toBe(15);
    });

    it("should deny site creation to a non-operator org owner", async () => {
      try {
        await sitesCreate(ownerCtx, {
          organizationId: orgId,
          name: "Customer-made Site",
          timezone: "Africa/Johannesburg",
          demandIntervalMinutes: 30,
        });
        expect.unreachable();
      } catch (e) {
        expect(e instanceof ForbiddenError).toBe(true);
      }
    });

    it("should update site", async () => {
      const result = await sitesUpdate(ownerCtx, {
        siteId,
        name: "Updated Site",
      });
      expect(result.updated).toContain("name");
    });

    it("should set demand interval", async () => {
      const result = await sitesSetDefaultDemandInterval(ownerCtx, {
        siteId,
        demandIntervalMinutes: 15,
      });
      expect(result.demandIntervalMinutes).toBe(15);
    });

    it("should deny set demand interval without access", async () => {
      try {
        await sitesSetDefaultDemandInterval(otherCtx, {
          siteId,
          demandIntervalMinutes: 15,
        });
        expect.unreachable();
      } catch (e) {
        expect(e instanceof ForbiddenError || e instanceof UnauthorizedError).toBe(true);
      }
    });

    it("should delete site as a platform operator", async () => {
      const result = await sitesDelete(operatorCtx, { siteId });
      expect(result.deleted).toBe(siteId);
    });

    it("should deny delete site to a non-operator (org owner or manager)", async () => {
      for (const ctx of [ownerCtx, managerCtx]) {
        try {
          await sitesDelete(ctx, { siteId });
          expect.unreachable();
        } catch (e) {
          expect(e instanceof ForbiddenError).toBe(true);
        }
      }
    });
  });

  /* ─────────────── Site Access Tests ─────────────── */

  describe("Site Access Router", () => {
    it("should list site access", async () => {
      const result = await siteAccessList(ownerCtx, { siteId });
      expect(result.grants.length).toBeGreaterThanOrEqual(1);
    });

    it("should grant site access", async () => {
      const result = await siteAccessGrant(ownerCtx, {
        siteId,
        userId: otherUserId,
        role: "editor",
      });
      expect(result.userId).toBe(otherUserId);
      expect(result.role).toBe("editor");
    });

    it("should deny grant without owner role", async () => {
      try {
        await siteAccessGrant(managerCtx, {
          siteId,
          userId: otherUserId,
          role: "editor",
        });
        expect.unreachable();
      } catch (e) {
        expect(e instanceof ForbiddenError).toBe(true);
      }
    });

    it("should revoke site access", async () => {
      await siteAccessGrant(ownerCtx, {
        siteId,
        userId: otherUserId,
        role: "editor",
      });

      const result = await siteAccessRevoke(ownerCtx, {
        siteId,
        userId: otherUserId,
      });
      expect(result.revoked).toBe(true);
    });

    it("should deny revoke without owner role", async () => {
      try {
        await siteAccessRevoke(managerCtx, {
          siteId,
          userId: otherUserId,
        });
        expect.unreachable();
      } catch (e) {
        expect(e instanceof ForbiddenError).toBe(true);
      }
    });
  });

  /* ─────────────── Devices Tests ─────────────── */

  describe("Devices Router", () => {
    it("should list devices", async () => {
      const result = await devicesList(ownerCtx, { limit: 50 });
      expect(Array.isArray(result.devices)).toBe(true);
    });

    it("should get device", async () => {
      const result = await devicesGet(ownerCtx, { deviceId });
      expect(result.id).toBe(deviceId);
    });

    it("should provision device", async () => {
      const result = await devicesProvision(ownerCtx, {
        organizationId: orgId,
        serialNumber: `new-device-${Date.now()}`,
      });
      expect(result.deviceId).toBeDefined();
      expect(result.deviceSecret).toBeDefined();
      expect(result.deviceSecret.length).toBe(64);
    });

    it("should deny provision in different org", async () => {
      try {
        await devicesProvision(otherCtx, {
          organizationId: orgId,
          serialNumber: `new-device-${Date.now()}`,
        });
        expect.unreachable();
      } catch (e) {
        expect(e instanceof ForbiddenError).toBe(true);
      }
    });

    it("should rotate device key", async () => {
      const result = await devicesRotateKey(ownerCtx, { deviceId });
      expect(result.deviceSecret).toBeDefined();
      expect(result.deviceSecret.length).toBe(64);
    });
  });

  /* ─────────────── Meters Tests ─────────────── */

  describe("Meters Router", () => {
    it("should get meter", async () => {
      const result = await metersGet(ownerCtx, { meterId });
      expect(result.id).toBe(meterId);
      expect(result.siteId).toBe(siteId);
    });

    it("should deny get meter without site access", async () => {
      try {
        await metersGet(otherCtx, { meterId });
        expect.unreachable();
      } catch (e) {
        expect(e instanceof ForbiddenError || e instanceof UnauthorizedError).toBe(true);
      }
    });

    it("should create meter", async () => {
      const result = await metersCreate(ownerCtx, {
        deviceId,
        siteId,
        serialNumber: `meter-${Date.now()}`,
        model: "SDM630MCT",
      });
      expect(result.meterId).toBeDefined();
    });

    it("should commission meter", async () => {
      const result = await metersCommission(ownerCtx, {
        meterId,
        installedByName: "Test Installer",
        installerRegistration: "LIC-001",
      });
      expect(result.meterId).toBe(meterId);
      expect(result.commissionedAt).toBeDefined();
    });

    it("should deny commission without site access", async () => {
      try {
        await metersCommission(otherCtx, {
          meterId,
        });
        expect.unreachable();
      } catch (e) {
        expect(e instanceof ForbiddenError || e instanceof UnauthorizedError).toBe(true);
      }
    });
  });

  /* ─────────────── Billing Tests ─────────────── */

  describe("Billing Router", () => {
    it("should get billing policy", async () => {
      await db
        .insert(billingCyclePolicies)
        .values({
          siteId,
          recurrence: "calendar_month",
          boundaryInclusivity: "half_open",
          effectiveFrom: new Date(),
        });

      const result = await billingPoliciesGet(ownerCtx, { siteId });
      expect(result).toBeDefined();
    });

    it("should set billing policy", async () => {
      const result = await billingPoliciesSet(ownerCtx, {
        siteId,
        recurrence: "day_of_month",
        anchorDay: 20,
        boundaryInclusivity: "half_open",
      });
      expect(result.recurrence).toBe("day_of_month");
      expect(result.version).toBe(1);
    });

    it("should deny set policy without site access", async () => {
      try {
        await billingPoliciesSet(otherCtx, {
          siteId,
          recurrence: "calendar_month",
          boundaryInclusivity: "half_open",
        });
        expect.unreachable();
      } catch (e) {
        expect(e instanceof ForbiddenError || e instanceof UnauthorizedError).toBe(true);
      }
    });

    it("should list billing periods", async () => {
      await db.insert(billingPeriods).values({
        siteId,
        periodStart: new Date("2026-01-01"),
        periodEnd: new Date("2026-02-01"),
        boundaryInclusivity: "half_open",
        demandIntervalMinutes: 30,
      });

      const result = await billingPeriodsList(ownerCtx, { siteId });
      expect(Array.isArray(result.periods)).toBe(true);
    });

    it("should materialize billing periods", async () => {
      await billingPoliciesSet(ownerCtx, {
        siteId,
        recurrence: "calendar_month",
        boundaryInclusivity: "half_open",
      });

      const result = await billingPeriodsMaterialize(ownerCtx, {
        siteId,
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-03-01"),
      });

      expect(Array.isArray(result.candidates)).toBe(true);
    });

    it("should upsert billing period", async () => {
      const result = await billingPeriodsUpsert(ownerCtx, {
        siteId,
        periodStart: new Date("2026-01-01"),
        periodEnd: new Date("2026-02-01"),
        source: "manual",
      });
      expect(result.periodId).toBeDefined();
    });

    it("should close billing period", async () => {
      const periodResult = await db
        .insert(billingPeriods)
        .values({
          siteId,
          periodStart: new Date("2026-01-01"),
          periodEnd: new Date("2026-02-01"),
          boundaryInclusivity: "half_open",
          demandIntervalMinutes: 30,
          status: "open",
        })
        .returning();

      const result = await billingPeriodsClose(ownerCtx, {
        periodId: periodResult[0].id,
      });
      expect(result.status).toBe("closed");
    });

    it("should deny close period without site access", async () => {
      const periodResult = await db
        .insert(billingPeriods)
        .values({
          siteId,
          periodStart: new Date("2026-01-01"),
          periodEnd: new Date("2026-02-01"),
          boundaryInclusivity: "half_open",
          demandIntervalMinutes: 30,
        })
        .returning();

      try {
        await billingPeriodsClose(otherCtx, {
          periodId: periodResult[0].id,
        });
        expect.unreachable();
      } catch (e) {
        expect(e instanceof ForbiddenError || e instanceof UnauthorizedError).toBe(true);
      }
    });
  });
});
