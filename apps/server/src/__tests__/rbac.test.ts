import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, sites, siteAccess } from "@sparks/db";
import { eq, and } from "drizzle-orm";
import {
  requireOrg,
  requireSiteAccess,
  ForbiddenError,
  type AuthContext,
} from "../middleware";
import { sessionMe } from "../procedures";

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
