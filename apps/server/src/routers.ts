import {
  getDb,
  sites,
  siteAccess,
  billingCyclePolicies,
  billingPeriods,
  devices,
  meters,
  tariffProfiles,
  tariffRates,
  siteTariffAssignments,
} from "@sparks/db";
import { eq, and, desc, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { randomBytes, createHash } from "node:crypto";
import type { AuthContext } from "./middleware";
import { requireOrg, requireSiteAccess, ForbiddenError, requirePlatformOperator } from "./middleware";
import {
  orgCreateInput,
  orgGetInput,
  orgListMembersInput,
  orgInviteInput,
  orgSetMemberRoleInput,
  sitesListInput,
  sitesGetInput,
  sitesCreateInput,
  sitesUpdateInput,
  sitesSetDefaultDemandIntervalInput,
  sitesDeleteInput,
  siteAccessListInput,
  siteAccessGrantInput,
  siteAccessRevokeInput,
  devicesListInput,
  devicesGetInput,
  devicesProvisionInput,
  devicesRotateKeyInput,
  devicesGetHealthInput,
  devicesUpdateSiteInput,
  metersGetInput,
  metersCreateInput,
  metersCommissionInput,
  billingPoliciesGetInput,
  billingPoliciesSetInput,
  billingPeriodsListInput,
  billingPeriodsMaterializeInput,
  billingPeriodsUpsertInput,
  billingPeriodsCloseInput,
  tariffsLibraryListInput,
  tariffsLibraryGetInput,
  tariffsProfilesCreateInput,
  tariffsProfilesUpdateInput,
  tariffsProfilesAddRateInput,
  tariffsProfilesListRatesInput,
  tariffsAssignSetInput,
  tariffsAssignListInput,
} from "./validators";
import { materializePeriods, type BillingPeriodPolicy } from "./billing";

const db = getDb();

/* ─────────────── Org Router ─────────────── */

export async function orgCreate(_ctx: AuthContext, input: unknown) {
  orgCreateInput.parse(input);
  // TODO: Call better-auth org create when available
  throw new ForbiddenError("Org creation not yet implemented");
}

export async function orgGet(ctx: AuthContext, input: unknown) {
  const parsed = orgGetInput.parse(input);
  await requireOrg(ctx, parsed.organizationId);
  // TODO: Return org data from better-auth organization table
  return { organizationId: parsed.organizationId };
}

export async function orgListMembers(ctx: AuthContext, input: unknown) {
  const parsed = orgListMembersInput.parse(input);
  await requireOrg(ctx, parsed.organizationId);
  // TODO: Query better-auth member table for org members
  return { members: [], total: 0 };
}

export async function orgInvite(ctx: AuthContext, input: unknown) {
  const parsed = orgInviteInput.parse(input);
  await requireOrg(ctx, parsed.organizationId);
  // Verify user is org owner
  // TODO: Query org membership to confirm owner role
  // TODO: Call better-auth invitation create
  throw new ForbiddenError("Org invite not yet implemented");
}

export async function orgSetMemberRole(ctx: AuthContext, input: unknown) {
  const parsed = orgSetMemberRoleInput.parse(input);
  await requireOrg(ctx, parsed.organizationId);
  // Owner-only: verify ctx.userId is org owner
  // TODO: Query org membership to confirm owner role
  // TODO: Update member role via better-auth
  throw new ForbiddenError("Set member role not yet implemented");
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
  await requireSiteAccess(ctx, parsed.siteId);

  const site = await db.query.sites.findFirst({
    where: eq(sites.id, parsed.siteId),
  });

  if (!site) {
    throw new Error("Site not found");
  }

  return site;
}

export async function sitesCreate(ctx: AuthContext, input: unknown) {
  const parsed = sitesCreateInput.parse(input);
  await requireOrg(ctx, parsed.organizationId);

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

  // Grant org owner access to the new site
  await db.insert(siteAccess).values({
    id: randomUUID(),
    siteId: newSite.id,
    userId: ctx.userId,
    role: "owner" as const,
  });

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
  await requireSiteAccess(ctx, parsed.siteId);

  // Verify user is site owner
  const access = await db.query.siteAccess.findFirst({
    where: and(eq(siteAccess.siteId, parsed.siteId), eq(siteAccess.userId, ctx.userId)),
  });

  if (access?.role !== "owner") {
    throw new ForbiddenError("Only site owners can delete sites");
  }

  await db.delete(sites).where(eq(sites.id, parsed.siteId));

  return { deleted: parsed.siteId };
}

/* ─────────────── Site Access Router ─────────────── */

export async function siteAccessList(ctx: AuthContext, input: unknown) {
  const parsed = siteAccessListInput.parse(input);
  await requireSiteAccess(ctx, parsed.siteId);

  const grants = await db.query.siteAccess.findMany({
    where: eq(siteAccess.siteId, parsed.siteId),
  });

  return { grants };
}

export async function siteAccessGrant(ctx: AuthContext, input: unknown) {
  const parsed = siteAccessGrantInput.parse(input);
  await requireSiteAccess(ctx, parsed.siteId);

  // Verify user is site owner
  const access = await db.query.siteAccess.findFirst({
    where: and(eq(siteAccess.siteId, parsed.siteId), eq(siteAccess.userId, ctx.userId)),
  });

  if (access?.role !== "owner") {
    throw new ForbiddenError("Only site owners can grant access");
  }

  // Upsert the access grant
  const existing = await db.query.siteAccess.findFirst({
    where: and(eq(siteAccess.siteId, parsed.siteId), eq(siteAccess.userId, parsed.userId)),
  });

  if (existing) {
    await db
      .update(siteAccess)
      .set({ role: parsed.role })
      .where(
        and(eq(siteAccess.siteId, parsed.siteId), eq(siteAccess.userId, parsed.userId)),
      );
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
  await requireSiteAccess(ctx, parsed.siteId);

  // Verify user is site owner
  const access = await db.query.siteAccess.findFirst({
    where: and(eq(siteAccess.siteId, parsed.siteId), eq(siteAccess.userId, ctx.userId)),
  });

  if (access?.role !== "owner") {
    throw new ForbiddenError("Only site owners can revoke access");
  }

  await db
    .delete(siteAccess)
    .where(and(eq(siteAccess.siteId, parsed.siteId), eq(siteAccess.userId, parsed.userId)));

  return { revoked: true };
}

/* ─────────────── Devices Router ─────────────── */

export async function devicesList(ctx: AuthContext, input: unknown) {
  const parsed = devicesListInput.parse(input);

  let rows: typeof devices.$inferSelect[] = [];
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

  await db.update(devices).set({ apiKeyHash: deviceSecretHash }).where(eq(devices.id, parsed.deviceId));

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
    where: and(
      eq(tariffProfiles.source, "library"),
      isNull(tariffProfiles.organizationId),
    ),
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
    organizationId: parsed.source === "custom" ? (parsed.organizationId || ctx.organizationId) : null,
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
  if (parsed.validatedByAttorney !== undefined) updateData.validatedByAttorney = parsed.validatedByAttorney;

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
  const blockThresholdKwh = parsed.blockThresholdKwh ? Number.parseFloat(parsed.blockThresholdKwh) : undefined;

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

/* ─────────────── Router Export ─────────────── */

export const appRouter = {
  org: { create: orgCreate, get: orgGet, listMembers: orgListMembers, invite: orgInvite, setMemberRole: orgSetMemberRole },
  sites: { list: sitesList, get: sitesGet, create: sitesCreate, update: sitesUpdate, setDefaultDemandInterval: sitesSetDefaultDemandInterval, delete: sitesDelete },
  siteAccess: { list: siteAccessList, grant: siteAccessGrant, revoke: siteAccessRevoke },
  devices: { list: devicesList, get: devicesGet, provision: devicesProvision, rotateKey: devicesRotateKey, getHealth: devicesGetHealth, updateSite: devicesUpdateSite },
  meters: { get: metersGet, create: metersCreate, commission: metersCommission },
  billing: {
    policies: { get: billingPoliciesGet, set: billingPoliciesSet },
    periods: { list: billingPeriodsList, materialize: billingPeriodsMaterialize, upsert: billingPeriodsUpsert, close: billingPeriodsClose },
  },
  tariffs: {
    library: { list: tariffsLibraryList, get: tariffsLibraryGet },
    profiles: { create: tariffsProfilesCreate, update: tariffsProfilesUpdate, addRate: tariffsProfilesAddRate, listRates: tariffsProfilesListRates },
    assign: { set: tariffsAssignSet, list: tariffsAssignList },
  },
};
