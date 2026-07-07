import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, sites, siteAccess, member, organization, user } from "@sparks/db";
import { eq, and } from "drizzle-orm";
import {
  requireOrg,
  requireSiteAccess,
  requirePlatformOperator,
  isOrgOwner,
  ForbiddenError,
  type AuthContext,
} from "../middleware";
import { sessionMe } from "../procedures";
import { tariffsProfilesCreate } from "../routers";

describe("RBAC Middleware", () => {
  const testOrgId = "test-org-001";
  const testUserId = "test-user-site-manager";
  const testUserId2 = "test-user-owner";
  let testSiteId: string;
  let siblingSiteId: string;

  beforeEach(async () => {
    const db = getDb();

    // Create test sites for this org
    const siteResult = await db
      .insert(sites)
      .values({
        organizationId: testOrgId,
        name: "Test Site 1",
        timezone: "Africa/Johannesburg",
        demandIntervalMinutes: 30,
        status: "active",
      })
      .returning();

    testSiteId = siteResult[0].id;

    const siblingSiteResult = await db
      .insert(sites)
      .values({
        organizationId: testOrgId,
        name: "Test Site 2",
        timezone: "Africa/Johannesburg",
        demandIntervalMinutes: 30,
        status: "active",
      })
      .returning();

    siblingSiteId = siblingSiteResult[0].id;

    // Grant testUserId site_manager access to testSiteId only
    await db.insert(siteAccess).values({
      siteId: testSiteId,
      userId: testUserId,
      role: "site_manager",
    });

    // Grant testUserId2 owner access to testSiteId
    await db.insert(siteAccess).values({
      siteId: testSiteId,
      userId: testUserId2,
      role: "owner",
    });

    // Grant testUserId2 owner access to siblingSiteId
    await db.insert(siteAccess).values({
      siteId: siblingSiteId,
      userId: testUserId2,
      role: "owner",
    });
  });

  afterEach(async () => {
    const db = getDb();

    // Clean up test data
    await db.delete(siteAccess).where(
      and(
        eq(siteAccess.siteId, testSiteId),
        eq(siteAccess.userId, testUserId),
      ),
    );
    await db.delete(siteAccess).where(
      and(
        eq(siteAccess.siteId, testSiteId),
        eq(siteAccess.userId, testUserId2),
      ),
    );
    await db.delete(siteAccess).where(
      and(
        eq(siteAccess.siteId, siblingSiteId),
        eq(siteAccess.userId, testUserId2),
      ),
    );
    await db.delete(sites).where(eq(sites.id, testSiteId));
    await db.delete(sites).where(eq(sites.id, siblingSiteId));
  });

  it("site_manager with explicit grant can read their site", async () => {
    const authContext: AuthContext = {
      userId: testUserId,
      sessionId: "test-session",
      organizationId: testOrgId,
    };

    const result = await requireSiteAccess(authContext, testSiteId);
    expect(result.userId).toBe(testUserId);
    expect(result.siteId).toBe(testSiteId);
  });

  it("site_manager is denied access to sibling site", async () => {
    const authContext: AuthContext = {
      userId: testUserId,
      sessionId: "test-session",
      organizationId: testOrgId,
    };

    try {
      await requireSiteAccess(authContext, siblingSiteId);
      expect.unreachable("Should have thrown ForbiddenError");
    } catch (error) {
      expect(error instanceof ForbiddenError).toBe(true);
      expect((error as Error).message).toContain("No access to site");
    }
  });

  it("org owner can read all org sites", async () => {
    const authContext: AuthContext = {
      userId: testUserId2,
      sessionId: "test-session",
      organizationId: testOrgId,
    };

    // Owner should have access to testSiteId
    const result1 = await requireSiteAccess(authContext, testSiteId);
    expect(result1.siteId).toBe(testSiteId);

    // Owner should have access to siblingSiteId
    const result2 = await requireSiteAccess(authContext, siblingSiteId);
    expect(result2.siteId).toBe(siblingSiteId);
  });

  it("org membership verification works", async () => {
    const authContext: AuthContext = {
      userId: testUserId,
      sessionId: "test-session",
      organizationId: testOrgId,
    };

    // Should not throw when orgs match
    await requireOrg(authContext, testOrgId);
  });

  it("cross-org access is denied", async () => {
    const authContext: AuthContext = {
      userId: testUserId,
      sessionId: "test-session",
      organizationId: testOrgId,
    };

    try {
      await requireOrg(authContext, "different-org");
      expect.unreachable("Should have thrown ForbiddenError");
    } catch (error) {
      expect(error instanceof ForbiddenError).toBe(true);
      expect((error as Error).message).toContain("Organization mismatch");
    }
  });

  it("session.me returns current user info", async () => {
    const authContext: AuthContext = {
      userId: testUserId,
      sessionId: "test-session",
      organizationId: testOrgId,
    };

    const result = await sessionMe(authContext);
    expect(result.userId).toBe(testUserId);
    expect(result.organizationId).toBe(testOrgId);
  });

  it("site access with wrong org is denied", async () => {
    const authContext: AuthContext = {
      userId: testUserId,
      sessionId: "test-session",
      organizationId: "wrong-org",
    };

    try {
      await requireSiteAccess(authContext, testSiteId);
      expect.unreachable("Should have thrown ForbiddenError");
    } catch (error) {
      expect(error instanceof ForbiddenError).toBe(true);
      expect((error as Error).message).toContain("different organization");
    }
  });

  it("missing site returns UnauthorizedError", async () => {
    const authContext: AuthContext = {
      userId: testUserId,
      sessionId: "test-session",
      organizationId: testOrgId,
    };

    try {
      await requireSiteAccess(authContext, "550e8400-e29b-41d4-a716-000000000000");
      expect.unreachable("Should have thrown UnauthorizedError");
    } catch (error) {
      if (error instanceof Error) {
        expect(error.message).toContain("Site not found");
      }
    }
  });
});

