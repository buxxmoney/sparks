import { z } from "zod";

/* ─────────────── Org ─────────────── */
export const orgCreateInput = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().regex(/^[a-z0-9-]+$/).min(1).max(50).optional(),
});

export const orgGetInput = z.object({
  organizationId: z.string(),
});

export const orgListMembersInput = z.object({
  organizationId: z.string(),
  limit: z.number().int().positive().default(50).optional(),
  offset: z.number().int().nonnegative().default(0).optional(),
});

export const orgInviteInput = z.object({
  organizationId: z.string(),
  email: z.string().email(),
  role: z.enum(["owner", "operator"]).default("operator"),
});

export const orgSetMemberRoleInput = z.object({
  organizationId: z.string(),
  userId: z.string(),
  role: z.enum(["owner", "operator"]),
});

/* ─────────────── Sites ─────────────── */
export const sitesListInput = z.object({
  organizationId: z.string(),
  limit: z.number().int().positive().default(50).optional(),
  offset: z.number().int().nonnegative().default(0).optional(),
});

export const sitesGetInput = z.object({
  siteId: z.string().uuid(),
});

export const sitesCreateInput = z.object({
  organizationId: z.string(),
  name: z.string().min(1).max(255),
  addressLine1: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  province: z.string().max(100).optional(),
  supplyZone: z.string().max(100).optional(),
  timezone: z.string().default("Africa/Johannesburg"),
  demandIntervalMinutes: z.union([z.literal(15), z.literal(30)]).default(30),
});

export const sitesUpdateInput = z.object({
  siteId: z.string().uuid(),
  name: z.string().min(1).max(255).optional(),
  addressLine1: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  province: z.string().max(100).optional(),
  supplyZone: z.string().max(100).optional(),
  timezone: z.string().optional(),
  status: z.string().optional(),
});

export const sitesSetDefaultDemandIntervalInput = z.object({
  siteId: z.string().uuid(),
  demandIntervalMinutes: z.union([z.literal(15), z.literal(30)]),
});

export const sitesDeleteInput = z.object({
  siteId: z.string().uuid(),
});

/* ─────────────── Site Access ─────────────── */
export const siteAccessListInput = z.object({
  siteId: z.string().uuid(),
});

export const siteAccessGrantInput = z.object({
  siteId: z.string().uuid(),
  userId: z.string(),
  role: z.enum(["owner", "site_manager"]),
});

export const siteAccessRevokeInput = z.object({
  siteId: z.string().uuid(),
  userId: z.string(),
});

/* ─────────────── Devices ─────────────── */
export const devicesListInput = z.object({
  siteId: z.string().uuid().optional(),
  limit: z.number().int().positive().default(50).optional(),
  offset: z.number().int().nonnegative().default(0).optional(),
});

export const devicesGetInput = z.object({
  deviceId: z.string().uuid(),
});

export const devicesProvisionInput = z.object({
  organizationId: z.string(),
  serialNumber: z.string().min(1).max(255),
  hardwareModel: z.string().default("rpi"),
  simIccid: z.string().max(20).optional(),
  simMsisdn: z.string().max(20).optional(),
  simProvider: z.string().max(100).optional(),
  connectivityMode: z.enum(["lte", "wifi"]).default("lte"),
});

export const devicesRotateKeyInput = z.object({
  deviceId: z.string().uuid(),
});

export const devicesGetHealthInput = z.object({
  deviceId: z.string().uuid(),
});

export const devicesUpdateSiteInput = z.object({
  deviceId: z.string().uuid(),
  siteId: z.string().uuid().nullable(),
});

/* ─────────────── Meters ─────────────── */
export const metersGetInput = z.object({
  meterId: z.string().uuid(),
});

export const metersCreateInput = z.object({
  deviceId: z.string().uuid(),
  siteId: z.string().uuid(),
  serialNumber: z.string().min(1).max(255),
  model: z.string().default("SDM630MCT"),
  midCertifiedVariant: z.boolean().default(true),
  midCertificateRef: z.string().max(255).optional(),
  ctRatioPrimary: z.number().int().positive().optional(),
  ctRatioSecondary: z.number().int().positive().default(5),
  phaseConfig: z.string().default("3P4W"),
});

export const metersCommissionInput = z.object({
  meterId: z.string().uuid(),
  installedByName: z.string().max(255).optional(),
  installerRegistration: z.string().max(255).optional(),
});

/* ─────────────── Billing ─────────────── */
export const billingPoliciesGetInput = z.object({
  siteId: z.string().uuid(),
});

