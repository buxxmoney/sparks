import { randomUUID } from "node:crypto";
import { createHash, randomBytes } from "node:crypto";
import {
  alertDeliveries,
  alerts,
  billingCyclePolicies,
  billingPeriods,
  dataGaps,
  demandIntervals,
  devices,
  getDb,
  invoiceLineItems,
  landlordInvoices,
  member,
  meters,
  organization,
  readings,
  reconciliations,
  siteAccess,
  siteInvitations,
  siteTariffAssignments,
  sites,
  tariffProfiles,
  tariffRates,
  user,
} from "@sparks/db";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { auth } from "./auth";
import { type BillingPeriodPolicy, materializePeriods } from "./billing";
import { billReviewRequestEmail, sendEmail, siteInviteEmail } from "./email";
import { deriveLineCategory, parseInvoiceWithClaude, persistParsedInvoice } from "./invoices";
import type { AuthContext } from "./middleware";
import {
  ForbiddenError,
  PreconditionError,
  requireOrg,
  requireOrgOwner,
  requirePlatformOperator,
  requireSiteAccess,
  requireSiteAdmin,
  requireSiteEditor,
} from "./middleware";
import {
  buildComponentComparison,
  emptyBreakdown,
  generateReconciliation,
  priceSegments,
} from "./reconciliation";
import { dispatchInvoiceParsed } from "./notifications";
import { getObject, objectExists, putObject, signObjectUrl } from "./storage";
import type { PricingBreakdown, TariffProfile, TariffRate, UsageData } from "./tariffs";
import {
  alertsAcknowledgeInput,
  alertsAttachmentUrlInput,
  billingPeriodsCloseInput,
  billingPeriodsListInput,
  billingPeriodsMaterializeInput,
  billingPeriodsUpsertInput,
  billingPoliciesGetInput,
  billingPoliciesSetInput,
  demandListIntervalsInput,
  devicesGetHealthInput,
  devicesGetInput,
  devicesListInput,
  devicesProvisionInput,
  devicesRotateKeyInput,
  devicesUpdateSiteInput,
  invoicesConfirmInput,
  invoicesConfirmReconcileInput,
  invoicesCreateUploadInput,
  invoicesGetInput,
  invoicesListInput,
  invoicesListLineItemsInput,
  invoicesLockInput,
  invoicesReopenInput,
  invoicesRequestReviewInput,
  invoicesRetryParseInput,
  invoicesSetPeriodInput,
  invoicesUpdateLineItemInput,
  invoicesUploadAndParseInput,
  metersCommissionInput,
  metersCreateInput,
  metersGetInput,
  profileSetPhoneInput,
  orgCreateInput,
  orgGetInput,
  orgAccessOverviewInput,
  orgInviteInput,
  orgListMembersInput,
  orgRemoveMemberInput,
  orgSetMemberRoleInput,
  readingsEnergyByPeriodInput,
  readingsLatestInput,
  readingsMonthToDateInput,
  reconciliationFinalizeInput,
  reconciliationGenerateInput,
  reconciliationGeneratePdfInput,
  reconciliationGetInput,
  reconciliationListInput,
  reconciliationListVersionsInput,
  reportGetPdfInput,
  siteAccessGrantInput,
  siteAccessListInput,
  siteAccessRevokeInput,
  siteInvitesAcceptInput,
  siteInvitesCancelInput,
  siteInvitesCreateInput,
  siteInvitesListInput,
  sitesCreateInput,
  sitesDeleteInput,
  sitesGetInput,
  sitesListInput,
  sitesSetDefaultDemandIntervalInput,
  sitesUpdateInput,
  tariffsAssignListInput,
  tariffsAssignSetInput,
  tariffsLibraryGetInput,
  tariffsLibraryListInput,
  tariffsProfilesAddRateInput,
  tariffsProfilesCreateInput,
  tariffsProfilesListRatesInput,
  tariffsProfilesUpdateInput,
} from "./validators";
import { generateReportPdf } from "./workers";

const db = getDb();

/* ─────────────── Org Router ─────────────── */

// Any authenticated user may create an org; the plugin makes them its owner
// (organization row + owner member row created transactionally).
export async function orgCreate(ctx: AuthContext, input: unknown) {
  const parsed = orgCreateInput.parse(input);
  const slug =
    parsed.slug ||
    `${parsed.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40)}-${randomUUID().slice(0, 8)}`;

  const org = await auth.api.createOrganization({
    body: { name: parsed.name, slug, userId: ctx.userId },
  });

  if (!org) {
    throw new Error("Organization creation failed");
  }

  return { organizationId: org.id, organizationName: org.name };
}

export async function orgGet(ctx: AuthContext, input: unknown) {
  const parsed = orgGetInput.parse(input);
  await requireOrg(ctx, parsed.organizationId);

  const org = await db.query.organization.findFirst({
    where: eq(organization.id, parsed.organizationId),
  });

  if (!org) {
    throw new Error("Organization not found");
  }

  return {
    organizationId: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: org.createdAt,
  };
}

export async function orgListMembers(ctx: AuthContext, input: unknown) {
  const parsed = orgListMembersInput.parse(input);
  await requireOrg(ctx, parsed.organizationId);

  const rows = await db
    .select({
      userId: member.userId,
      role: member.role,
      email: user.email,
      name: user.name,
      createdAt: member.createdAt,
    })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, parsed.organizationId))
    .limit(parsed.limit || 50)
    .offset(parsed.offset || 0);

  return { members: rows, total: rows.length };
}

// Owner-guarded: invite a user to the org via the plugin's invitation flow.
export async function orgInvite(ctx: AuthContext, input: unknown) {
  const parsed = orgInviteInput.parse(input);
  await requireOrgOwner(ctx, parsed.organizationId);

  if (!ctx.headers) {
    throw new ForbiddenError("Inviting a member requires an authenticated session");
  }

  const invitation = await auth.api.createInvitation({
    headers: ctx.headers,
    body: {
      email: parsed.email,
      role: parsed.role,
      organizationId: parsed.organizationId,
    },
  });

  return {
    invitationId: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
  };
}

// Owner-guarded: change an existing member's org role via the plugin.
export async function orgSetMemberRole(ctx: AuthContext, input: unknown) {
  const parsed = orgSetMemberRoleInput.parse(input);
  await requireOrgOwner(ctx, parsed.organizationId);

  if (!ctx.headers) {
    throw new ForbiddenError("Updating a member role requires an authenticated session");
  }

  const target = await db.query.member.findFirst({
    where: and(eq(member.organizationId, parsed.organizationId), eq(member.userId, parsed.userId)),
  });

  if (!target) {
    throw new Error("Member not found");
  }

  // An organization must always keep at least one owner — refuse to demote the
  // last one (the whole point of owners: someone can always manage privileges).
  if (target.role === "owner" && parsed.role !== "owner") {
    await assertNotLastOwner(parsed.organizationId, parsed.userId);
  }

  await auth.api.updateMemberRole({
    headers: ctx.headers,
    body: {
      memberId: target.id,
      role: parsed.role,
      organizationId: parsed.organizationId,
    },
  });

  return { userId: parsed.userId, role: parsed.role };
}

// Throws if `userId` is the only remaining owner of the org (used before any
// demotion or removal so an org can never be left ownerless).
async function assertNotLastOwner(organizationId: string, userId: string): Promise<void> {
  const owners = await db
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.role, "owner")));
  const otherOwners = owners.filter((o) => o.userId !== userId);
  if (otherOwners.length === 0) {
    throw new ForbiddenError(
      "This is the organization's only owner. Add another owner before changing or removing this one.",
    );
  }
}

// Owner-guarded: remove a member from the org (and all their site grants in it).
// Cannot remove the last owner.
export async function orgRemoveMember(ctx: AuthContext, input: unknown) {
  const parsed = orgRemoveMemberInput.parse(input);
  await requireOrgOwner(ctx, parsed.organizationId);

  const target = await db.query.member.findFirst({
    where: and(eq(member.organizationId, parsed.organizationId), eq(member.userId, parsed.userId)),
  });
  if (!target) {
    throw new Error("Member not found");
  }
  if (target.role === "owner") {
    await assertNotLastOwner(parsed.organizationId, parsed.userId);
  }

  const orgSites = await db
    .select({ id: sites.id })
    .from(sites)
    .where(eq(sites.organizationId, parsed.organizationId));
  const siteIds = orgSites.map((s) => s.id);
  if (siteIds.length > 0) {
    await db
      .delete(siteAccess)
      .where(and(eq(siteAccess.userId, parsed.userId), inArray(siteAccess.siteId, siteIds)));
  }
  await db
    .delete(member)
    .where(and(eq(member.organizationId, parsed.organizationId), eq(member.userId, parsed.userId)));

  return { removed: true };
}

// Owner-only org access overview for the Organization tab: every member (with org
// role), every site in the org, and every per-site grant — so the UI can show who
// has which privilege on which site and let the owner change it.
export async function orgAccessOverview(ctx: AuthContext, input: unknown) {
  const parsed = orgAccessOverviewInput.parse(input);
  await requireOrgOwner(ctx, parsed.organizationId);

  const members = await db
    .select({
      userId: member.userId,
      orgRole: member.role,
      email: user.email,
      name: user.name,
    })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, parsed.organizationId));

  const orgSites = await db
    .select({ id: sites.id, name: sites.name })
    .from(sites)
    .where(eq(sites.organizationId, parsed.organizationId));

  const grants = await db
    .select({ userId: siteAccess.userId, siteId: siteAccess.siteId, role: siteAccess.role })
    .from(siteAccess)
    .innerJoin(sites, eq(sites.id, siteAccess.siteId))
    .where(eq(sites.organizationId, parsed.organizationId));

  return { members, sites: orgSites, grants };
}

/* ─────────────── Sites Router ─────────────── */

export async function sitesList(ctx: AuthContext, input: unknown) {
  const parsed = sitesListInput.parse(input);
  await requireOrg(ctx, parsed.organizationId);

  const rows = await db.query.sites.findMany({
    where: eq(sites.organizationId, parsed.organizationId),
    limit: parsed.limit || 50,
    offset: parsed.offset || 0,
  });

  return { sites: rows, total: rows.length };
}

export async function sitesGet(ctx: AuthContext, input: unknown) {
  const parsed = sitesGetInput.parse(input);
  // The caller's effective level travels back so the UI can gate act/manage
  // controls (viewers see read-only; editors act; site_admins/owners manage).
  const { level } = await requireSiteAccess(ctx, parsed.siteId);

  const site = await db.query.sites.findFirst({
    where: eq(sites.id, parsed.siteId),
  });

  if (!site) {
    throw new Error("Site not found");
  }

  return { ...site, myLevel: level };
}

export async function sitesCreate(ctx: AuthContext, input: unknown) {
  const parsed = sitesCreateInput.parse(input);
  // Sparks-operator only: a customer org-owner cannot add sites to their own org —
  // Sparks provisions sites (and controls how many an org has). The org owner still
  // reaches every site in their org via org ownership (requireSiteAccess), so no
  // explicit site_access grant is created for the (operator) creator here.
  await requirePlatformOperator(ctx.userId);

  const newSite = {
    id: randomUUID(),
    organizationId: parsed.organizationId,
    name: parsed.name,
    addressLine1: parsed.addressLine1,
    city: parsed.city,
    province: parsed.province,
    supplyZone: parsed.supplyZone,
    timezone: parsed.timezone,
    demandIntervalMinutes: parsed.demandIntervalMinutes,
    status: "active" as const,
  };

  await db.insert(sites).values(newSite);

  return newSite;
}

