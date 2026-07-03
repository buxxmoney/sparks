import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, sites, siteAccess, tariffProfiles, tariffRates, siteTariffAssignments } from "@sparks/db";
import { eq } from "drizzle-orm";
import type { AuthContext } from "../middleware";
import { priceUsage, type TariffProfile, type UsageData } from "../tariffs";
import {
  tariffsLibraryList,
  tariffsLibraryGet,
  tariffsProfilesCreate,
  tariffsProfilesUpdate,
  tariffsProfilesAddRate,
  tariffsProfilesListRates,
  tariffsAssignSet,
  tariffsAssignList,
} from "../routers";

const db = getDb();

describe("Tariff Pricing Helper (Pure Function)", () => {
  it("calculates simple fixed charge in cents", () => {
    const usage: UsageData = {
      activeKwh: 100,
      maxDemandKva: 5,
      reactiveKvarh: 10,
    };

    const profile: TariffProfile = {
      rates: [
        {
          chargeType: "fixed",
          unit: "r_per_month",
          rateValue: 50,
          season: "all",
          touPeriod: "all",
        },
      ],
    };

    const result = priceUsage(usage, profile);
    expect(result.fixedCents).toBe(5000);
    expect(result.totalCents).toBe(5000);
  });

  it("calculates active energy charge", () => {
    const usage: UsageData = {
      activeKwh: 100,
      maxDemandKva: 5,
      reactiveKvarh: 10,
    };

    const profile: TariffProfile = {
      rates: [
        {
          chargeType: "active_energy",
          unit: "c_per_kwh",
          rateValue: 2.5,
          season: "all",
          touPeriod: "all",
        },
      ],
    };

    const result = priceUsage(usage, profile);
    expect(result.activeEnergyCents).toBe(250);
    expect(result.totalCents).toBe(250);
  });

  it("calculates demand charge", () => {
    const usage: UsageData = {
      activeKwh: 100,
      maxDemandKva: 10,
      reactiveKvarh: 10,
    };

    const profile: TariffProfile = {
      rates: [
        {
          chargeType: "demand",
          unit: "r_per_kva",
          rateValue: 25,
          season: "all",
          touPeriod: "all",
        },
      ],
    };

    const result = priceUsage(usage, profile);
    expect(result.demandCents).toBe(25000);
    expect(result.totalCents).toBe(25000);
  });

  it("calculates reactive energy charge", () => {
    const usage: UsageData = {
      activeKwh: 100,
      maxDemandKva: 10,
      reactiveKvarh: 25,
    };

    const profile: TariffProfile = {
      rates: [
        {
          chargeType: "reactive_energy",
          unit: "c_per_kvarh",
          rateValue: 1.5,
          season: "all",
          touPeriod: "all",
        },
      ],
    };

    const result = priceUsage(usage, profile);
    expect(result.reactiveEnergyCents).toBe(3750);
    expect(result.totalCents).toBe(3750);
  });

  it("handles multiple charges in breakdown", () => {
    const usage: UsageData = {
      activeKwh: 100,
      maxDemandKva: 10,
      reactiveKvarh: 25,
    };

    const profile: TariffProfile = {
      rates: [
        {
          chargeType: "active_energy",
          unit: "c_per_kwh",
          rateValue: 2.0,
          season: "all",
          touPeriod: "all",
        },
        {
          chargeType: "demand",
          unit: "r_per_kva",
          rateValue: 20,
          season: "all",
          touPeriod: "all",
        },
        {
          chargeType: "fixed",
          unit: "r_per_month",
          rateValue: 100,
          season: "all",
          touPeriod: "all",
        },
      ],
    };

    const result = priceUsage(usage, profile);
    expect(result.activeEnergyCents).toBe(200);
    expect(result.demandCents).toBe(20000);
    expect(result.fixedCents).toBe(10000);
    expect(result.totalCents).toBe(30200);
    expect(result.details.length).toBe(3);
  });

  it("returns zero-filled breakdown with no matching rates", () => {
    const usage: UsageData = {
      activeKwh: 100,
      maxDemandKva: 5,
      reactiveKvarh: 10,
    };

    const profile: TariffProfile = {
      rates: [],
    };

    const result = priceUsage(usage, profile);
    expect(result.activeEnergyCents).toBe(0);
    expect(result.demandCents).toBe(0);
    expect(result.reactiveEnergyCents).toBe(0);
    expect(result.fixedCents).toBe(0);
    expect(result.ancillaryCents).toBe(0);
    expect(result.totalCents).toBe(0);
    expect(result.details.length).toBe(0);
  });

  it("handles fractional cents correctly (rounding)", () => {
    const usage: UsageData = {
      activeKwh: 100,
      maxDemandKva: 5,
      reactiveKvarh: 10,
    };

    const profile: TariffProfile = {
      rates: [
        {
          chargeType: "active_energy",
          unit: "c_per_kwh",
          rateValue: 2.334,
          season: "all",
          touPeriod: "all",
        },
      ],
    };

    const result = priceUsage(usage, profile);
    expect(result.activeEnergyCents).toBe(233);
  });
});

