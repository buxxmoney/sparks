import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, sites, siteAccess, billingCyclePolicies, billingPeriods, devices, meters } from "@sparks/db";
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

  beforeEach(async () => {
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

    // Create test device
    const deviceResult = await db
      .insert(devices)
      .values({
        serialNumber: `test-device-${Date.now()}`,
        hardwareModel: "rpi",
        connectivityMode: "lte",
        apiKeyHash: "testhash",
        status: "provisioning",
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

    it("should create site", async () => {
      const result = await sitesCreate(ownerCtx, {
        organizationId: orgId,
        name: "New Site",
        timezone: "Africa/Johannesburg",
        demandIntervalMinutes: 15,
      });
      expect(result.name).toBe("New Site");
      expect(result.demandIntervalMinutes).toBe(15);
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

    it("should delete site as owner", async () => {
      const result = await sitesDelete(ownerCtx, { siteId });
      expect(result.deleted).toBe(siteId);
    });

    it("should deny delete site as non-owner", async () => {
      try {
        await sitesDelete(managerCtx, { siteId });
        expect.unreachable();
      } catch (e) {
        expect(e instanceof ForbiddenError).toBe(true);
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
        role: "site_manager",
      });
      expect(result.userId).toBe(otherUserId);
      expect(result.role).toBe("site_manager");
    });

    it("should deny grant without owner role", async () => {
      try {
        await siteAccessGrant(managerCtx, {
          siteId,
          userId: otherUserId,
          role: "site_manager",
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
        role: "site_manager",
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