export async function sitesUpdate(ctx: AuthContext, input: unknown) {
  const parsed = sitesUpdateInput.parse(input);
  await requireSiteAccess(ctx, parsed.siteId);

  const updateData: Partial<typeof sites.$inferInsert> = {};
  if (parsed.name !== undefined) updateData.name = parsed.name;
  if (parsed.addressLine1 !== undefined) updateData.addressLine1 = parsed.addressLine1;
  if (parsed.city !== undefined) updateData.city = parsed.city;
  if (parsed.province !== undefined) updateData.province = parsed.province;
  if (parsed.supplyZone !== undefined) updateData.supplyZone = parsed.supplyZone;
  if (parsed.timezone !== undefined) updateData.timezone = parsed.timezone;
  if (parsed.status !== undefined) updateData.status = parsed.status;
  updateData.updatedAt = new Date();

  await db.update(sites).set(updateData).where(eq(sites.id, parsed.siteId));

  return { siteId: parsed.siteId, updated: Object.keys(updateData) };
}

export async function sitesSetDefaultDemandInterval(ctx: AuthContext, input: unknown) {
  const parsed = sitesSetDefaultDemandIntervalInput.parse(input);
  await requireSiteAccess(ctx, parsed.siteId);

  await db
    .update(sites)
    .set({ demandIntervalMinutes: parsed.demandIntervalMinutes, updatedAt: new Date() })
    .where(eq(sites.id, parsed.siteId));

  return { siteId: parsed.siteId, demandIntervalMinutes: parsed.demandIntervalMinutes };
}

export async function sitesDelete(ctx: AuthContext, input: unknown) {
  const parsed = sitesDeleteInput.parse(input);
  // Sparks-operator only: Sparks controls how many sites an org has, so removing a
  // site is a platform-operator action, not something a customer can self-serve.
  await requirePlatformOperator(ctx.userId);

  await db.delete(sites).where(eq(sites.id, parsed.siteId));

  return { deleted: parsed.siteId };
}

/* ─────────────── Site Access Router ─────────────── */

export async function siteAccessList(ctx: AuthContext, input: unknown) {
  const parsed = siteAccessListInput.parse(input);
  await requireSiteAccess(ctx, parsed.siteId);

  const grants = await db
    .select({
      userId: siteAccess.userId,
      role: siteAccess.role,
      email: user.email,
      name: user.name,
    })
    .from(siteAccess)
    .leftJoin(user, eq(user.id, siteAccess.userId))
    .where(eq(siteAccess.siteId, parsed.siteId));

  return { grants };
}

export async function siteAccessGrant(ctx: AuthContext, input: unknown) {
  const parsed = siteAccessGrantInput.parse(input);
  // Only a site admin (or org owner) can grant/change access on a site.
  await requireSiteAdmin(ctx, parsed.siteId);

  // Upsert the access grant
  const existing = await db.query.siteAccess.findFirst({
    where: and(eq(siteAccess.siteId, parsed.siteId), eq(siteAccess.userId, parsed.userId)),
  });

  if (existing) {
    await db
      .update(siteAccess)
      .set({ role: parsed.role })
      .where(and(eq(siteAccess.siteId, parsed.siteId), eq(siteAccess.userId, parsed.userId)));
  } else {
    await db.insert(siteAccess).values({
      id: randomUUID(),
      siteId: parsed.siteId,
      userId: parsed.userId,
      role: parsed.role,
    });
  }

  return { siteId: parsed.siteId, userId: parsed.userId, role: parsed.role };
}

export async function siteAccessRevoke(ctx: AuthContext, input: unknown) {
  const parsed = siteAccessRevokeInput.parse(input);
  await requireSiteAdmin(ctx, parsed.siteId);

  await db
    .delete(siteAccess)
    .where(and(eq(siteAccess.siteId, parsed.siteId), eq(siteAccess.userId, parsed.userId)));

  return { revoked: true };
}

/* ─────────────── Site Invitations (Slice 4) ─────────────── */

// Only a site owner or the org owner may manage a site's invitations.
// Managing a site's access/invitations needs site_admin-or-above (org owners pass).
async function requireSiteManageAccess(ctx: AuthContext, siteId: string): Promise<void> {
  await requireSiteAdmin(ctx, siteId);
}