export const billingPoliciesSetInput = z.object({
  siteId: z.string().uuid(),
  recurrence: z.enum([
    "calendar_month",
    "day_of_month",
    "n_monthly",
    "weekly",
    "fiscal",
    "meter_read",
    "manual",
  ]),
  anchorDay: z.number().int().min(1).max(31).optional(),
  shortMonthPolicy: z.enum(["clamp_last_day", "skip", "rollover"]).default("clamp_last_day"),
  intervalCount: z.number().int().positive().default(1),
  anchorDate: z.coerce.date().optional(),
  fiscalPattern: z.enum(["4-4-5", "4-5-4", "5-4-4"]).default("4-4-5"),
  leapWeekPlacement: z.string().default("last"),
  anchorTimeOfDay: z.string().regex(/^\d{2}:\d{2}$/).default("00:00"),
  boundaryInclusivity: z.enum(["half_open", "inclusive", "half_open_end"]).default("half_open"),
  snapToDemandGrid: z.boolean().default(true),
});

export const billingPeriodsListInput = z.object({
  siteId: z.string().uuid(),
  limit: z.number().int().positive().default(50).optional(),
  offset: z.number().int().nonnegative().default(0).optional(),
});

export const billingPeriodsMaterializeInput = z.object({
  siteId: z.string().uuid(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
});

export const billingPeriodsUpsertInput = z.object({
  siteId: z.string().uuid(),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  source: z.enum(["generated", "manual", "meter_read", "invoice_derived"]),
  label: z.string().max(255).optional(),
  notes: z.string().optional(),
});

export const billingPeriodsCloseInput = z.object({
  periodId: z.string().uuid(),
});

/* ─────────────── Tariffs ─────────────── */
export const tariffsLibraryListInput = z.object({
  type: z.enum(["landlord_stated", "legal_ceiling"]).optional(),
  supplyZone: z.string().optional(),
  limit: z.number().int().positive().default(50).optional(),
  offset: z.number().int().nonnegative().default(0).optional(),
});

export const tariffsLibraryGetInput = z.object({
  tariffProfileId: z.string().uuid(),
});

export const tariffsProfilesCreateInput = z.object({
  organizationId: z.string().optional(),
  name: z.string().min(1).max(255),
  type: z.enum(["landlord_stated", "legal_ceiling"]),
  source: z.enum(["library", "custom"]),
  supplyZone: z.string().max(100).optional(),
  distributor: z.string().max(255).optional(),
  currency: z.string().default("ZAR"),
  touSchedule: z.record(z.any()).optional(),
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().optional(),
  validatedByAttorney: z.boolean().default(false),
});

export const tariffsProfilesUpdateInput = z.object({
  tariffProfileId: z.string().uuid(),
  name: z.string().min(1).max(255).optional(),
  distributor: z.string().max(255).optional(),
  touSchedule: z.record(z.any()).optional(),
  effectiveTo: z.coerce.date().optional(),
  validatedByAttorney: z.boolean().optional(),
});

export const tariffsProfilesAddRateInput = z.object({
  tariffProfileId: z.string().uuid(),
  chargeType: z.enum(["active_energy", "demand", "reactive_energy", "fixed", "ancillary"]),
  unit: z.enum(["c_per_kwh", "r_per_kva", "c_per_kvarh", "r_per_day", "r_per_month"]),
  rateValue: z.string().regex(/^\d+(\.\d{1,6})?$/),
  season: z.enum(["high", "low", "all"]).default("all"),
  touPeriod: z.enum(["peak", "standard", "offpeak", "all"]).default("all"),
  blockThresholdKwh: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
});

export const tariffsProfilesListRatesInput = z.object({
  tariffProfileId: z.string().uuid(),
});

export const tariffsAssignSetInput = z.object({
  siteId: z.string().uuid(),
  tariffProfileId: z.string().uuid(),
  role: z.enum(["landlord", "legal_ceiling"]),
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().optional(),
});

export const tariffsAssignListInput = z.object({
  siteId: z.string().uuid(),
});

/* ─────────────── Reconciliation ─────────────── */
export const reconciliationGenerateInput = z.object({
  billingPeriodId: z.string().uuid(),
});

export const reconciliationGetInput = z.object({
  reconId: z.string().uuid(),
});

export const reconciliationListInput = z.object({
  siteId: z.string().uuid(),
  limit: z.number().int().positive().default(50).optional(),
  offset: z.number().int().nonnegative().default(0).optional(),
});

export const reconciliationListVersionsInput = z.object({
  billingPeriodId: z.string().uuid(),
});

export const reconciliationFinalizeInput = z.object({
  reconId: z.string().uuid(),
});

/* ─────────────── Device Ingestion ─────────────── */
export const ingestReadingsBatchInput = z.object({
  readings: z.array(
    z.object({
      meterId: z.string().uuid(),
      time: z.coerce.date(),
      seq: z.union([z.number(), z.bigint()]).optional(),
      activeEnergyKwh: z.string().optional(),
      reactiveEnergyKvarh: z.string().optional(),
      apparentEnergyKvah: z.string().optional(),
      totalPowerKw: z.string().optional(),
      totalApparentKva: z.string().optional(),
      powerFactor: z.string().optional(),
    })
  ),
  timestamp: z.coerce.date(),
});

export const ingestHealthInput = z.object({
  deviceId: z.string().uuid(),
  time: z.coerce.date(),
  connectivityMode: z.enum(["lte", "wifi"]).optional(),
  signalRssi: z.number().optional(),
  upsStatus: z.enum(["on_mains", "charging", "on_battery", "degraded", "unknown"]).optional(),
  batteryPct: z.number().int().min(0).max(100).optional(),
  cpuTempC: z.number().optional(),
  bufferedRecords: z.number().int().optional(),
});

export const deviceConfigInput = z.object({
  deviceId: z.string().uuid(),
  provisioningToken: z.string(),
});

/* Type exports for use in procedures */
export type OrgCreateInput = z.infer<typeof orgCreateInput>;
export type OrgGetInput = z.infer<typeof orgGetInput>;
export type OrgListMembersInput = z.infer<typeof orgListMembersInput>;
export type OrgInviteInput = z.infer<typeof orgInviteInput>;
export type OrgSetMemberRoleInput = z.infer<typeof orgSetMemberRoleInput>;

export type SitesListInput = z.infer<typeof sitesListInput>;
export type SitesGetInput = z.infer<typeof sitesGetInput>;
export type SitesCreateInput = z.infer<typeof sitesCreateInput>;
export type SitesUpdateInput = z.infer<typeof sitesUpdateInput>;
export type SitesSetDefaultDemandIntervalInput = z.infer<
  typeof sitesSetDefaultDemandIntervalInput
>;
export type SitesDeleteInput = z.infer<typeof sitesDeleteInput>;

export type SiteAccessListInput = z.infer<typeof siteAccessListInput>;
export type SiteAccessGrantInput = z.infer<typeof siteAccessGrantInput>;
export type SiteAccessRevokeInput = z.infer<typeof siteAccessRevokeInput>;

export type DevicesListInput = z.infer<typeof devicesListInput>;
export type DevicesGetInput = z.infer<typeof devicesGetInput>;
export type DevicesProvisionInput = z.infer<typeof devicesProvisionInput>;
export type DevicesRotateKeyInput = z.infer<typeof devicesRotateKeyInput>;
export type DevicesGetHealthInput = z.infer<typeof devicesGetHealthInput>;
export type DevicesUpdateSiteInput = z.infer<typeof devicesUpdateSiteInput>;

export type MetersGetInput = z.infer<typeof metersGetInput>;
export type MetersCreateInput = z.infer<typeof metersCreateInput>;
export type MetersCommissionInput = z.infer<typeof metersCommissionInput>;

export type BillingPoliciesGetInput = z.infer<typeof billingPoliciesGetInput>;
export type BillingPoliciesSetInput = z.infer<typeof billingPoliciesSetInput>;
export type BillingPeriodsListInput = z.infer<typeof billingPeriodsListInput>;
export type BillingPeriodsMaterializeInput = z.infer<typeof billingPeriodsMaterializeInput>;
export type BillingPeriodsUpsertInput = z.infer<typeof billingPeriodsUpsertInput>;
export type BillingPeriodsCloseInput = z.infer<typeof billingPeriodsCloseInput>;

export type TariffsLibraryListInput = z.infer<typeof tariffsLibraryListInput>;
export type TariffsLibraryGetInput = z.infer<typeof tariffsLibraryGetInput>;
export type TariffsProfilesCreateInput = z.infer<typeof tariffsProfilesCreateInput>;
export type TariffsProfilesUpdateInput = z.infer<typeof tariffsProfilesUpdateInput>;
export type TariffsProfilesAddRateInput = z.infer<typeof tariffsProfilesAddRateInput>;
export type TariffsProfilesListRatesInput = z.infer<typeof tariffsProfilesListRatesInput>;
export type TariffsAssignSetInput = z.infer<typeof tariffsAssignSetInput>;
export type TariffsAssignListInput = z.infer<typeof tariffsAssignListInput>;

export type ReconciliationGenerateInput = z.infer<typeof reconciliationGenerateInput>;
export type ReconciliationGetInput = z.infer<typeof reconciliationGetInput>;
export type ReconciliationListInput = z.infer<typeof reconciliationListInput>;
export type ReconciliationListVersionsInput = z.infer<typeof reconciliationListVersionsInput>;
export type ReconciliationFinalizeInput = z.infer<typeof reconciliationFinalizeInput>;
