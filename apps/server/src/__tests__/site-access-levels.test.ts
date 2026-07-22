import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDb, member, organization, siteAccess, sites, user } from "@sparks/db";
import type { AuthContext } from "../middleware";
import {
  ForbiddenError,
  requireSiteAccess,
  requireSiteAdmin,
  requireSiteEditor,
} from "../middleware";
import { orgRemoveMember, siteAccessGrant } from "../routers";

const db = getDb();

// Tiered per-site access: viewer < editor < site_admin, org owner above all.
describe("Tiered site access", () => {
  const orgId = "lvl-org";
  const ownerA = "lvl-ownerA";
  const ownerB = "lvl-ownerB";
  const adminU = "lvl-admin";
  const editorU = "lvl-editor";
  const viewerU = "lvl-viewer";
  const legacyMgr = "lvl-legacy-mgr";
  const legacyOwner = "lvl-legacy-owner";
  const outsider = "lvl-outsider";
  const operatorU = "lvl-operator";
  let siteId: string;

  // A platform operator's own org differs from the customer site's org.
  const operatorCtx: AuthContext = {
    userId: operatorU,
    sessionId: `s-${operatorU}`,
    organizationId: "sparks-ops-org",
  };

  const ctx = (userId: string): AuthContext => ({ userId, sessionId: `s-${userId}`, organizationId: orgId });

  beforeEach(async () => {
    await db.insert(organization).values({ id: orgId, name: "Lvl Org", slug: `lvl-${Date.now()}`, createdAt: new Date() });
    await db.insert(user).values(
      [ownerA, ownerB, adminU, editorU, viewerU, legacyMgr, legacyOwner, outsider].map((id) => ({
        id,
        email: `${id}@example.com`,
        isPlatformOperator: false,
      })),
    );
    // A Sparks platform operator, belonging to a DIFFERENT org (cross-tenant).
    await db
      .insert(user)
      .values({ id: operatorU, email: `${operatorU}@sparks.test`, isPlatformOperator: true });
    // Two org owners so the last-owner guard has something to protect.
    await db.insert(member).values([
      { id: `m-${ownerA}`, organizationId: orgId, userId: ownerA, role: "owner", createdAt: new Date() },
      { id: `m-${ownerB}`, organizationId: orgId, userId: ownerB, role: "owner", createdAt: new Date() },
      { id: `m-${adminU}`, organizationId: orgId, userId: adminU, role: "member", createdAt: new Date() },
      { id: `m-${editorU}`, organizationId: orgId, userId: editorU, role: "member", createdAt: new Date() },
      { id: `m-${viewerU}`, organizationId: orgId, userId: viewerU, role: "member", createdAt: new Date() },
    ]);

    const [site] = await db
      .insert(sites)
      .values({ organizationId: orgId, name: "Lvl Site", timezone: "Africa/Johannesburg", demandIntervalMinutes: 30, status: "active" })
      .returning();
    siteId = site.id;

    await db.insert(siteAccess).values([
      { siteId, userId: adminU, role: "site_admin" },
      { siteId, userId: editorU, role: "editor" },
      { siteId, userId: viewerU, role: "viewer" },
      { siteId, userId: legacyMgr, role: "site_manager" }, // legacy → editor
      { siteId, userId: legacyOwner, role: "owner" }, // legacy → site_admin
    ]);
  });

  afterEach(async () => {
    await db.delete(siteAccess).where(true as never);
    await db.delete(sites).where(true as never);
    await db.delete(member).where(true as never);
    await db.delete(organization).where(true as never);
    await db.delete(user).where(true as never);
  });

  it("viewer can read but not act; editor+ can act", async () => {
    // Read access for everyone with a grant.
    expect((await requireSiteAccess(ctx(viewerU), siteId)).level).toBe("viewer");

    // Editor gate: viewer denied, editor/admin/owner allowed.
    await expect(requireSiteEditor(ctx(viewerU), siteId)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await requireSiteEditor(ctx(editorU), siteId)).level).toBe("editor");
    expect((await requireSiteEditor(ctx(adminU), siteId)).level).toBe("site_admin");
    expect((await requireSiteEditor(ctx(ownerA), siteId)).level).toBe("org_owner");
  });

  it("platform operators get cross-tenant READ access but no writes", async () => {
    // Read any site cross-org, at the read-only "operator" level.
    expect((await requireSiteAccess(operatorCtx, siteId)).level).toBe("operator");

    // Write gates reject operators (they mutate via the admin endpoints only).
    await expect(requireSiteEditor(operatorCtx, siteId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireSiteAdmin(operatorCtx, siteId)).rejects.toBeInstanceOf(ForbiddenError);

    // A non-operator in a different org is still denied entirely.
    const strangerCtx: AuthContext = {
      userId: outsider,
      sessionId: "s-stranger",
      organizationId: "some-other-org",
    };
    await expect(requireSiteAccess(strangerCtx, siteId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("only site_admin (or owner) can manage access", async () => {
    await expect(requireSiteAdmin(ctx(editorU), siteId)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await requireSiteAdmin(ctx(adminU), siteId)).level).toBe("site_admin");
    expect((await requireSiteAdmin(ctx(ownerA), siteId)).level).toBe("org_owner");

    // An editor cannot grant; a site admin can.
    await expect(
      siteAccessGrant(ctx(editorU), { siteId, userId: outsider, role: "viewer" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const grant = await siteAccessGrant(ctx(adminU), { siteId, userId: outsider, role: "editor" });
    expect(grant.role).toBe("editor");
  });

  it("normalizes legacy roles (site_manager→editor, owner→site_admin)", async () => {
    // Legacy site_manager acts as editor: can act, cannot manage.
    expect((await requireSiteEditor(ctx(legacyMgr), siteId)).level).toBe("editor");
    await expect(requireSiteAdmin(ctx(legacyMgr), siteId)).rejects.toBeInstanceOf(ForbiddenError);
    // Legacy owner acts as site_admin: can manage.
    expect((await requireSiteAdmin(ctx(legacyOwner), siteId)).level).toBe("site_admin");
  });

  it("denies a user with no grant and no ownership", async () => {
    await expect(requireSiteAccess(ctx(outsider), siteId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("never removes the last org owner", async () => {
    // Two owners → removing one is fine.
    expect((await orgRemoveMember(ctx(ownerA), { organizationId: orgId, userId: ownerB })).removed).toBe(true);
    // Now ownerA is the only owner → cannot be removed.
    await expect(
      orgRemoveMember(ctx(ownerA), { organizationId: orgId, userId: ownerA }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