// Invite someone by email to a specific site. Creates a pending, tokenized invite
// and emails an accept link (the link is also logged in dev, like onboarding).
export async function siteInvitesCreate(ctx: AuthContext, input: unknown) {
  const parsed = siteInvitesCreateInput.parse(input);
  await requireSiteManageAccess(ctx, parsed.siteId);

  const site = await db.query.sites.findFirst({ where: eq(sites.id, parsed.siteId) });
  if (!site) {
    throw new PreconditionError("Site not found");
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const [invite] = await db
    .insert(siteInvitations)
    .values({
      siteId: parsed.siteId,
      organizationId: site.organizationId,
      email: parsed.email.toLowerCase(),
      role: parsed.role,
      token,
      invitedByUserId: ctx.userId,
      expiresAt,
    })
    .returning();

  const webUrl = process.env.WEB_URL || "http://localhost:3000";
  const link = `${webUrl}/invite/accept?token=${token}`;

  const org = await db.query.organization.findFirst({
    where: eq(organization.id, site.organizationId),
  });
  if (process.env.NODE_ENV !== "production") {
    console.log(`\n[invite] site-access link for ${parsed.email} (${site.name}):\n${link}\n`);
  }
  // Background send; failures are swallowed so inviting still succeeds (the console
  // link is the reliable dev path, and Resend is test-mode-restricted).
  const { subject, html } = siteInviteEmail(link, site.name, org?.name ?? "Sparks");
  void sendEmail({ to: parsed.email, subject, html }).catch((e) => {
    console.error(`[invite] email send failed for ${parsed.email}:`, e);
  });

  return { inviteId: invite.id, email: invite.email, siteId: parsed.siteId, expiresAt };
}

export async function siteInvitesList(ctx: AuthContext, input: unknown) {
  const parsed = siteInvitesListInput.parse(input);
  await requireSiteManageAccess(ctx, parsed.siteId);

  const invites = await db.query.siteInvitations.findMany({
    where: and(eq(siteInvitations.siteId, parsed.siteId), eq(siteInvitations.status, "pending")),
  });

  return { invites };
}

export async function siteInvitesCancel(ctx: AuthContext, input: unknown) {
  const parsed = siteInvitesCancelInput.parse(input);

  const invite = await db.query.siteInvitations.findFirst({
    where: eq(siteInvitations.id, parsed.inviteId),
  });
  if (!invite) {
    throw new PreconditionError("Invitation not found");
  }
  await requireSiteManageAccess(ctx, invite.siteId);

  await db
    .update(siteInvitations)
    .set({ status: "cancelled" })
    .where(eq(siteInvitations.id, parsed.inviteId));

  return { cancelled: true };
}

// Accept a site invitation. Requires a logged-in session whose email matches the
// invite. Makes the user an org member (non-owner) if needed and grants site access.
export async function siteInvitesAccept(ctx: AuthContext, input: unknown) {
  const parsed = siteInvitesAcceptInput.parse(input);

  const invite = await db.query.siteInvitations.findFirst({
    where: eq(siteInvitations.token, parsed.token),
  });
  if (!invite) {
    throw new PreconditionError("Invitation not found");
  }
  if (invite.status !== "pending") {
    throw new PreconditionError(`Invitation already ${invite.status}`);
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    throw new PreconditionError("Invitation has expired");
  }

  const me = await db.query.user.findFirst({ where: eq(user.id, ctx.userId) });
  if (!me) {
    throw new PreconditionError("User not found");
  }
  if ((me.email ?? "").toLowerCase() !== invite.email.toLowerCase()) {
    throw new ForbiddenError("This invitation was sent to a different email address");
  }

  // Ensure org membership (non-owner) so the invitee can operate in the org context.
  const membership = await db.query.member.findFirst({
    where: and(eq(member.userId, ctx.userId), eq(member.organizationId, invite.organizationId)),
  });
  if (!membership) {
    await db.insert(member).values({
      id: randomUUID(),
      organizationId: invite.organizationId,
      userId: ctx.userId,
      role: "member",
      createdAt: new Date(),
    });
  }

  // Grant site access (upsert on the unique (siteId, userId)).
  const existing = await db.query.siteAccess.findFirst({
    where: and(eq(siteAccess.siteId, invite.siteId), eq(siteAccess.userId, ctx.userId)),
  });
  if (existing) {
    await db
      .update(siteAccess)
      .set({ role: invite.role })
      .where(and(eq(siteAccess.siteId, invite.siteId), eq(siteAccess.userId, ctx.userId)));
  } else {
    await db.insert(siteAccess).values({
      id: randomUUID(),
      siteId: invite.siteId,
      userId: ctx.userId,
      role: invite.role,
    });
  }

  await db
    .update(siteInvitations)
    .set({ status: "accepted", acceptedAt: new Date(), acceptedByUserId: ctx.userId })
    .where(eq(siteInvitations.id, invite.id));

  return { siteId: invite.siteId, organizationId: invite.organizationId, role: invite.role };
}

/* ─────────────── Devices Router ─────────────── */

export async function devicesList(ctx: AuthContext, input: unknown) {
  const parsed = devicesListInput.parse(input);

  let rows: (typeof devices.$inferSelect)[] = [];
  if (parsed.siteId) {
    await requireSiteAccess(ctx, parsed.siteId);
    rows = await db.query.devices.findMany({
      where: eq(devices.siteId, parsed.siteId),
      limit: parsed.limit || 50,
      offset: parsed.offset || 0,
    });
  } else {
    rows = await db.query.devices.findMany({
      limit: parsed.limit || 50,
      offset: parsed.offset || 0,
    });
  }

  return { devices: rows, total: rows.length };
}

export async function devicesGet(ctx: AuthContext, input: unknown) {
  const parsed = devicesGetInput.parse(input);

  const device = await db.query.devices.findFirst({
    where: eq(devices.id, parsed.deviceId),
  });

  if (!device) {
    throw new Error("Device not found");
  }

  // If device is associated with a site, check access
  if (device.siteId) {
    await requireSiteAccess(ctx, device.siteId);
  }

  return device;
}

export async function devicesProvision(ctx: AuthContext, input: unknown) {
  const parsed = devicesProvisionInput.parse(input);
  await requireOrg(ctx, parsed.organizationId);

  // Generate device secret and store only its hash
  const deviceSecret = randomBytes(32).toString("hex");
  const deviceSecretHash = createHash("sha256").update(deviceSecret).digest("hex");

  const deviceId = randomUUID();
  await db.insert(devices).values({
    id: deviceId,
    serialNumber: parsed.serialNumber,
    hardwareModel: parsed.hardwareModel,
    simIccid: parsed.simIccid,
    simMsisdn: parsed.simMsisdn,
    simProvider: parsed.simProvider,
    connectivityMode: parsed.connectivityMode,
    apiKeyHash: deviceSecretHash,
    status: "provisioning" as const,
  });

  return { deviceId, deviceSecret };
}

export async function devicesRotateKey(ctx: AuthContext, input: unknown) {
  const parsed = devicesRotateKeyInput.parse(input);

  const device = await db.query.devices.findFirst({
    where: eq(devices.id, parsed.deviceId),
  });

  if (!device) {
    throw new Error("Device not found");
  }

  // If device is associated with a site, check access
  if (device.siteId) {
    await requireSiteAccess(ctx, device.siteId);
  }

  const deviceSecret = randomBytes(32).toString("hex");
  const deviceSecretHash = createHash("sha256").update(deviceSecret).digest("hex");

  await db
    .update(devices)
    .set({ apiKeyHash: deviceSecretHash })
    .where(eq(devices.id, parsed.deviceId));

  return { deviceId: parsed.deviceId, deviceSecret };
}

export async function devicesGetHealth(ctx: AuthContext, input: unknown) {
  const parsed = devicesGetHealthInput.parse(input);

  const device = await db.query.devices.findFirst({
    where: eq(devices.id, parsed.deviceId),
  });

  if (!device) {
    throw new Error("Device not found");
  }

  if (device.siteId) {
    await requireSiteAccess(ctx, device.siteId);
  }

  return {
    deviceId: device.id,
    status: device.status,
    lastSeenAt: device.lastSeenAt,
    upsStatus: device.upsStatus,
    upsBatteryPct: device.upsBatteryPct,
  };
}

export async function devicesUpdateSite(ctx: AuthContext, input: unknown) {
  const parsed = devicesUpdateSiteInput.parse(input);

  const device = await db.query.devices.findFirst({
    where: eq(devices.id, parsed.deviceId),
  });

  if (!device) {
    throw new Error("Device not found");
  }

  if (device.siteId) {
    await requireSiteAccess(ctx, device.siteId);
  }

  if (parsed.siteId) {
    await requireSiteAccess(ctx, parsed.siteId);
  }

  await db.update(devices).set({ siteId: parsed.siteId }).where(eq(devices.id, parsed.deviceId));

  return { deviceId: parsed.deviceId, siteId: parsed.siteId };
}

/* ─────────────── Meters Router ─────────────── */

export async function metersGet(ctx: AuthContext, input: unknown) {
  const parsed = metersGetInput.parse(input);

  const meter = await db.query.meters.findFirst({
    where: eq(meters.id, parsed.meterId),
  });

  if (!meter) {
    throw new Error("Meter not found");
  }

  await requireSiteAccess(ctx, meter.siteId);

  return meter;
}

export async function metersCreate(ctx: AuthContext, input: unknown) {
  const parsed = metersCreateInput.parse(input);

  const device = await db.query.devices.findFirst({
    where: eq(devices.id, parsed.deviceId),
  });

  if (!device) {
    throw new Error("Device not found");
  }

  await requireSiteAccess(ctx, parsed.siteId);

  const meterId = randomUUID();
  await db.insert(meters).values({
    id: meterId,
    deviceId: parsed.deviceId,
    siteId: parsed.siteId,
    serialNumber: parsed.serialNumber,
    model: parsed.model,
    midCertifiedVariant: parsed.midCertifiedVariant,
    midCertificateRef: parsed.midCertificateRef,
    ctRatioPrimary: parsed.ctRatioPrimary,
    ctRatioSecondary: parsed.ctRatioSecondary,
    phaseConfig: parsed.phaseConfig,
  });

  return { meterId };
}

export async function metersCommission(ctx: AuthContext, input: unknown) {
  const parsed = metersCommissionInput.parse(input);

  const meter = await db.query.meters.findFirst({
    where: eq(meters.id, parsed.meterId),
  });

  if (!meter) {
    throw new Error("Meter not found");
  }

  await requireSiteAccess(ctx, meter.siteId);

  const now = new Date();
  await db
    .update(meters)
    .set({
      installedByName: parsed.installedByName,
      installerRegistration: parsed.installerRegistration,
      installedAt: now,
      commissionedAt: now,
    })
    .where(eq(meters.id, parsed.meterId));

  return { meterId: parsed.meterId, commissionedAt: now };
}

/* ─────────────── Billing Router ─────────────── */

export async function billingPoliciesGet(ctx: AuthContext, input: unknown) {
  const parsed = billingPoliciesGetInput.parse(input);
  await requireSiteAccess(ctx, parsed.siteId);

  const policy = await db.query.billingCyclePolicies.findFirst({
    where: and(
      eq(billingCyclePolicies.siteId, parsed.siteId),
      isNull(billingCyclePolicies.effectiveTo),
    ),
  });

  return policy || null;
}

export async function billingPoliciesSet(ctx: AuthContext, input: unknown) {
  const parsed = billingPoliciesSetInput.parse(input);
  await requireSiteAccess(ctx, parsed.siteId);

  const site = await db.query.sites.findFirst({
    where: eq(sites.id, parsed.siteId),
  });

  if (!site) {
    throw new Error("Site not found");
  }

  // Close the current active policy
  const currentPolicy = await db.query.billingCyclePolicies.findFirst({
    where: and(
      eq(billingCyclePolicies.siteId, parsed.siteId),
      isNull(billingCyclePolicies.effectiveTo),
    ),
  });

  if (currentPolicy) {
    await db
      .update(billingCyclePolicies)
      .set({ effectiveTo: new Date() })
      .where(eq(billingCyclePolicies.id, currentPolicy.id));
  }

  // Create new policy with version incremented
  const newVersion = (currentPolicy?.version || 0) + 1;
  const newPolicy = {
    id: randomUUID(),
    siteId: parsed.siteId,
    recurrence: parsed.recurrence,
    anchorDay: parsed.anchorDay,
    shortMonthPolicy: parsed.shortMonthPolicy,
    intervalCount: parsed.intervalCount,
    anchorDate: parsed.anchorDate,
    fiscalPattern: parsed.fiscalPattern,
    leapWeekPlacement: parsed.leapWeekPlacement,
    anchorTimeOfDay: parsed.anchorTimeOfDay,
    boundaryInclusivity: parsed.boundaryInclusivity,
    snapToDemandGrid: parsed.snapToDemandGrid,
    version: newVersion,
    effectiveFrom: new Date(),
  };

  await db.insert(billingCyclePolicies).values(newPolicy);

  return newPolicy;
}

export async function billingPeriodsList(ctx: AuthContext, input: unknown) {
  const parsed = billingPeriodsListInput.parse(input);
  await requireSiteAccess(ctx, parsed.siteId);

  const rows = await db.query.billingPeriods.findMany({
    where: eq(billingPeriods.siteId, parsed.siteId),
    limit: parsed.limit || 50,
    offset: parsed.offset || 0,
    orderBy: desc(billingPeriods.periodStart),
  });

  return { periods: rows, total: rows.length };
}

export async function billingPeriodsMaterialize(ctx: AuthContext, input: unknown) {
  const parsed = billingPeriodsMaterializeInput.parse(input);
  await requireSiteAccess(ctx, parsed.siteId);

  const site = await db.query.sites.findFirst({
    where: eq(sites.id, parsed.siteId),
  });

  if (!site) {
    throw new Error("Site not found");
  }

  const policy = await db.query.billingCyclePolicies.findFirst({
    where: and(
      eq(billingCyclePolicies.siteId, parsed.siteId),
      isNull(billingCyclePolicies.effectiveTo),
    ),
  });

  if (!policy) {
    throw new Error("No active billing policy for site");
  }

  const candidates: Array<{ periodStart: Date; periodEnd: Date; label: string }> = [];

  const policyInput: BillingPeriodPolicy = {
    recurrence: policy.recurrence,
    anchorDay: policy.anchorDay || undefined,
    shortMonthPolicy: policy.shortMonthPolicy,
    intervalCount: policy.intervalCount || 1,
    anchorDate: policy.anchorDate || undefined,
    fiscalPattern: (policy.fiscalPattern as "4-4-5" | "4-5-4" | "5-4-4") || "4-4-5",
    leapWeekPlacement: policy.leapWeekPlacement || "last",
    anchorTimeOfDay: policy.anchorTimeOfDay || "00:00",
    boundaryInclusivity: policy.boundaryInclusivity,
    snapToDemandGrid: policy.snapToDemandGrid,
  };

  for (const candidate of materializePeriods(
    policyInput,
    parsed.startDate,
    parsed.endDate,
    site.timezone,
  )) {
    candidates.push(candidate);
  }

  return { candidates };
}

export async function billingPeriodsUpsert(ctx: AuthContext, input: unknown) {
  const parsed = billingPeriodsUpsertInput.parse(input);
  await requireSiteAccess(ctx, parsed.siteId);

  const existing = await db.query.billingPeriods.findFirst({
    where: and(
      eq(billingPeriods.siteId, parsed.siteId),
      eq(billingPeriods.periodStart, parsed.periodStart),
    ),
  });

  const site = await db.query.sites.findFirst({
    where: eq(sites.id, parsed.siteId),
  });

  if (!site) {
    throw new Error("Site not found");
  }

  const demandIntervalMinutes = site.demandIntervalMinutes;

  if (existing) {
    await db
      .update(billingPeriods)
      .set({
        periodEnd: parsed.periodEnd,
        source: parsed.source,
        label: parsed.label,
        notes: parsed.notes,
      })
      .where(eq(billingPeriods.id, existing.id));

    return { periodId: existing.id, upserted: "updated" };
  }

  const periodId = crypto.randomUUID();
  await db.insert(billingPeriods).values({
    id: periodId,
    siteId: parsed.siteId,
    periodStart: parsed.periodStart,
    periodEnd: parsed.periodEnd,
    boundaryInclusivity: "half_open",
    demandIntervalMinutes,
    source: parsed.source,
    label: parsed.label,
    notes: parsed.notes,
  });

  return { periodId, upserted: "inserted" };
}

export async function billingPeriodsClose(ctx: AuthContext, input: unknown) {
  const parsed = billingPeriodsCloseInput.parse(input);

  const period = await db.query.billingPeriods.findFirst({
    where: eq(billingPeriods.id, parsed.periodId),
  });

  if (!period) {
    throw new Error("Period not found");
  }

  await requireSiteAccess(ctx, period.siteId);

  await db
    .update(billingPeriods)
    .set({ status: "closed" })
    .where(eq(billingPeriods.id, parsed.periodId));

  return { periodId: parsed.periodId, status: "closed" };
}

/* ─────────────── Tariffs Router ─────────────── */

export async function tariffsLibraryList(_ctx: AuthContext, input: unknown) {
  const parsed = tariffsLibraryListInput.parse(input);

  let query = db.query.tariffProfiles.findMany({
    where: and(eq(tariffProfiles.source, "library"), isNull(tariffProfiles.organizationId)),
  });

  if (parsed.type) {
    query = db.query.tariffProfiles.findMany({
      where: and(
        eq(tariffProfiles.source, "library"),
        isNull(tariffProfiles.organizationId),
        eq(tariffProfiles.type, parsed.type),
      ),
    });
  }

  if (parsed.supplyZone) {
    query = db.query.tariffProfiles.findMany({
      where: and(
        eq(tariffProfiles.source, "library"),
        isNull(tariffProfiles.organizationId),
        eq(tariffProfiles.supplyZone, parsed.supplyZone),
      ),
    });
  }

  const rows = await query;
  return { profiles: rows, total: rows.length };
}

export async function tariffsLibraryGet(_ctx: AuthContext, input: unknown) {
  const parsed = tariffsLibraryGetInput.parse(input);

  const profile = await db.query.tariffProfiles.findFirst({
    where: and(
      eq(tariffProfiles.id, parsed.tariffProfileId),
      eq(tariffProfiles.source, "library"),
      isNull(tariffProfiles.organizationId),
    ),
  });

  if (!profile) {
    throw new Error("Tariff profile not found in library");
  }

  const rates = await db.query.tariffRates.findMany({
    where: eq(tariffRates.tariffProfileId, profile.id),
  });

  return { profile, rates };
}

export async function tariffsProfilesCreate(ctx: AuthContext, input: unknown) {
  const parsed = tariffsProfilesCreateInput.parse(input);

  if (parsed.source === "library") {
    await requirePlatformOperator(ctx.userId);
    if (parsed.organizationId) {
      throw new ForbiddenError("Library tariffs cannot be organization-scoped");
    }
  } else {
    const orgId = parsed.organizationId || ctx.organizationId;
    await requireOrg(ctx, orgId);
  }

  const profileId = randomUUID();

  await db.insert(tariffProfiles).values({
    id: profileId,
    organizationId: parsed.source === "custom" ? parsed.organizationId || ctx.organizationId : null,
    name: parsed.name,
    type: parsed.type,
    source: parsed.source,
    supplyZone: parsed.supplyZone,
    distributor: parsed.distributor,
    currency: parsed.currency,
    touSchedule: parsed.touSchedule,
    effectiveFrom: parsed.effectiveFrom,
    effectiveTo: parsed.effectiveTo,
    validatedByAttorney: parsed.validatedByAttorney,
  });

  return { profileId, created: true };
}

export async function tariffsProfilesUpdate(ctx: AuthContext, input: unknown) {
  const parsed = tariffsProfilesUpdateInput.parse(input);

  const profile = await db.query.tariffProfiles.findFirst({
    where: eq(tariffProfiles.id, parsed.tariffProfileId),
  });

  if (!profile) {
    throw new Error("Tariff profile not found");
  }

  if (profile.source === "library") {
    await requirePlatformOperator(ctx.userId);
  } else {
    await requireOrg(ctx, profile.organizationId || "");
  }

  const updateData: Record<string, unknown> = {};
  if (parsed.name !== undefined) updateData.name = parsed.name;
  if (parsed.distributor !== undefined) updateData.distributor = parsed.distributor;
  if (parsed.touSchedule !== undefined) updateData.touSchedule = parsed.touSchedule;
  if (parsed.effectiveTo !== undefined) updateData.effectiveTo = parsed.effectiveTo;
  if (parsed.validatedByAttorney !== undefined)
    updateData.validatedByAttorney = parsed.validatedByAttorney;

  const updatePayload: Partial<typeof tariffProfiles.$inferInsert> = updateData;
  await db
    .update(tariffProfiles)
    .set(updatePayload)
    .where(eq(tariffProfiles.id, parsed.tariffProfileId));

  return { profileId: parsed.tariffProfileId, updated: Object.keys(updateData) };
}

export async function tariffsProfilesAddRate(ctx: AuthContext, input: unknown) {
  const parsed = tariffsProfilesAddRateInput.parse(input);

  const profile = await db.query.tariffProfiles.findFirst({
    where: eq(tariffProfiles.id, parsed.tariffProfileId),
  });

  if (!profile) {
    throw new Error("Tariff profile not found");
  }

  if (profile.source === "library") {
    await requirePlatformOperator(ctx.userId);
  } else {
    await requireOrg(ctx, profile.organizationId || "");
  }

  const rateId = randomUUID();
  const rateValue = Number.parseFloat(parsed.rateValue);
  const blockThresholdKwh = parsed.blockThresholdKwh
    ? Number.parseFloat(parsed.blockThresholdKwh)
    : undefined;

  const ratePayload: typeof tariffRates.$inferInsert = {
    id: rateId,
    tariffProfileId: parsed.tariffProfileId,
    chargeType: parsed.chargeType,
    unit: parsed.unit,
    rateValue: rateValue.toString(),
    season: parsed.season,
    touPeriod: parsed.touPeriod,
    blockThresholdKwh: blockThresholdKwh?.toString(),
  };
  await db.insert(tariffRates).values(ratePayload);

  return { rateId, created: true };
}

export async function tariffsProfilesListRates(_ctx: AuthContext, input: unknown) {
  const parsed = tariffsProfilesListRatesInput.parse(input);

  const profile = await db.query.tariffProfiles.findFirst({
    where: eq(tariffProfiles.id, parsed.tariffProfileId),
  });

  if (!profile) {
    throw new Error("Tariff profile not found");
  }

  const rates = await db.query.tariffRates.findMany({
    where: eq(tariffRates.tariffProfileId, parsed.tariffProfileId),
  });

  return { profileId: parsed.tariffProfileId, rates };
}

export async function tariffsAssignSet(ctx: AuthContext, input: unknown) {
  const parsed = tariffsAssignSetInput.parse(input);
  await requireSiteAccess(ctx, parsed.siteId);

  const profile = await db.query.tariffProfiles.findFirst({
    where: eq(tariffProfiles.id, parsed.tariffProfileId),
  });

  if (!profile) {
    throw new Error("Tariff profile not found");
  }

  if (parsed.role === "legal_ceiling" && !profile.validatedByAttorney) {
    throw new ForbiddenError(
      "Cannot assign legal_ceiling tariff without attorney validation (validated_by_attorney must be true)",
    );
  }

  const existing = await db.query.siteTariffAssignments.findFirst({
    where: and(
      eq(siteTariffAssignments.siteId, parsed.siteId),
      eq(siteTariffAssignments.role, parsed.role),
      isNull(siteTariffAssignments.effectiveTo),
    ),
  });

  if (existing) {
    await db
      .update(siteTariffAssignments)
      .set({ effectiveTo: new Date() })
      .where(eq(siteTariffAssignments.id, existing.id));
  }

  const assignmentId = randomUUID();
  await db.insert(siteTariffAssignments).values({
    id: assignmentId,
    siteId: parsed.siteId,
    tariffProfileId: parsed.tariffProfileId,
    role: parsed.role,
    effectiveFrom: parsed.effectiveFrom,
    effectiveTo: parsed.effectiveTo,
  });

  return { assignmentId, assigned: true };
}

export async function tariffsAssignList(ctx: AuthContext, input: unknown) {
  const parsed = tariffsAssignListInput.parse(input);
  await requireSiteAccess(ctx, parsed.siteId);

  const assignments = await db.query.siteTariffAssignments.findMany({
    where: eq(siteTariffAssignments.siteId, parsed.siteId),
  });

  const results = [];
  for (const assignment of assignments) {
    const profile = await db.query.tariffProfiles.findFirst({
      where: eq(tariffProfiles.id, assignment.tariffProfileId),
    });
    results.push({ assignment, profile });
  }

  return { siteId: parsed.siteId, assignments: results };
}

/* ─────────────── Reconciliation Router ─────────────── */

/** True if an instant falls inside a billing period, honoring boundary inclusivity. */
function instantInPeriod(
  t: Date,
  period: { periodStart: Date; periodEnd: Date; boundaryInclusivity: string },
): boolean {
  const ts = t.getTime();
  const start = period.periodStart.getTime();
  const end = period.periodEnd.getTime();
  if (period.boundaryInclusivity === "inclusive") return ts >= start && ts <= end;
  // half_open (default): [start, end)
  return ts >= start && ts < end;
}

function mapTariffRate(r: typeof tariffRates.$inferSelect): TariffRate {
  return {
    chargeType: r.chargeType as TariffRate["chargeType"],
    unit: r.unit as TariffRate["unit"],
    rateValue: Number(r.rateValue),
    season: r.season as TariffRate["season"],
    touPeriod: r.touPeriod as TariffRate["touPeriod"],
    blockThresholdKwh: r.blockThresholdKwh ? Number(r.blockThresholdKwh) : undefined,
  };
}

async function buildTariffProfile(profileId: string): Promise<TariffProfile | null> {
  const profile = await db.query.tariffProfiles.findFirst({
    where: eq(tariffProfiles.id, profileId),
  });
  if (!profile) return null;
  const rates = await db.query.tariffRates.findMany({
    where: eq(tariffRates.tariffProfileId, profileId),
  });
  return {
    rates: rates.map(mapTariffRate),
    touSchedule: (profile.touSchedule || {}) as Record<string, unknown>,
  };
}

/**
 * Price a role's (landlord | legal_ceiling) tariff over a billing period,
 * respecting effective-dated `siteTariffAssignments`. Each interval is attributed
 * to the assignment effective at its start, so a period crossing a tariff change
 * is split and each slice is priced under its own profile (reusing the R4 pricer
 * with per-interval energy + the site timezone). Returns the summed pricing plus
 * the profile effective at the period start (stored as the reconciliation's FK).
 */
async function priceRoleOverPeriod(
  siteId: string,
  role: "landlord" | "legal_ceiling",
  period: { periodStart: Date; periodEnd: Date; boundaryInclusivity: string },
  periodIntervals: Array<typeof demandIntervals.$inferSelect>,
  timezone: string,
): Promise<{ pricing: PricingBreakdown; primaryProfileId: string } | null> {
  const allAssignments = await db.query.siteTariffAssignments.findMany({
    where: and(eq(siteTariffAssignments.siteId, siteId), eq(siteTariffAssignments.role, role)),
  });

  const overlapping = allAssignments
    .filter(
      (a) =>
        a.effectiveFrom.getTime() < period.periodEnd.getTime() &&
        (!a.effectiveTo || a.effectiveTo.getTime() > period.periodStart.getTime()),
    )
    .sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());

  if (overlapping.length === 0) return null;

  // The assignment effective at instant t = the latest one whose effectiveFrom
  // is <= t. Intervals before the earliest overlapping assignment fall to it.
  const pickAssignment = (t: Date) => {
    let chosen = overlapping[0];
    for (const a of overlapping) {
      if (a.effectiveFrom.getTime() <= t.getTime()) chosen = a;
      else break;
    }
    return chosen;
  };

  type Assignment = (typeof overlapping)[number];
  const groups = new Map<string, { assignment: Assignment; intervals: typeof periodIntervals }>();
  for (const interval of periodIntervals) {
    const assignment = pickAssignment(interval.intervalStart);
    const group = groups.get(assignment.id) ?? { assignment, intervals: [] };
    group.intervals.push(interval);
    groups.set(assignment.id, group);
  }
  // No intervals in the period: still price the period-start assignment once so
  // period-level charges (fixed/ancillary) are applied.
  if (groups.size === 0) {
    const assignment = pickAssignment(period.periodStart);
    groups.set(assignment.id, { assignment, intervals: [] });
  }

  const segments: Array<{ usage: UsageData; profile: TariffProfile }> = [];
  for (const { assignment, intervals } of groups.values()) {
    const profile = await buildTariffProfile(assignment.tariffProfileId);
    if (!profile) continue;
    let activeKwh = 0;
    let maxDemandKva = 0;
    let reactiveKvarh = 0;
    const intervalStarts: Date[] = [];
    const intervalActiveKwh: number[] = [];
    for (const iv of intervals) {
      const active = iv.activeEnergyKwh ? Number(iv.activeEnergyKwh) : 0;
      activeKwh += active;
      if (iv.avgDemandKva) maxDemandKva = Math.max(maxDemandKva, Number(iv.avgDemandKva));
      if (iv.reactiveEnergyKvarh) reactiveKvarh += Number(iv.reactiveEnergyKvarh);
      intervalStarts.push(iv.intervalStart);
      intervalActiveKwh.push(active);
    }
    segments.push({
      usage: {
        activeKwh,
        maxDemandKva,
        reactiveKvarh,
        intervalStarts,
        intervalActiveKwh,
        timezone,
      },
      profile,
    });
  }

  return {
    pricing: segments.length > 0 ? priceSegments(segments) : emptyBreakdown(),
    primaryProfileId: pickAssignment(period.periodStart).tariffProfileId,
  };
}

