import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDb, member, organization, siteAccess, siteInvitations, sites, user } from "@sparks/db";
import { and, eq } from "drizzle-orm";
import type { AuthContext } from "../middleware";
import {
  siteInvitesAccept,
  siteInvitesCancel,
  siteInvitesCreate,
  siteInvitesList,
} from "../routers";

const db = getDb();

describe("Site Invitations (Slice 4)", () => {
  const orgId = "test-org-invites";
  const ownerUserId = "test-owner-invites";
  const inviteeUserId = "test-invitee-invites";
  const inviteeEmail = "invitee@example.com";
  let siteId: string;

  const ownerCtx: AuthContext = {
    userId: ownerUserId,
    sessionId: "sess-owner",
    organizationId: orgId,
  };
  // A fresh invitee: authenticated, but not yet a member of the org.
  const inviteeCtx: AuthContext = {
    userId: inviteeUserId,
    sessionId: "sess-invitee",
    organizationId: "",
  };

  beforeEach(async () => {
    await db
      .insert(organization)
      .values({
        id: orgId,
        name: "Invite Org",
        slug: `invite-org-${Date.now()}`,
        createdAt: new Date(),
      });
    await db.insert(user).values([
      {
        id: ownerUserId,
        name: "Owner",
        email: `owner-${Date.now()}@example.com`,
        createdAt: new Date(),
      },
      { id: inviteeUserId, name: "Invitee", email: inviteeEmail, createdAt: new Date() },
    ]);
    await db
      .insert(member)
      .values({
        id: `m-${Date.now()}`,
        organizationId: orgId,
        userId: ownerUserId,
        role: "owner",
        createdAt: new Date(),
      });

    const [site] = await db
      .insert(sites)
      .values({
        organizationId: orgId,
        name: "Invite Site",
        timezone: "Africa/Johannesburg",
        demandIntervalMinutes: 30,
        status: "active",
      })
      .returning();
    siteId = site.id;
  });

  afterEach(async () => {
    await db.delete(siteInvitations);
    await db.delete(siteAccess);
    await db.delete(sites);
    await db.delete(member);
    await db.delete(user);
    await db.delete(organization);
  });

  it("org owner creates a pending invite", async () => {
    const result = await siteInvitesCreate(ownerCtx, {
      siteId,
      email: inviteeEmail,
      role: "editor",
    });
    expect(result.inviteId).toBeDefined();
    expect(result.email).toBe(inviteeEmail);

    const invite = await db.query.siteInvitations.findFirst({
      where: eq(siteInvitations.id, result.inviteId),
    });
    expect(invite?.status).toBe("pending");
    expect(invite?.siteId).toBe(siteId);
    expect(invite?.token.length).toBeGreaterThan(20);
  });

  it("accepting the invite makes the invitee an org member with a site_access grant", async () => {
    await siteInvitesCreate(ownerCtx, { siteId, email: inviteeEmail, role: "editor" });
    const invite = await db.query.siteInvitations.findFirst({
      where: eq(siteInvitations.siteId, siteId),
    });

    const result = await siteInvitesAccept(inviteeCtx, { token: invite!.token });
    expect(result.siteId).toBe(siteId);

    // Org membership created (non-owner).
    const membership = await db.query.member.findFirst({
      where: and(eq(member.userId, inviteeUserId), eq(member.organizationId, orgId)),
    });
    expect(membership).toBeDefined();
    expect(membership?.role).toBe("member");

    // Site access grant created.
    const access = await db.query.siteAccess.findFirst({
      where: and(eq(siteAccess.siteId, siteId), eq(siteAccess.userId, inviteeUserId)),
    });
    expect(access?.role).toBe("editor");

    // Invite marked accepted.
    const updated = await db.query.siteInvitations.findFirst({
      where: eq(siteInvitations.id, invite!.id),
    });
    expect(updated?.status).toBe("accepted");
    expect(updated?.acceptedByUserId).toBe(inviteeUserId);
  });

  it("rejects acceptance by a user whose email does not match the invite", async () => {
    await siteInvitesCreate(ownerCtx, {
      siteId,
      email: "someone-else@example.com",
      role: "editor",
    });
    const invite = await db.query.siteInvitations.findFirst({
      where: eq(siteInvitations.siteId, siteId),
    });

    try {
      await siteInvitesAccept(inviteeCtx, { token: invite!.token });
      expect.unreachable("Should have thrown");
    } catch (e: unknown) {
      expect((e as Error).message).toContain("different email");
    }
  });

  it("rejects an expired invite", async () => {
    await siteInvitesCreate(ownerCtx, { siteId, email: inviteeEmail, role: "editor" });
    const invite = await db.query.siteInvitations.findFirst({
      where: eq(siteInvitations.siteId, siteId),
    });
    await db
      .update(siteInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(siteInvitations.id, invite!.id));

    try {
      await siteInvitesAccept(inviteeCtx, { token: invite!.token });
      expect.unreachable("Should have thrown");
    } catch (e: unknown) {
      expect((e as Error).message).toContain("expired");
    }
  });

  it("denies invite creation by a non-owner member", async () => {
    // Make the invitee an ordinary member (not owner, no site grant).
    await db
      .insert(member)
      .values({
        id: `m2-${Date.now()}`,
        organizationId: orgId,
        userId: inviteeUserId,
        role: "member",
        createdAt: new Date(),
      });
    const memberCtx: AuthContext = {
      userId: inviteeUserId,
      sessionId: "sess-m",
      organizationId: orgId,
    };

    try {
      await siteInvitesCreate(memberCtx, { siteId, email: "x@example.com", role: "editor" });
      expect.unreachable("Should have thrown");
    } catch (e: unknown) {
      expect((e as Error).name).toBe("ForbiddenError");
    }
  });

  it("lists pending invites and cancels one", async () => {
    const created = await siteInvitesCreate(ownerCtx, {
      siteId,
      email: inviteeEmail,
      role: "editor",
    });

    const listed = await siteInvitesList(ownerCtx, { siteId });
    expect(listed.invites.length).toBe(1);

    await siteInvitesCancel(ownerCtx, { inviteId: created.inviteId });

    const afterCancel = await siteInvitesList(ownerCtx, { siteId });
    expect(afterCancel.invites.length).toBe(0);
  });
});