/**
 * R2 — org plugin (member table) + platform-operator gate. These exercise the
 * NEW authorization paths: org owners reach every site in their org purely via
 * better-auth `member` (no per-site grant), and requirePlatformOperator reads the
 * real `isPlatformOperator` user flag.
 */
describe("RBAC — org membership & platform operator", () => {
  const orgId = "r2-test-org";
  const otherOrgId = "r2-other-org";
  const orgOwnerUserId = "r2-org-owner";
  const platformOpUserId = "r2-platform-op";
  const regularUserId = "r2-regular";
  let siteA: string;
  let siteB: string;

  const ownerCtx: AuthContext = {
    userId: orgOwnerUserId,
    sessionId: "r2-session-owner",
    organizationId: orgId,
  };
  const regularCtx: AuthContext = {
    userId: regularUserId,
    sessionId: "r2-session-regular",
    organizationId: orgId,
  };

  beforeEach(async () => {
    const db = getDb();

    // better-auth-owned rows: two orgs, three users, one owner membership.
    await db.insert(organization).values([
      { id: orgId, name: "R2 Org" },
      { id: otherOrgId, name: "R2 Other Org" },
    ]);
    await db.insert(user).values([
      { id: orgOwnerUserId, email: "r2-owner@example.com", isPlatformOperator: false },
      { id: platformOpUserId, email: "r2-op@example.com", isPlatformOperator: true },
      { id: regularUserId, email: "r2-regular@example.com", isPlatformOperator: false },
    ]);
    await db.insert(member).values({
      id: "r2-member-owner",
      organizationId: orgId,
      userId: orgOwnerUserId,
      role: "owner",
    });

    // Two sites in the org — NO site_access grants for the owner.
    const a = await db
      .insert(sites)
      .values({ organizationId: orgId, name: "R2 Site A", timezone: "Africa/Johannesburg", demandIntervalMinutes: 30, status: "active" })
      .returning();
    siteA = a[0].id;
    const b = await db
      .insert(sites)
      .values({ organizationId: orgId, name: "R2 Site B", timezone: "Africa/Johannesburg", demandIntervalMinutes: 30, status: "active" })
      .returning();
    siteB = b[0].id;
  });

  afterEach(async () => {
    const db = getDb();
    await db.delete(sites).where(eq(sites.id, siteA));
    await db.delete(sites).where(eq(sites.id, siteB));
    await db.delete(member).where(eq(member.organizationId, orgId));
    await db.delete(user).where(eq(user.id, orgOwnerUserId));
    await db.delete(user).where(eq(user.id, platformOpUserId));
    await db.delete(user).where(eq(user.id, regularUserId));
    await db.delete(organization).where(eq(organization.id, orgId));
    await db.delete(organization).where(eq(organization.id, otherOrgId));
  });

  it("org owner reads ALL org sites via membership (no per-site grant)", async () => {
    expect(await isOrgOwner(ownerCtx)).toBe(true);

    const ra = await requireSiteAccess(ownerCtx, siteA);
    expect(ra.siteId).toBe(siteA);
    const rb = await requireSiteAccess(ownerCtx, siteB);
    expect(rb.siteId).toBe(siteB);
  });

  it("a non-owner member with no grant is denied a site", async () => {
    // regularUser is not a member/owner and has no site_access grant.
    expect(await isOrgOwner(regularCtx)).toBe(false);
    try {
      await requireSiteAccess(regularCtx, siteA);
      expect.unreachable("Should have thrown ForbiddenError");
    } catch (error) {
      expect(error instanceof ForbiddenError).toBe(true);
      expect((error as Error).message).toContain("No access to site");
    }
  });

  it("cross-org owner cannot reach another org's site", async () => {
    const crossCtx: AuthContext = {
      userId: orgOwnerUserId,
      sessionId: "r2-session-owner",
      organizationId: otherOrgId, // owner of orgId, but acting as otherOrgId
    };
    try {
      await requireSiteAccess(crossCtx, siteA);
      expect.unreachable("Should have thrown ForbiddenError");
    } catch (error) {
      expect(error instanceof ForbiddenError).toBe(true);
      expect((error as Error).message).toContain("different organization");
    }
  });

  it("platform operator passes requirePlatformOperator", async () => {
    await requirePlatformOperator(platformOpUserId); // resolves
  });

  it("non-operator (and unknown user) cannot pass requirePlatformOperator", async () => {
    for (const uid of [regularUserId, "r2-nonexistent-user"]) {
      try {
        await requirePlatformOperator(uid);
        expect.unreachable("Should have thrown ForbiddenError");
      } catch (error) {
        expect(error instanceof ForbiddenError).toBe(true);
        expect((error as Error).message).toContain("Platform operator");
      }
    }
  });

  it("non-operator is denied an operator-only procedure (tariff library write)", async () => {
    try {
      await tariffsProfilesCreate(regularCtx, {
        name: "Illegal Library Tariff",
        type: "landlord_stated",
        source: "library",
        currency: "ZAR",
        effectiveFrom: new Date("2026-01-01"),
      });
      expect.unreachable("Should have thrown ForbiddenError");
    } catch (error) {
      expect(error instanceof ForbiddenError).toBe(true);
      expect((error as Error).message).toContain("Platform operator");
    }
  });

  it("platform operator CAN create a library tariff", async () => {
    const opCtx: AuthContext = {
      userId: platformOpUserId,
      sessionId: "r2-session-op",
      organizationId: orgId,
    };
    const result = await tariffsProfilesCreate(opCtx, {
      name: "Legit Library Tariff",
      type: "landlord_stated",
      source: "library",
      currency: "ZAR",
      effectiveFrom: new Date("2026-01-01"),
    });
    expect(result.created).toBe(true);

    // cleanup the created library profile
    const db = getDb();
    const { tariffProfiles } = await import("@sparks/db");
    await db.delete(tariffProfiles).where(eq(tariffProfiles.id, result.profileId));
  });
});