// Core reconciliation generation. The caller must have already checked site
// access. Computes the NEXT version for the period so a regeneration (after
// Reopen) never overwrites a prior version. A freshly generated recon is
// 'provisional' (schema default) — visible to the customer immediately, but the
// sealed dispute PDF only unlocks after Sparks QA sign-off ('reviewed').
async function runReconciliationForPeriod(
  billingPeriodId: string,
): Promise<{ reconId: string; status: "draft"; version: number }> {
  const billingPeriod = await db.query.billingPeriods.findFirst({
    where: eq(billingPeriods.id, billingPeriodId),
  });

  if (!billingPeriod) {
    throw new Error("Billing period not found");
  }

  const site = await db.query.sites.findFirst({
    where: eq(sites.id, billingPeriod.siteId),
  });

  if (!site) {
    throw new PreconditionError("Site not found");
  }

  const invoice = await db.query.landlordInvoices.findFirst({
    where: eq(landlordInvoices.billingPeriodId, billingPeriodId),
  });

  if (!invoice) {
    throw new PreconditionError(
      "No invoice found for this billing period. Upload and lock an invoice first.",
    );
  }

  // Guard (docs/02 §6): only a locked invoice's confirmed totals are authoritative.
  // Refuse to generate a dispute-grade reconciliation against unconfirmed numbers.
  if (invoice.status !== "locked") {
    throw new ForbiddenError("Cannot generate reconciliation until the invoice is locked");
  }

  // Gather measured data from demand intervals within the billing period
  const allIntervals = await db
    .select()
    .from(demandIntervals)
    .where(and(eq(demandIntervals.siteId, billingPeriod.siteId)));

  const intervals = allIntervals.filter((i) => instantInPeriod(i.intervalStart, billingPeriod));

  // Calculate totals
  let totalActiveKwh = 0;
  let maxDemandKva = 0;
  let totalReactiveKvarh = 0;

  for (const interval of intervals) {
    if (interval.activeEnergyKwh) {
      totalActiveKwh += Number(interval.activeEnergyKwh);
    }
    if (interval.avgDemandKva) {
      maxDemandKva = Math.max(maxDemandKva, Number(interval.avgDemandKva));
    }
    if (interval.reactiveEnergyKvarh) {
      totalReactiveKvarh += Number(interval.reactiveEnergyKvarh);
    }
  }

  // Gather data gaps — scoped to the billing-period window (docs/02 R5): a gap
  // only flags THIS period's integrity if it starts inside the period. Querying
  // by siteId alone would let every historical gap inflate this month's flag.
  const allGaps = await db.query.dataGaps.findMany({
    where: eq(dataGaps.siteId, billingPeriod.siteId),
  });
  const gaps = allGaps.filter((g) => instantInPeriod(g.gapStart, billingPeriod));

  const gapCount = gaps.length;
  let gapMinutesTotal = 0;
  for (const gap of gaps) {
    gapMinutesTotal += gap.durationMinutes;
  }

  // Price landlord + legal-ceiling tariffs using the assignment(s) EFFECTIVE
  // during the period (splitting on effective-date changes) with per-interval
  // energy + the site timezone, so R4's TOU/seasonal pricing applies end-to-end.
  const landlordResult = await priceRoleOverPeriod(
    billingPeriod.siteId,
    "landlord",
    billingPeriod,
    intervals,
    site.timezone,
  );
  if (!landlordResult) {
    throw new PreconditionError(
      "No landlord tariff assigned to this site. Assign a landlord tariff effective during the period first.",
    );
  }
  const ceilingResult = await priceRoleOverPeriod(
    billingPeriod.siteId,
    "legal_ceiling",
    billingPeriod,
    intervals,
    site.timezone,
  );

  // Generate reconciliation data
  const reconData = await generateReconciliation(
    billingPeriod,
    site,
    {
      activeKwh: totalActiveKwh,
      maxDemandKva,
      reactiveKvarh: totalReactiveKvarh,
    },
    landlordResult.pricing,
    ceilingResult ? ceilingResult.pricing : null,
    {
      confirmedActiveCents: invoice.confirmedActiveCents,
      confirmedDemandCents: invoice.confirmedDemandCents,
      confirmedReactiveCents: invoice.confirmedReactiveCents,
      confirmedFixedCents: invoice.confirmedFixedCents,
      confirmedTotalCents: invoice.confirmedTotalCents,
    },
    { gapCount, gapMinutesTotal },
  );

  // Version: next after any prior recon for this period (never overwrite).
  const priorVersions = await db.query.reconciliations.findMany({
    where: eq(reconciliations.billingPeriodId, billingPeriodId),
    columns: { version: true },
  });
  const version = priorVersions.reduce((m, r) => Math.max(m, r.version), 0) + 1;

  // Write reconciliation to database
  const reconId = randomUUID();
  await db.insert(reconciliations).values({
    id: reconId,
    siteId: billingPeriod.siteId,
    invoiceId: invoice.id,
    billingPeriodId,
    billingPeriodStart: billingPeriod.periodStart,
    billingPeriodEnd: billingPeriod.periodEnd,
    boundaryInclusivity: billingPeriod.boundaryInclusivity,
    demandIntervalMinutes: billingPeriod.demandIntervalMinutes,
    landlordTariffProfileId: landlordResult.primaryProfileId,
    legalCeilingTariffProfileId: ceilingResult?.primaryProfileId || null,
    measuredActiveKwh: reconData.measuredActiveKwh.toString(),
    measuredMaxDemandKva: reconData.measuredMaxDemandKva.toString(),
    measuredReactiveKvarh: reconData.measuredReactiveKvarh.toString(),
    expectedLandlordCents: reconData.expectedLandlordCents,
    expectedCeilingCents: reconData.expectedCeilingCents,
    chargedTotalCents: reconData.chargedTotalCents,
    discrepancyVsLandlordCents: reconData.discrepancyVsLandlordCents,
    discrepancyVsCeilingCents: reconData.discrepancyVsCeilingCents,
    dataIntegrityStatus: reconData.dataIntegrityStatus,
    gapCount: reconData.gapCount,
    gapMinutesTotal: reconData.gapMinutesTotal,
    breakdown: reconData.breakdown,
    status: "draft",
    version,
    generatedAt: new Date(),
  });

  return { reconId, status: "draft", version };
}