describe("Tariff Routers", () => {
  const orgId = "test-org-tariff";
  const operatorUserId = "test-operator-001";
  const siteOwnerUserId = "test-site-owner-001";
  let siteId: string;

  const operatorCtx: AuthContext = {
    userId: operatorUserId,
    sessionId: "session-op-001",
    organizationId: orgId,
  };

  const siteOwnerCtx: AuthContext = {
    userId: siteOwnerUserId,
    sessionId: "session-site-001",
    organizationId: orgId,
  };

  beforeEach(async () => {
    const siteResult = await db
      .insert(sites)
      .values({
        organizationId: orgId,
        name: "Test Tariff Site",
        timezone: "Africa/Johannesburg",
        demandIntervalMinutes: 30,
        status: "active",
      })
      .returning();

    siteId = siteResult[0].id;

    await db.insert(siteAccess).values({
      siteId,
      userId: siteOwnerUserId,
      role: "owner",
    });
  });

  afterEach(async () => {
    await db.delete(siteTariffAssignments);
    await db.delete(tariffRates);
    await db.delete(tariffProfiles);
    await db.delete(siteAccess);
    await db.delete(sites);
  });

  describe("Tariff Library Operations", () => {
    it("lists library tariffs (operator creates, anyone can list)", async () => {
      await db
        .insert(tariffProfiles)
        .values({
          name: "Standard Library Tariff",
          type: "landlord_stated",
          source: "library",
          currency: "ZAR",
          effectiveFrom: new Date("2024-01-01"),
        })
        .returning();

      const result = await tariffsLibraryList(operatorCtx, {});
      expect(result.profiles.length).toBeGreaterThanOrEqual(1);
    });

    it("gets library tariff with rates", async () => {
      const libProfile = await db
        .insert(tariffProfiles)
        .values({
          name: "Lib Tariff with Rates",
          type: "landlord_stated",
          source: "library",
          currency: "ZAR",
          effectiveFrom: new Date("2024-01-01"),
        })
        .returning();

      const libProfileId = libProfile[0].id;

      await db.insert(tariffRates).values({
        tariffProfileId: libProfileId,
        chargeType: "active_energy",
        unit: "c_per_kwh",
        rateValue: "2.50",
        season: "all",
        touPeriod: "all",
      });

      const result = await tariffsLibraryGet(operatorCtx, { tariffProfileId: libProfileId });
      expect(result.profile.id).toBe(libProfileId);
      expect(result.rates.length).toBe(1);
      expect(result.rates[0].chargeType).toBe("active_energy");
    });
  });

  describe("Tariff Profile Operations", () => {
    it("creates custom organization tariff", async () => {
      const result = await tariffsProfilesCreate(siteOwnerCtx, {
        organizationId: orgId,
        name: "Custom Org Tariff",
        type: "landlord_stated",
        source: "custom",
        currency: "ZAR",
        effectiveFrom: new Date("2024-01-01"),
      });

      expect(result.created).toBe(true);
      expect(result.profileId).toBeDefined();

      const profile = await db.query.tariffProfiles.findFirst({
        where: eq(tariffProfiles.id, result.profileId),
      });
      expect(profile?.source).toBe("custom");
      expect(profile?.organizationId).toBe(orgId);
    });

    it("prevents non-operator from creating library tariff", async () => {
      const promise = tariffsProfilesCreate(siteOwnerCtx, {
        name: "Unauthorized Lib Tariff",
        type: "landlord_stated",
        source: "library",
        currency: "ZAR",
        effectiveFrom: new Date("2024-01-01"),
      });

      try {
        await promise;
        expect.unreachable("Should have thrown");
      } catch (e: unknown) {
        expect((e as Error).name).toBe("ForbiddenError");
      }
    });

    it("adds rate to tariff profile", async () => {
      const profile = await db
        .insert(tariffProfiles)
        .values({
          organizationId: orgId,
          name: "Tariff for Rates",
          type: "landlord_stated",
          source: "custom",
          currency: "ZAR",
          effectiveFrom: new Date("2024-01-01"),
        })
        .returning();

      const profileId = profile[0].id;

      const result = await tariffsProfilesAddRate(siteOwnerCtx, {
        tariffProfileId: profileId,
        chargeType: "active_energy",
        unit: "c_per_kwh",
        rateValue: "2.50",
        season: "all",
        touPeriod: "all",
      });

      expect(result.created).toBe(true);

      const rates = await db.query.tariffRates.findMany({
        where: eq(tariffRates.tariffProfileId, profileId),
      });
      expect(rates.length).toBe(1);
      expect(rates[0].rateValue).toBe("2.50");
    });

    it("lists rates for a profile", async () => {
      const profile = await db
        .insert(tariffProfiles)
        .values({
          organizationId: orgId,
          name: "Tariff with Multiple Rates",
          type: "landlord_stated",
          source: "custom",
          currency: "ZAR",
          effectiveFrom: new Date("2024-01-01"),
        })
        .returning();

      const profileId = profile[0].id;

      await db.insert(tariffRates).values([
        {
          tariffProfileId: profileId,
          chargeType: "active_energy",
          unit: "c_per_kwh",
          rateValue: "2.50",
          season: "all",
          touPeriod: "all",
        },
        {
          tariffProfileId: profileId,
          chargeType: "demand",
          unit: "r_per_kva",
          rateValue: "25.00",
          season: "all",
          touPeriod: "all",
        },
      ]);

      const result = await tariffsProfilesListRates(siteOwnerCtx, {
        tariffProfileId: profileId,
      });

      expect(result.rates.length).toBe(2);
    });

    it("updates profile details", async () => {
      const profile = await db
        .insert(tariffProfiles)
        .values({
          organizationId: orgId,
          name: "Original Name",
          type: "landlord_stated",
          source: "custom",
          currency: "ZAR",
          effectiveFrom: new Date("2024-01-01"),
        })
        .returning();

      const profileId = profile[0].id;

      await tariffsProfilesUpdate(siteOwnerCtx, {
        tariffProfileId: profileId,
        name: "Updated Name",
        distributor: "New Distributor",
      });

      const updated = await db.query.tariffProfiles.findFirst({
        where: eq(tariffProfiles.id, profileId),
      });

      expect(updated?.name).toBe("Updated Name");
      expect(updated?.distributor).toBe("New Distributor");
    });
  });

  describe("Tariff Assignment (Enforcement)", () => {
    it("assigns landlord tariff to site", async () => {
      const profile = await db
        .insert(tariffProfiles)
        .values({
          organizationId: orgId,
          name: "Landlord Tariff",
          type: "landlord_stated",
          source: "custom",
          currency: "ZAR",
          effectiveFrom: new Date("2024-01-01"),
        })
        .returning();

      const profileId = profile[0].id;

      const result = await tariffsAssignSet(siteOwnerCtx, {
        siteId,
        tariffProfileId: profileId,
        role: "landlord",
        effectiveFrom: new Date("2024-01-01"),
      });

      expect(result.assigned).toBe(true);

      const assignment = await db.query.siteTariffAssignments.findFirst({
        where: eq(siteTariffAssignments.siteId, siteId),
      });
      expect(assignment?.role).toBe("landlord");
    });

    it("rejects legal_ceiling without attorney validation", async () => {
      const profile = await db
        .insert(tariffProfiles)
        .values({
          organizationId: orgId,
          name: "Unvalidated Ceiling",
          type: "legal_ceiling",
          source: "custom",
          currency: "ZAR",
          effectiveFrom: new Date("2024-01-01"),
          validatedByAttorney: false,
        })
        .returning();

      const profileId = profile[0].id;

      const promise = tariffsAssignSet(siteOwnerCtx, {
        siteId,
        tariffProfileId: profileId,
        role: "legal_ceiling",
        effectiveFrom: new Date("2024-01-01"),
      });

      try {
        await promise;
        expect.unreachable("Should have thrown");
      } catch (e: unknown) {
        expect((e as Error).message).toContain("attorney validation");
      }
    });

    it("allows legal_ceiling with attorney validation", async () => {
      const profile = await db
        .insert(tariffProfiles)
        .values({
          organizationId: orgId,
          name: "Validated Ceiling",
          type: "legal_ceiling",
          source: "custom",
          currency: "ZAR",
          effectiveFrom: new Date("2024-01-01"),
          validatedByAttorney: true,
        })
        .returning();

      const profileId = profile[0].id;

      const result = await tariffsAssignSet(siteOwnerCtx, {
        siteId,
        tariffProfileId: profileId,
        role: "legal_ceiling",
        effectiveFrom: new Date("2024-01-01"),
      });

      expect(result.assigned).toBe(true);

      const assignment = await db.query.siteTariffAssignments.findFirst({
        where: eq(siteTariffAssignments.role, "legal_ceiling"),
      });
      expect(assignment?.role).toBe("legal_ceiling");
      expect(assignment?.tariffProfileId).toBe(profileId);
    });

    it("lists assignments for site", async () => {
      const landlordProfile = await db
        .insert(tariffProfiles)
        .values({
          organizationId: orgId,
          name: "Landlord",
          type: "landlord_stated",
          source: "custom",
          currency: "ZAR",
          effectiveFrom: new Date("2024-01-01"),
        })
        .returning();

      const ceilingProfile = await db
        .insert(tariffProfiles)
        .values({
          organizationId: orgId,
          name: "Ceiling",
          type: "legal_ceiling",
          source: "custom",
          currency: "ZAR",
          effectiveFrom: new Date("2024-01-01"),
          validatedByAttorney: true,
        })
        .returning();

      await tariffsAssignSet(siteOwnerCtx, {
        siteId,
        tariffProfileId: landlordProfile[0].id,
        role: "landlord",
        effectiveFrom: new Date("2024-01-01"),
      });

      await tariffsAssignSet(siteOwnerCtx, {
        siteId,
        tariffProfileId: ceilingProfile[0].id,
        role: "legal_ceiling",
        effectiveFrom: new Date("2024-01-01"),
      });

      const result = await tariffsAssignList(siteOwnerCtx, { siteId });
      expect(result.assignments.length).toBe(2);
      expect(result.assignments.some((a) => a.assignment.role === "landlord")).toBe(true);
      expect(result.assignments.some((a) => a.assignment.role === "legal_ceiling")).toBe(true);
    });

    it("supersedes previous assignment when new role is assigned", async () => {
      const profile1 = await db
        .insert(tariffProfiles)
        .values({
          organizationId: orgId,
          name: "Tariff 1",
          type: "landlord_stated",
          source: "custom",
          currency: "ZAR",
          effectiveFrom: new Date("2024-01-01"),
        })
        .returning();

      const profile2 = await db
        .insert(tariffProfiles)
        .values({
          organizationId: orgId,
          name: "Tariff 2",
          type: "landlord_stated",
          source: "custom",
          currency: "ZAR",
          effectiveFrom: new Date("2024-02-01"),
        })
        .returning();

      await tariffsAssignSet(siteOwnerCtx, {
        siteId,
        tariffProfileId: profile1[0].id,
        role: "landlord",
        effectiveFrom: new Date("2024-01-01"),
      });

      await tariffsAssignSet(siteOwnerCtx, {
        siteId,
        tariffProfileId: profile2[0].id,
        role: "landlord",
        effectiveFrom: new Date("2024-02-01"),
      });

      const assignments = await db.query.siteTariffAssignments.findMany({
        where: eq(siteTariffAssignments.siteId, siteId),
      });

      const activeCount = assignments.filter((a) => !a.effectiveTo).length;
      expect(activeCount).toBe(1);
      expect(assignments[assignments.length - 1].tariffProfileId).toBe(profile2[0].id);
    });
  });
});