export async function reconciliationGenerate(ctx: AuthContext, input: unknown) {
  const parsed = reconciliationGenerateInput.parse(input);

  const billingPeriod = await db.query.billingPeriods.findFirst({
    where: eq(billingPeriods.id, parsed.billingPeriodId),
  });
  if (!billingPeriod) {
    throw new Error("Billing period not found");
  }
  await requireSiteEditor(ctx, billingPeriod.siteId);

  return runReconciliationForPeriod(parsed.billingPeriodId);
}

export async function reconciliationGet(ctx: AuthContext, input: unknown) {
  const parsed = reconciliationGetInput.parse(input);

  const recon = await db.query.reconciliations.findFirst({
    where: eq(reconciliations.id, parsed.reconId),
  });

  if (!recon) {
    throw new Error("Reconciliation not found");
  }

  await requireSiteAccess(ctx, recon.siteId);

  // Component-by-component comparison, recomputed from the stored breakdown so it
  // is available even for reconciliations generated before it was added.
  const bd = recon.breakdown as {
    landlord?: { pricing?: PricingBreakdown };
    ceiling?: { pricing?: PricingBreakdown };
    invoice?: {
      confirmedActiveCents: number | null;
      confirmedDemandCents: number | null;
      confirmedReactiveCents: number | null;
      confirmedFixedCents: number | null;
    };
  } | null;
  const components =
    bd?.landlord?.pricing && bd.invoice
      ? buildComponentComparison(bd.landlord.pricing, bd.ceiling?.pricing ?? null, bd.invoice)
      : [];

  return { ...recon, components };
}

export async function reconciliationList(ctx: AuthContext, input: unknown) {
  const parsed = reconciliationListInput.parse(input);
  await requireSiteAccess(ctx, parsed.siteId);

  const rows = await db.query.reconciliations.findMany({
    where: eq(reconciliations.siteId, parsed.siteId),
    limit: parsed.limit || 50,
    offset: parsed.offset || 0,
  });

  return { reconciliations: rows, total: rows.length };
}

export async function reconciliationListVersions(ctx: AuthContext, input: unknown) {
  const parsed = reconciliationListVersionsInput.parse(input);

  const billingPeriod = await db.query.billingPeriods.findFirst({
    where: eq(billingPeriods.id, parsed.billingPeriodId),
  });

  if (!billingPeriod) {
    throw new Error("Billing period not found");
  }

  await requireSiteAccess(ctx, billingPeriod.siteId);

  const versions = await db.query.reconciliations.findMany({
    where: eq(reconciliations.billingPeriodId, parsed.billingPeriodId),
  });

  return { versions };
}

export async function reconciliationFinalize(ctx: AuthContext, input: unknown) {
  const parsed = reconciliationFinalizeInput.parse(input);

  const recon = await db.query.reconciliations.findFirst({
    where: eq(reconciliations.id, parsed.reconId),
  });

  if (!recon) {
    throw new Error("Reconciliation not found");
  }

  await requireSiteEditor(ctx, recon.siteId);

  if (!recon.invoiceId) {
    throw new Error("Reconciliation has no associated invoice");
  }

  const invoice = await db.query.landlordInvoices.findFirst({
    where: eq(landlordInvoices.id, recon.invoiceId),
  });

  if (!invoice) {
    throw new Error("Associated invoice not found");
  }

  if (invoice.status !== "locked") {
    throw new ForbiddenError("Cannot finalize reconciliation until invoice is locked");
  }

  await db
    .update(reconciliations)
    .set({ status: "final" })
    .where(eq(reconciliations.id, parsed.reconId));

  return { reconId: parsed.reconId, status: "final" };
}

// Generate (or regenerate) the sealed dispute-ready PDF for a reconciliation.
// Site-access guarded; runs the report worker off the request path (renders,
// hashes, persists to object storage, bumps version, writes an audit_log entry,
// and refuses to seal an attorney-unvalidated legal_ceiling tariff).
export async function reconciliationGeneratePdf(ctx: AuthContext, input: unknown) {
  const parsed = reconciliationGeneratePdfInput.parse(input);

  const recon = await db.query.reconciliations.findFirst({
    where: eq(reconciliations.id, parsed.reconId),
  });

  if (!recon) {
    throw new Error("Reconciliation not found");
  }

  await requireSiteEditor(ctx, recon.siteId);

  // The sealed dispute PDF is the legal output — it only unlocks once Sparks QA
  // has signed the reconciliation off. While it is provisional (or flagged) the
  // customer still sees the numbers on-screen, but no sealed evidence is produced.
  if (recon.reviewStatus !== "reviewed") {
    throw new ForbiddenError(
      "This reconciliation is still under Sparks review. The sealed dispute PDF unlocks once it has been verified.",
    );
  }

  const result = await generateReportPdf(parsed.reconId, ctx.userId);

  return {
    reconId: parsed.reconId,
    pdfStorageKey: result.pdfStorageKey,
    pdfHash: result.pdfHash,
    version: result.version,
  };
}

export async function reportGetPdf(ctx: AuthContext, input: unknown) {
  const parsed = reportGetPdfInput.parse(input);

  const recon = await db.query.reconciliations.findFirst({
    where: eq(reconciliations.id, parsed.reconId),
  });

  if (!recon) {
    throw new Error("Reconciliation not found");
  }

  await requireSiteEditor(ctx, recon.siteId);

  if (!recon.pdfStorageKey || !recon.pdfHash) {
    throw new Error(
      "PDF has not been generated for this reconciliation. Call reconciliation.generatePdf first.",
    );
  }

  // The stored bytes must actually exist — surface a missing object loudly rather
  // than handing back a URL that 404s.
  if (!(await objectExists(recon.pdfStorageKey))) {
    throw new Error(
      `Stored PDF object is missing for reconciliation ${parsed.reconId} (key ${recon.pdfStorageKey}). Regenerate the PDF.`,
    );
  }

  // Short-lived signed URL (R2 presigned GET, or a capability URL served by
  // GET /reports/file on the filesystem backend).
  const presignedUrl = await signObjectUrl(recon.pdfStorageKey, 3600);

  return {
    reconId: parsed.reconId,
    pdfStorageKey: recon.pdfStorageKey,
    pdfHash: recon.pdfHash,
    presignedUrl,
    generatedAt: recon.generatedAt,
    version: recon.version,
  };
}

/* ─────────────── Invoices ─────────────── */

export async function invoicesCreateUpload(ctx: AuthContext, input: unknown) {
  const parsed = invoicesCreateUploadInput.parse(input);
  await requireSiteEditor(ctx, parsed.siteId);

  const billingPeriod = await db.query.billingPeriods.findFirst({
    where: eq(billingPeriods.id, parsed.billingPeriodId),
  });

  if (!billingPeriod) {
    throw new Error("Billing period not found");
  }

  if (billingPeriod.siteId !== parsed.siteId) {
    throw new ForbiddenError("Billing period does not belong to this site");
  }

  const fileHash = randomBytes(32).toString("hex");
  const fileStorageKey = `invoices/${parsed.siteId}/${parsed.billingPeriodId}/${randomUUID()}.pdf`;

  const result = await db
    .insert(landlordInvoices)
    .values({
      siteId: parsed.siteId,
      billingPeriodId: parsed.billingPeriodId,
      billingPeriodStart: billingPeriod.periodStart,
      billingPeriodEnd: billingPeriod.periodEnd,
      fileStorageKey,
      fileHash,
      status: "uploaded",
      uploadedByUserId: ctx.userId,
    })
    .returning();

  const invoice = result[0];

  const presignedUrl = `https://r2.example.com/presigned?key=${fileStorageKey}&hash=${fileHash}`;

  return {
    invoiceId: invoice.id,
    presignedUrl,
    fileHash,
  };
}

// Upload an invoice PDF and parse it with Claude in one step (site-access guarded).
// Stores the original PDF in object storage, then extracts line items via
// parseInvoiceWithClaude and persists them → status parsed_pending_confirm.
// Turn the invoice's printed (inclusive) period dates into half-open [start, end)
// instants. `endStr` is the last day billed, so the exclusive end is the next day.
// Falls back to the current calendar month when the parser found no dates.
function invoicePeriodBounds(
  startStr: string | null,
  endStr: string | null,
): { start: Date; end: Date } {
  if (startStr && endStr) {
    const start = new Date(`${startStr}T00:00:00Z`);
    const end = new Date(`${endStr}T00:00:00Z`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      end.setUTCDate(end.getUTCDate() + 1); // inclusive last day → exclusive next-day midnight
      if (end > start) return { start, end };
    }
  }
  const now = new Date();
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

// Find (by siteId + start) or create an invoice-derived billing period for a site.
async function findOrCreateInvoicePeriod(
  siteId: string,
  start: Date,
  end: Date,
  demandIntervalMinutes: number,
) {
  const existing = await db.query.billingPeriods.findFirst({
    where: and(eq(billingPeriods.siteId, siteId), eq(billingPeriods.periodStart, start)),
  });
  if (existing) return existing;
  const [created] = await db
    .insert(billingPeriods)
    .values({
      siteId,
      periodStart: start,
      periodEnd: end,
      boundaryInclusivity: "half_open",
      demandIntervalMinutes,
      label: start.toLocaleString("en-ZA", { month: "long", year: "numeric" }),
      source: "invoice_derived",
      status: "open",
    })
    .returning();
  return created;
}

// Upload an invoice and start parsing ASYNCHRONOUSLY. Parsing calls out to Claude
// (and poppler) and can take seconds-to-minutes on scanned bills, which is too long
// to hold an HTTP request open (the client would spin and the edge could time out).
// So we store the PDF, create the invoice row in a "parsing" state, kick the parse
// off in the background, and return immediately. The client polls invoices.get and
// a completion alert lands in the inbox when it finishes. See runInvoiceParse.
export async function invoicesUploadAndParse(ctx: AuthContext, input: unknown) {
  const parsed = invoicesUploadAndParseInput.parse(input);
  await requireSiteEditor(ctx, parsed.siteId);

  const site = await db.query.sites.findFirst({ where: eq(sites.id, parsed.siteId) });
  if (!site) {
    throw new PreconditionError("Site not found");
  }

  const pdfBuffer = Buffer.from(parsed.contentBase64, "base64");
  if (pdfBuffer.length === 0) {
    throw new Error("Uploaded file is empty");
  }

  // Store the PDF up front (fast) so the row references it and the background job
  // (and any retry) can re-read it. The real billing period isn't known until the
  // parse runs, so create the row with placeholder period dates it will overwrite.
  const fileHash = createHash("sha256").update(pdfBuffer).digest("hex");
  const fileStorageKey = `invoices/${parsed.siteId}/pending/${randomUUID()}.pdf`;
  await putObject(fileStorageKey, pdfBuffer, "application/pdf");

  const placeholder = new Date();
  const [invoice] = await db
    .insert(landlordInvoices)
    .values({
      siteId: parsed.siteId,
      billingPeriodStart: placeholder,
      billingPeriodEnd: placeholder,
      fileStorageKey,
      fileHash,
      status: "uploaded",
      uploadedByUserId: ctx.userId,
    })
    .returning();

  // Fire-and-forget: the Railway server is a persistent process, so the parse keeps
  // running after we respond. Errors are recorded on the row (parseError) by
  // runInvoiceParse itself; the .catch here is just a last-resort log.
  void runInvoiceParse(invoice.id).catch((err) =>
    console.error(`[upload] background parse crashed for invoice ${invoice.id}:`, err),
  );

  return { invoiceId: invoice.id, status: "parsing" as const };
}

// Background worker: read the stored PDF, parse it with Claude, detect the billing
// period, persist the line items, and notify the customer. Records a failure reason
// on the invoice (parseError) and reverts it to "uploaded" (retryable) on any error.
// Safe to call fire-and-forget; it owns its own error handling.
async function runInvoiceParse(invoiceId: string): Promise<void> {
  const traceId = randomUUID().slice(0, 8);
  const log = (msg: string) => console.log(`[parse ${traceId}] invoice=${invoiceId} ${msg}`);

  const invoice = await db.query.landlordInvoices.findFirst({
    where: eq(landlordInvoices.id, invoiceId),
  });
  if (!invoice) {
    log("not found — skipping");
    return;
  }
  const site = await db.query.sites.findFirst({ where: eq(sites.id, invoice.siteId) });

  await db
    .update(landlordInvoices)
    .set({ status: "parsing", parseError: null })
    .where(eq(landlordInvoices.id, invoiceId));

  try {
    log("reading stored pdf");
    const pdfBuffer = await getObject(invoice.fileStorageKey);
    const parsedInvoice = await parseInvoiceWithClaude(pdfBuffer);
    log(`parsed ${parsedInvoice.lineItems.length} line items, model=${parsedInvoice.parseModel}`);

    const { start, end } = invoicePeriodBounds(parsedInvoice.periodStart, parsedInvoice.periodEnd);
    const period = await findOrCreateInvoicePeriod(
      invoice.siteId,
      start,
      end,
      site?.demandIntervalMinutes ?? 30,
    );
    await db
      .update(landlordInvoices)
      .set({
        billingPeriodId: period.id,
        billingPeriodStart: period.periodStart,
        billingPeriodEnd: period.periodEnd,
      })
      .where(eq(landlordInvoices.id, invoiceId));

    // persistParsedInvoice flips status to "parsed_pending_confirm" and inserts lines.
    await persistParsedInvoice(invoiceId, parsedInvoice);
    log("done — pending confirm");

    await dispatchInvoiceParsed({
      invoiceId,
      siteId: invoice.siteId,
      organizationId: site?.organizationId ?? "",
      siteName: site?.name ?? "your site",
      ok: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`FAILED: ${message}`);
    await db
      .update(landlordInvoices)
      .set({ status: "uploaded", parseError: message })
      .where(eq(landlordInvoices.id, invoiceId));

    await dispatchInvoiceParsed({
      invoiceId,
      siteId: invoice.siteId,
      organizationId: site?.organizationId ?? "",
      siteName: site?.name ?? "your site",
      ok: false,
      errorMessage: message,
    });
  }
}

// Re-run parsing after a failure (or if it got stuck). Clears the error and kicks
// the background job off again against the already-stored PDF.
export async function invoicesRetryParse(ctx: AuthContext, input: unknown) {
  const parsed = invoicesRetryParseInput.parse(input);

  const invoice = await db.query.landlordInvoices.findFirst({
    where: eq(landlordInvoices.id, parsed.invoiceId),
  });
  if (!invoice) {
    throw new PreconditionError("Invoice not found");
  }
  await requireSiteEditor(ctx, invoice.siteId);
  if (invoice.status !== "uploaded" && invoice.status !== "parsing") {
    throw new ForbiddenError("This invoice has already been parsed.");
  }

  await db
    .update(landlordInvoices)
    .set({ status: "uploaded", parseError: null })
    .where(eq(landlordInvoices.id, parsed.invoiceId));

  void runInvoiceParse(parsed.invoiceId).catch((err) =>
    console.error(`[retry] background parse crashed for invoice ${parsed.invoiceId}:`, err),
  );

  return { invoiceId: parsed.invoiceId, status: "parsing" as const };
}

// Correct the billing period on an invoice (dates come from the invoice; the user
// can fix them in review before locking). Input dates are inclusive; stored as a
// half-open period.
export async function invoicesSetPeriod(ctx: AuthContext, input: unknown) {
  const parsed = invoicesSetPeriodInput.parse(input);

  const invoice = await db.query.landlordInvoices.findFirst({
    where: eq(landlordInvoices.id, parsed.invoiceId),
  });
  if (!invoice) {
    throw new PreconditionError("Invoice not found");
  }
  await requireSiteEditor(ctx, invoice.siteId);
  if (invoice.status !== "parsed_pending_confirm" && invoice.status !== "uploaded") {
    throw new ForbiddenError(
      "The billing period can only be changed before the invoice is confirmed",
    );
  }

  const start = new Date(
    Date.UTC(
      parsed.periodStart.getUTCFullYear(),
      parsed.periodStart.getUTCMonth(),
      parsed.periodStart.getUTCDate(),
    ),
  );
  const endExclusive = new Date(
    Date.UTC(
      parsed.periodEnd.getUTCFullYear(),
      parsed.periodEnd.getUTCMonth(),
      parsed.periodEnd.getUTCDate() + 1,
    ),
  );
  if (endExclusive <= start) {
    throw new PreconditionError("The period end must be on or after the period start");
  }

  const site = await db.query.sites.findFirst({ where: eq(sites.id, invoice.siteId) });
  const period = await findOrCreateInvoicePeriod(
    invoice.siteId,
    start,
    endExclusive,
    site?.demandIntervalMinutes ?? 30,
  );

  await db
    .update(landlordInvoices)
    .set({
      billingPeriodId: period.id,
      billingPeriodStart: period.periodStart,
      billingPeriodEnd: period.periodEnd,
    })
    .where(eq(landlordInvoices.id, parsed.invoiceId));

  return {
    invoiceId: parsed.invoiceId,
    billingPeriodStart: period.periodStart,
    billingPeriodEnd: period.periodEnd,
  };
}

export async function invoicesGet(ctx: AuthContext, input: unknown) {
  const parsed = invoicesGetInput.parse(input);

  const invoice = await db.query.landlordInvoices.findFirst({
    where: eq(landlordInvoices.id, parsed.invoiceId),
  });

  if (!invoice) {
    throw new Error("Invoice not found");
  }

  await requireSiteAccess(ctx, invoice.siteId);

  return invoice;
}

export async function invoicesList(ctx: AuthContext, input: unknown) {
  const parsed = invoicesListInput.parse(input);
  await requireSiteAccess(ctx, parsed.siteId);

  const invoices = await db.query.landlordInvoices.findMany({
    where: eq(landlordInvoices.siteId, parsed.siteId),
    limit: parsed.limit,
    offset: parsed.offset,
  });

  const total = (
    await db.query.landlordInvoices.findMany({
      where: eq(landlordInvoices.siteId, parsed.siteId),
    })
  ).length;

  return { invoices, total };
}

export async function invoicesListLineItems(ctx: AuthContext, input: unknown) {
  const parsed = invoicesListLineItemsInput.parse(input);

  const invoice = await db.query.landlordInvoices.findFirst({
    where: eq(landlordInvoices.id, parsed.invoiceId),
  });

  if (!invoice) {
    throw new Error("Invoice not found");
  }

  await requireSiteAccess(ctx, invoice.siteId);

  const lineItems = await db.query.invoiceLineItems.findMany({
    where: eq(invoiceLineItems.invoiceId, parsed.invoiceId),
  });

  return { lineItems };
}

export async function invoicesUpdateLineItem(ctx: AuthContext, input: unknown) {
  const parsed = invoicesUpdateLineItemInput.parse(input);

  const lineItem = await db.query.invoiceLineItems.findFirst({
    where: eq(invoiceLineItems.id, parsed.lineItemId),
  });

  if (!lineItem) {
    throw new Error("Line item not found");
  }

  const invoice = await db.query.landlordInvoices.findFirst({
    where: eq(landlordInvoices.id, lineItem.invoiceId),
  });

  if (!invoice) {
    throw new Error("Invoice not found");
  }

  await requireSiteEditor(ctx, invoice.siteId);

  if (invoice.status !== "parsed_pending_confirm") {
    throw new Error("Invoice must be in parsed_pending_confirm status to update line items");
  }

  const result = await db
    .update(invoiceLineItems)
    .set({
      confirmedCategory: parsed.confirmedCategory,
      confirmedValueCents: parsed.confirmedValueCents,
    })
    .where(eq(invoiceLineItems.id, parsed.lineItemId))
    .returning();

  return { lineItem: result[0] };
}

export async function invoicesConfirm(ctx: AuthContext, input: unknown) {
  const parsed = invoicesConfirmInput.parse(input);

  const invoice = await db.query.landlordInvoices.findFirst({
    where: eq(landlordInvoices.id, parsed.invoiceId),
  });

  if (!invoice) {
    throw new Error("Invoice not found");
  }

  await requireSiteEditor(ctx, invoice.siteId);

  if (invoice.status !== "parsed_pending_confirm") {
    throw new Error("Invoice must be in parsed_pending_confirm status to confirm");
  }

  const result = await db
    .update(landlordInvoices)
    .set({
      status: "confirmed",
      confirmedActiveCents: parsed.confirmedActiveCents,
      confirmedDemandCents: parsed.confirmedDemandCents,
      confirmedReactiveCents: parsed.confirmedReactiveCents,
      confirmedFixedCents: parsed.confirmedFixedCents,
      confirmedTotalCents: parsed.confirmedTotalCents,
      confirmedByUserId: ctx.userId,
      confirmedAt: new Date(),
    })
    .where(eq(landlordInvoices.id, parsed.invoiceId))
    .returning();

  return { invoice: result[0] };
}

export async function invoicesLock(ctx: AuthContext, input: unknown) {
  const parsed = invoicesLockInput.parse(input);

  const invoice = await db.query.landlordInvoices.findFirst({
    where: eq(landlordInvoices.id, parsed.invoiceId),
  });

  if (!invoice) {
    throw new Error("Invoice not found");
  }

  await requireSiteEditor(ctx, invoice.siteId);

  if (invoice.status !== "confirmed") {
    throw new Error("Invoice must be confirmed before locking");
  }

  const result = await db
    .update(landlordInvoices)
    .set({
      status: "locked",
      lockedAt: new Date(),
    })
    .where(eq(landlordInvoices.id, parsed.invoiceId))
    .returning();

  return { invoice: result[0] };
}

// Map a canonical component to the reconciliation bucket. The human-confirmed
// component (editable in review) is authoritative over the parser's guess.
function componentToBucket(
  component: string,
): "active" | "demand" | "reactive" | "fixed" | "other" {
  switch (component) {
    case "active_energy":
    case "generation":
      return "active";
    case "demand":
      return "demand";
    case "reactive_energy":
      return "reactive";
    case "network":
    case "service_fixed":
    case "levy_surcharge":
      return "fixed";
    default:
      return "other";
  }
}

/**
 * The overhaul's one action: persist the human-confirmed grouping for every line,
 * derive the reconcilable base from the tenant-electricity lines, lock the invoice
 * (the freeze point — automatic + invisible, so the numbers are pinned for the
 * legal record), and generate the reconciliation. The customer lands on the recon
 * immediately; it is 'provisional' until Sparks QA signs it off.
 */
export async function invoicesConfirmReconcile(ctx: AuthContext, input: unknown) {
  const parsed = invoicesConfirmReconcileInput.parse(input);

  const invoice = await db.query.landlordInvoices.findFirst({
    where: eq(landlordInvoices.id, parsed.invoiceId),
  });
  if (!invoice) {
    throw new Error("Invoice not found");
  }
  await requireSiteEditor(ctx, invoice.siteId);

  // Editable up to lock; a locked invoice must be Reopened first.
  if (invoice.status === "locked") {
    throw new ForbiddenError("Invoice is locked. Reopen it before changing the grouping.");
  }

  const existing = await db.query.invoiceLineItems.findMany({
    where: eq(invoiceLineItems.invoiceId, parsed.invoiceId),
  });
  const byId = new Map(existing.map((l) => [l.id, l]));

  let active = 0;
  let demand = 0;
  let reactive = 0;
  let fixed = 0;
  let reconcilableTotal = 0;

  for (const line of parsed.lines) {
    if (!byId.has(line.lineItemId)) {
      throw new PreconditionError(`Line item ${line.lineItemId} does not belong to this invoice`);
    }
    const { category } = deriveLineCategory(line.component, byId.get(line.lineItemId)?.rawLabel ?? "");
    await db
      .update(invoiceLineItems)
      .set({
        confirmedUtility: line.utility,
        confirmedSupplyGroup: line.supplyGroup,
        confirmedComponent: line.component,
        confirmedCategory: category,
        confirmedValueCents: line.valueCents,
      })
      .where(eq(invoiceLineItems.id, line.lineItemId));

    // Reconcilable base = tenant electricity only.
    if (line.utility === "electricity" && line.supplyGroup === "tenant") {
      reconcilableTotal += line.valueCents;
      switch (componentToBucket(line.component)) {
        case "active":
          active += line.valueCents;
          break;
        case "demand":
          demand += line.valueCents;
          break;
        case "reactive":
          reactive += line.valueCents;
          break;
        case "fixed":
          fixed += line.valueCents;
          break;
      }
    }
  }

  // Prerequisites that would otherwise fail AFTER the lock (below) — check them first,
  // while the invoice is still editable, so a missing setup step doesn't strand the
  // invoice in a locked state the customer can't retry out of.
  if (!invoice.billingPeriodId) {
    throw new PreconditionError("Invoice has no billing period");
  }
  const landlordTariff = await db.query.siteTariffAssignments.findFirst({
    where: and(
      eq(siteTariffAssignments.siteId, invoice.siteId),
      eq(siteTariffAssignments.role, "landlord"),
    ),
  });
  if (!landlordTariff) {
    throw new PreconditionError(
      "This site has no landlord tariff assigned yet, so the bill can't be reconciled. " +
        "Assign a landlord tariff to the site, then send for review.",
    );
  }

  // Confirm + lock (the invisible freeze point) in one step. Reconciliation requires
  // a locked invoice, so we must lock before running it — but if reconciliation then
  // fails for any reason, roll the lock back so the invoice stays editable and the
  // customer can fix the cause and retry (previously it got stuck "locked").
  await db
    .update(landlordInvoices)
    .set({
      status: "locked",
      confirmedActiveCents: active,
      confirmedDemandCents: demand,
      confirmedReactiveCents: reactive,
      confirmedFixedCents: fixed,
      confirmedTotalCents: reconcilableTotal,
      confirmedByUserId: ctx.userId,
      confirmedAt: new Date(),
      lockedAt: new Date(),
    })
    .where(eq(landlordInvoices.id, parsed.invoiceId));

  let recon: Awaited<ReturnType<typeof runReconciliationForPeriod>>;
  try {
    recon = await runReconciliationForPeriod(invoice.billingPeriodId);
  } catch (err) {
    await db
      .update(landlordInvoices)
      .set({ status: invoice.status, lockedAt: invoice.lockedAt })
      .where(eq(landlordInvoices.id, parsed.invoiceId));
    throw err;
  }

  return {
    reconId: recon.reconId,
    version: recon.version,
    reviewStatus: "provisional" as const,
    reconcilableTotalCents: reconcilableTotal,
  };
}

// The customer's explicit "Send to Sparks for review" — records the request. Every
// reconciliation is already queued for QA on generation; this flags the customer's
// ask (and can carry a note) so the operator can prioritise it.
export async function invoicesRequestReview(ctx: AuthContext, input: unknown) {
  const parsed = invoicesRequestReviewInput.parse(input);

  const invoice = await db.query.landlordInvoices.findFirst({
    where: eq(landlordInvoices.id, parsed.invoiceId),
  });
  if (!invoice) {
    throw new Error("Invoice not found");
  }
  await requireSiteEditor(ctx, invoice.siteId);

  await db
    .update(landlordInvoices)
    .set({ reviewRequestedAt: new Date() })
    .where(eq(landlordInvoices.id, parsed.invoiceId));

  // Attach the note to the latest recon for this invoice, if any, without changing
  // its review_status (Sparks still drives provisional → reviewed/flagged).
  if (parsed.note) {
    const latest = await db.query.reconciliations.findMany({
      where: eq(reconciliations.invoiceId, invoice.id),
    });
    const newest = latest.sort((a, b) => b.version - a.version)[0];
    if (newest) {
      await db
        .update(reconciliations)
        .set({ reviewNote: parsed.note })
        .where(eq(reconciliations.id, newest.id));
    }
  }

  // Notify the Sparks review inbox with the AI breakdown + the original PDF, so a
  // person can review it. Fire-and-forget: a failed email must not fail the send.
  void sendReviewRequestEmail(invoice, parsed.note ?? null).catch((err) =>
    console.error(`[review-email] failed for invoice ${parsed.invoiceId}:`, err),
  );

  return { invoiceId: parsed.invoiceId, reviewRequestedAt: new Date() };
}

// Assembles + sends the internal "please review this bill" email to the Sparks
// review inbox (SPARKS_REVIEW_EMAIL). No-op with a log if that env is unset.
async function sendReviewRequestEmail(
  invoice: typeof landlordInvoices.$inferSelect,
  note: string | null,
): Promise<void> {
  // SPARKS_REVIEW_EMAIL may be a comma-separated list so the whole Sparks team
  // (e.g. both brothers) receives every review request.
  const reviewInbox = (process.env.SPARKS_REVIEW_EMAIL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (reviewInbox.length === 0) {
    console.warn("[review-email] SPARKS_REVIEW_EMAIL not set — skipping review email.");
    return;
  }

  const site = await db.query.sites.findFirst({ where: eq(sites.id, invoice.siteId) });
  const org = site
    ? await db.query.organization.findFirst({ where: eq(organization.id, site.organizationId) })
    : null;
  const uploader = invoice.uploadedByUserId
    ? await db.query.user.findFirst({ where: eq(user.id, invoice.uploadedByUserId) })
    : null;
  const lineRows = await db.query.invoiceLineItems.findMany({
    where: eq(invoiceLineItems.invoiceId, invoice.id),
  });

  let statedTotalCents: number | null = null;
  try {
    const raw =
      typeof invoice.parsedRaw === "string" ? JSON.parse(invoice.parsedRaw) : invoice.parsedRaw;
    if (raw && typeof raw.totalCents === "number") statedTotalCents = raw.totalCents;
  } catch {
    // leave null
  }

  const { subject, html } = billReviewRequestEmail({
    orgName: org?.name ?? "Customer",
    siteName: site?.name ?? "Site",
    customerEmail: uploader?.email ?? "unknown",
    reconcilableTotalCents: invoice.confirmedTotalCents ?? 0,
    statedTotalCents,
    periodStart: invoice.billingPeriodStart,
    periodEnd: invoice.billingPeriodEnd,
    note,
    lines: lineRows.map((l) => ({
      rawLabel: l.rawLabel,
      utility: l.confirmedUtility ?? l.utility ?? "other",
      supplyGroup: l.confirmedSupplyGroup ?? l.supplyGroup ?? "unknown",
      component: l.confirmedComponent ?? l.component ?? "other",
      unit: l.unit,
      quantity: l.quantity !== null ? Number(l.quantity) : null,
      rate: l.rate !== null ? Number(l.rate) : null,
      valueCents: l.confirmedValueCents ?? l.parsedValueCents ?? 0,
    })),
    adminUrl: `${process.env.WEB_URL || "http://localhost:3000"}/admin`,
  });

  // Attach the original invoice PDF if the stored object is present.
  let attachments: { filename: string; content: Buffer }[] | undefined;
  try {
    if (await objectExists(invoice.fileStorageKey)) {
      const pdf = await getObject(invoice.fileStorageKey);
      attachments = [{ filename: `invoice-${invoice.id.slice(0, 8)}.pdf`, content: pdf }];
    }
  } catch (err) {
    console.warn(`[review-email] could not attach PDF for invoice ${invoice.id}:`, err);
  }

  await sendEmail({ to: reviewInbox, subject, html, attachments });
}

// Reopen a locked invoice so the grouping can be corrected and the reconciliation
// regenerated (as a new version). Explicit un-freeze — the audit trail keeps the
// prior locked numbers + any prior recon versions.
export async function invoicesReopen(ctx: AuthContext, input: unknown) {
  const parsed = invoicesReopenInput.parse(input);

  const invoice = await db.query.landlordInvoices.findFirst({
    where: eq(landlordInvoices.id, parsed.invoiceId),
  });
  if (!invoice) {
    throw new Error("Invoice not found");
  }
  await requireSiteEditor(ctx, invoice.siteId);

  if (invoice.status !== "locked") {
    throw new ForbiddenError("Only a locked invoice can be reopened");
  }

  const result = await db
    .update(landlordInvoices)
    .set({ status: "parsed_pending_confirm", lockedAt: null })
    .where(eq(landlordInvoices.id, parsed.invoiceId))
    .returning();

  return { invoice: result[0] };
}

/* ─────────────── Alerts (in-app inbox) ─────────────── */

// The signed-in user's in-app inbox: their app-channel deliveries joined to the
// alert. Newest first. Scoped by recipientUserId, so a user only sees their own.
export async function alertsList(ctx: AuthContext) {
  const rows = await db
    .select({
      deliveryId: alertDeliveries.id,
      alertId: alerts.id,
      title: alerts.title,
      message: alerts.message,
      severity: alerts.severity,
      type: alerts.type,
      siteId: alerts.siteId,
      payload: alerts.payload,
      createdAt: alerts.createdAt,
      readAt: alertDeliveries.readAt,
    })
    .from(alertDeliveries)
    .innerJoin(alerts, eq(alerts.id, alertDeliveries.alertId))
    .where(and(eq(alertDeliveries.recipientUserId, ctx.userId), eq(alertDeliveries.channel, "app")))
    .orderBy(desc(alerts.createdAt))
    .limit(100);

  return { alerts: rows };
}

export async function alertsUnreadCount(ctx: AuthContext) {
  const rows = await db
    .select({ id: alertDeliveries.id })
    .from(alertDeliveries)
    .where(
      and(
        eq(alertDeliveries.recipientUserId, ctx.userId),
        eq(alertDeliveries.channel, "app"),
        isNull(alertDeliveries.readAt),
      ),
    );
  return { count: rows.length };
}

export async function alertsAcknowledge(ctx: AuthContext, input: unknown) {
  const parsed = alertsAcknowledgeInput.parse(input);
  await db
    .update(alertDeliveries)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(alertDeliveries.id, parsed.deliveryId),
        eq(alertDeliveries.recipientUserId, ctx.userId),
      ),
    );
  return { ok: true };
}

export async function alertsMarkAllRead(ctx: AuthContext) {
  await db
    .update(alertDeliveries)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(alertDeliveries.recipientUserId, ctx.userId),
        eq(alertDeliveries.channel, "app"),
        isNull(alertDeliveries.readAt),
      ),
    );
  return { ok: true };
}

// A short-lived signed URL for an alert's attached document (the operator's
// "description document"), scoped to a recipient of that alert.
export async function alertsAttachmentUrl(ctx: AuthContext, input: unknown) {
  const parsed = alertsAttachmentUrlInput.parse(input);

  const [row] = await db
    .select({ payload: alerts.payload })
    .from(alertDeliveries)
    .innerJoin(alerts, eq(alerts.id, alertDeliveries.alertId))
    .where(
      and(
        eq(alertDeliveries.alertId, parsed.alertId),
        eq(alertDeliveries.recipientUserId, ctx.userId),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ForbiddenError("Alert not found for this user");
  }
  const key = (row.payload as { attachmentKey?: string | null } | null)?.attachmentKey;
  if (!key || !(await objectExists(key))) {
    throw new PreconditionError("This alert has no attachment");
  }
  return { url: await signObjectUrl(key, 3600) };
}

/* ─────────────── Profile ─────────────── */

// Set the signed-in user's optional mobile number (used for the SMS nudge).
export async function profileSetPhone(ctx: AuthContext, input: unknown) {
  const parsed = profileSetPhoneInput.parse(input);
  const phone = parsed.phone.trim();
  await db
    .update(user)
    .set({ phone: phone.length > 0 ? phone : null })
    .where(eq(user.id, ctx.userId));
  return { ok: true, phone: phone.length > 0 ? phone : null };
}

/* ─────────────── Readings / Dashboard (read-only) ─────────────── */

// Near-real-time load: the most recent instantaneous reading across all of the
// site's meters. Read-only aggregation over the existing `readings` table.
export async function readingsLatest(ctx: AuthContext, input: unknown) {
  const parsed = readingsLatestInput.parse(input);
  await requireSiteAccess(ctx, parsed.siteId);

  const meterRows = await db
    .select({ id: meters.id })
    .from(meters)
    .where(eq(meters.siteId, parsed.siteId));

  const meterIds = meterRows.map((m) => m.id);
  if (meterIds.length === 0) {
    return { reading: null };
  }

  const rows = await db
    .select({
      meterId: readings.meterId,
      time: readings.time,
      totalPowerKw: readings.totalPowerKw,
      totalApparentKva: readings.totalApparentKva,
      powerFactor: readings.powerFactor,
    })
    .from(readings)
    .where(inArray(readings.meterId, meterIds))
    .orderBy(desc(readings.time))
    .limit(1);

  return { reading: rows[0] ?? null };
}

// Month-to-date active / demand / reactive for a site, aggregated from the
// existing `demandIntervals` table. `peakDemandKva` is the max interval demand.
export async function readingsMonthToDate(ctx: AuthContext, input: unknown) {
  const parsed = readingsMonthToDateInput.parse(input);
  await requireSiteAccess(ctx, parsed.siteId);

  const now = parsed.asOf ?? new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const rows = await db
    .select({
      activeEnergyKwh: sql<string>`coalesce(sum(${demandIntervals.activeEnergyKwh}), 0)`,
      reactiveEnergyKvarh: sql<string>`coalesce(sum(${demandIntervals.reactiveEnergyKvarh}), 0)`,
      peakDemandKva: sql<string>`coalesce(max(${demandIntervals.avgDemandKva}), 0)`,
      intervalCount: sql<number>`count(*)::int`,
    })
    .from(demandIntervals)
    .where(
      and(
        eq(demandIntervals.siteId, parsed.siteId),
        gte(demandIntervals.intervalStart, periodStart),
      ),
    );

  const agg = rows[0];

  return {
    periodStart: periodStart.toISOString(),
    activeEnergyKwh: agg?.activeEnergyKwh ?? "0",
    reactiveEnergyKvarh: agg?.reactiveEnergyKvarh ?? "0",
    peakDemandKva: agg?.peakDemandKva ?? "0",
    intervalCount: agg?.intervalCount ?? 0,
  };
}

// Total active energy (kWh) per billing period, for the "energy across billing
// periods" bar chart. Buckets by the site's real billing periods when it has any;
// otherwise falls back to calendar months. `basis` tells the UI which was used so
// it can caption the chart ("shown per calendar month until a billing period is
// set"). Returns the trailing `limit` buckets (default 12), oldest→newest.
export async function readingsEnergyByPeriod(ctx: AuthContext, input: unknown) {
  const parsed = readingsEnergyByPeriodInput.parse(input);
  await requireSiteAccess(ctx, parsed.siteId);
  const limit = parsed.limit ?? 12;

  const periods = await db.query.billingPeriods.findMany({
    where: eq(billingPeriods.siteId, parsed.siteId),
    orderBy: [asc(billingPeriods.periodStart)],
  });

  if (periods.length > 0) {
    // Bucket by real billing periods (half-open [start, end)).
    const buckets = await Promise.all(
      periods.map(async (p) => {
        const [row] = await db
          .select({
            activeEnergyKwh: sql<string>`coalesce(sum(${demandIntervals.activeEnergyKwh}), 0)`,
            reactiveEnergyKvarh: sql<string>`coalesce(sum(${demandIntervals.reactiveEnergyKvarh}), 0)`,
          })
          .from(demandIntervals)
          .where(
            and(
              eq(demandIntervals.siteId, parsed.siteId),
              gte(demandIntervals.intervalStart, p.periodStart),
              lt(demandIntervals.intervalStart, p.periodEnd),
            ),
          );
        return {
          label:
            p.label ??
            new Date(p.periodStart).toLocaleDateString("en-ZA", {
              day: "numeric",
              month: "short",
            }),
          periodStart: new Date(p.periodStart).toISOString(),
          periodEnd: new Date(p.periodEnd).toISOString(),
          activeEnergyKwh: row?.activeEnergyKwh ?? "0",
          reactiveEnergyKvarh: row?.reactiveEnergyKvarh ?? "0",
        };
      }),
    );
    return { basis: "billing_period" as const, periods: buckets.slice(-limit) };
  }

  // Fallback: group by calendar month (UTC) straight from the interval table.
  const monthRows = await db
    .select({
      monthStart: sql<string>`date_trunc('month', ${demandIntervals.intervalStart})`,
      activeEnergyKwh: sql<string>`coalesce(sum(${demandIntervals.activeEnergyKwh}), 0)`,
      reactiveEnergyKvarh: sql<string>`coalesce(sum(${demandIntervals.reactiveEnergyKvarh}), 0)`,
    })
    .from(demandIntervals)
    .where(eq(demandIntervals.siteId, parsed.siteId))
    .groupBy(sql`date_trunc('month', ${demandIntervals.intervalStart})`)
    .orderBy(asc(sql`date_trunc('month', ${demandIntervals.intervalStart})`));

  const months = monthRows.map((r) => {
    const start = new Date(r.monthStart);
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    return {
      label: start.toLocaleDateString("en-ZA", { month: "short", year: "2-digit" }),
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      activeEnergyKwh: r.activeEnergyKwh,
      reactiveEnergyKvarh: r.reactiveEnergyKvarh,
    };
  });

  return { basis: "calendar_month" as const, periods: months.slice(-limit) };
}

// Clock-aligned demand intervals for a site within a window (docs/02 §4.1
// `demand.listIntervals`), ordered oldest→newest for direct charting. Read-only;
// defaults to the trailing 24h. Aggregated across the site's meters per interval.
export async function demandListIntervals(ctx: AuthContext, input: unknown) {
  const parsed = demandListIntervalsInput.parse(input);
  await requireSiteAccess(ctx, parsed.siteId);

  const to = parsed.to ?? new Date();
  const from = parsed.from ?? new Date(to.getTime() - 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      intervalStart: demandIntervals.intervalStart,
      intervalMinutes: demandIntervals.intervalMinutes,
      activeEnergyKwh: sql<string>`coalesce(sum(${demandIntervals.activeEnergyKwh}), 0)`,
      reactiveEnergyKvarh: sql<string>`coalesce(sum(${demandIntervals.reactiveEnergyKvarh}), 0)`,
      avgDemandKw: sql<string>`coalesce(sum(${demandIntervals.avgDemandKw}), 0)`,
      avgDemandKva: sql<string>`coalesce(sum(${demandIntervals.avgDemandKva}), 0)`,
      isComplete: sql<boolean>`bool_and(${demandIntervals.isComplete})`,
    })
    .from(demandIntervals)
    .where(
      and(
        eq(demandIntervals.siteId, parsed.siteId),
        gte(demandIntervals.intervalStart, from),
        lte(demandIntervals.intervalStart, to),
      ),
    )
    .groupBy(demandIntervals.intervalStart, demandIntervals.intervalMinutes)
    .orderBy(asc(demandIntervals.intervalStart));

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    intervals: rows.map((r) => ({
      intervalStart: new Date(r.intervalStart).toISOString(),
      intervalMinutes: r.intervalMinutes,
      activeEnergyKwh: r.activeEnergyKwh,
      reactiveEnergyKvarh: r.reactiveEnergyKvarh,
      avgDemandKw: r.avgDemandKw,
      avgDemandKva: r.avgDemandKva,
      isComplete: r.isComplete,
    })),
  };
}
