import { z } from "zod";

/* ─────────────── Admin (Sparks operator provisioning) ─────────────── */
export const adminCreateCustomerInput = z.object({
  customerEmail: z.string().email(),
  customerName: z.string().min(1).max(255),
  organizationName: z.string().min(1).max(255),
});

/* ─────────────── Org ─────────────── */
export const orgCreateInput = z.object({
  name: z.string().min(1).max(255),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .min(1)
    .max(50)
    .optional(),
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
  role: z.enum(["owner", "member"]).default("member"),
});

export const orgRemoveMemberInput = z.object({
  organizationId: z.string(),
  userId: z.string(),
});

export const orgAccessOverviewInput = z.object({
  organizationId: z.string(),
});

export const orgSetMemberRoleInput = z.object({
  organizationId: z.string(),
  userId: z.string(),
  role: z.enum(["owner", "member"]),
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
  demandIntervalMinutes: z
    .union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)])
    .default(30),
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
  demandIntervalMinutes: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)]),
});

export const sitesDeleteInput = z.object({
  siteId: z.string().uuid(),
});

/* ─────────────── Site Access ─────────────── */
export const siteAccessListInput = z.object({
  siteId: z.string().uuid(),
});

export const siteLevel = z.enum(["viewer", "editor", "site_admin"]);

export const siteAccessGrantInput = z.object({
  siteId: z.string().uuid(),
  userId: z.string(),
  role: siteLevel,
});

export const siteAccessRevokeInput = z.object({
  siteId: z.string().uuid(),
  userId: z.string(),
});

/* ─────────────── Site Invitations (Slice 4) ─────────────── */
export const siteInvitesCreateInput = z.object({
  siteId: z.string().uuid(),
  email: z.string().email(),
  role: siteLevel.default("viewer"),
});

export const siteInvitesListInput = z.object({
  siteId: z.string().uuid(),
});

export const siteInvitesCancelInput = z.object({
  inviteId: z.string().uuid(),
});

export const siteInvitesAcceptInput = z.object({
  token: z.string().min(1),
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
  anchorTimeOfDay: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default("00:00"),
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
  blockThresholdKwh: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/)
    .optional(),
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

export const reconciliationGeneratePdfInput = z.object({
  reconId: z.string().uuid(),
});

export const reportGetPdfInput = z.object({
  reconId: z.string().uuid(),
});

/* ─────────────── Invoices ─────────────── */
export const invoicesCreateUploadInput = z.object({
  siteId: z.string().uuid(),
  billingPeriodId: z.string().uuid(),
});

export const invoicesUploadAndParseInput = z.object({
  siteId: z.string().uuid(),
  filename: z.string().max(255).optional(),
  // The PDF bytes, base64-encoded (the web file input reads the file client-side).
  // The billing period is read FROM the invoice by the parser, not chosen here.
  contentBase64: z.string().min(1),
});

// Correct the invoice's billing period (dates read from the invoice, editable in
// review). Dates are the inclusive printed dates; the server stores a half-open
// period internally.
export const invoicesSetPeriodInput = z.object({
  invoiceId: z.string().uuid(),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
});

export const invoicesGetInput = z.object({
  invoiceId: z.string().uuid(),
});

export const invoicesListInput = z.object({
  siteId: z.string().uuid(),
  limit: z.number().int().positive().default(50).optional(),
  offset: z.number().int().nonnegative().default(0).optional(),
});

export const invoicesListLineItemsInput = z.object({
  invoiceId: z.string().uuid(),
});

export const invoicesUpdateLineItemInput = z.object({
  lineItemId: z.string().uuid(),
  confirmedCategory: z.enum([
    "active",
    "demand",
    "reactive",
    "fixed",
    "vat",
    "add_on_metering",
    "add_on_admin",
    "add_on_vending",
    "other",
  ]),
  confirmedValueCents: z.number().int().nonnegative(),
});

export const invoicesConfirmInput = z.object({
  invoiceId: z.string().uuid(),
  confirmedActiveCents: z.number().int().nonnegative().nullable(),
  confirmedDemandCents: z.number().int().nonnegative().nullable(),
  confirmedReactiveCents: z.number().int().nonnegative().nullable(),
  confirmedFixedCents: z.number().int().nonnegative().nullable(),
  confirmedTotalCents: z.number().int().nonnegative(),
});

export const invoicesLockInput = z.object({
  invoiceId: z.string().uuid(),
});

// One-click confirm & reconcile: the human-authoritative grouping for every line
// (editable in review). valueCents may be negative (credits/adjustments).
export const invoicesConfirmReconcileInput = z.object({
  invoiceId: z.string().uuid(),
  lines: z
    .array(
      z.object({
        lineItemId: z.string().uuid(),
        utility: z.string().min(1).max(40),
        supplyGroup: z.string().min(1).max(40),
        component: z.string().min(1).max(40),
        valueCents: z.number().int(),
      }),
    )
    .min(1),
});

export const invoicesRequestReviewInput = z.object({
  invoiceId: z.string().uuid(),
  note: z.string().max(2000).optional(),
});

export const invoicesReopenInput = z.object({
  invoiceId: z.string().uuid(),
});

export const invoicesRetryParseInput = z.object({
  invoiceId: z.string().uuid(),
});

// Operator review outcome: the operator's written description document, delivered
// to the customer's inbox + email (+ SMS nudge). status verifies (unlocks the
// sealed PDF) or flags. Optional PDF attachment (base64) — the "description doc".
export const adminReviewReconciliationInput = z.object({
  reconId: z.string().uuid(),
  status: z.enum(["reviewed", "flagged"]),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(8000),
  attachmentBase64: z.string().optional(),
  attachmentName: z.string().max(200).optional(),
});

export const alertsAcknowledgeInput = z.object({
  deliveryId: z.string().uuid(),
});

// Operator-managed reference tariff schedules (Eskom/municipal published prices).
export const tariffSchedulesCreateInput = z.object({
  name: z.string().min(1).max(200),
  provider: z.string().min(1).max(120),
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().optional(),
  filename: z.string().max(300),
  contentBase64: z.string().min(1),
});

export const tariffSchedulesDeleteInput = z.object({
  scheduleId: z.string().uuid(),
});

export const alertsAttachmentUrlInput = z.object({
  alertId: z.string().uuid(),
});

export const profileSetPhoneInput = z.object({
  // Allow empty to clear. Loose validation — real numbers vary by format.
  phone: z.string().max(32),
});

/* ─────────────── Session ─────────────── */
export const sessionCreateOrganizationInput = z.object({
  name: z.string().min(1).max(255),
});

/* ─────────────── Readings / Dashboard ─────────────── */
export const readingsLatestInput = z.object({
  siteId: z.string().uuid(),
});

export const readingsMonthToDateInput = z.object({
  siteId: z.string().uuid(),
  // Optional reference instant; defaults to server "now". Used to derive the
  // start-of-month boundary for the month-to-date window.
  asOf: z.coerce.date().optional(),
});

// Total active energy (kWh) bucketed per billing period, for the "energy across
// billing periods" bar chart. When the site has real billing periods we bucket by
// those; otherwise we fall back to calendar months (the response says which).
export const readingsEnergyByPeriodInput = z.object({
  siteId: z.string().uuid(),
  // How many trailing buckets to return at most (newest kept). Defaults to 12.
  limit: z.number().int().positive().max(36).optional(),
});

// Time-series demand intervals for charting a site's load over a window (docs/02 §4.1
// `demand.listIntervals`). Read-only. Defaults to the last 24h when no window is given.
export const demandListIntervalsInput = z.object({
  siteId: z.string().uuid(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
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
    }),
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
export type SitesSetDefaultDemandIntervalInput = z.infer<typeof sitesSetDefaultDemandIntervalInput>;
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
export type ReconciliationGeneratePdfInput = z.infer<typeof reconciliationGeneratePdfInput>;
export type ReportGetPdfInput = z.infer<typeof reportGetPdfInput>;
export type InvoicesUploadAndParseInput = z.infer<typeof invoicesUploadAndParseInput>;
export type InvoicesSetPeriodInput = z.infer<typeof invoicesSetPeriodInput>;

export type InvoicesCreateUploadInput = z.infer<typeof invoicesCreateUploadInput>;
export type InvoicesGetInput = z.infer<typeof invoicesGetInput>;
export type InvoicesListInput = z.infer<typeof invoicesListInput>;
export type InvoicesListLineItemsInput = z.infer<typeof invoicesListLineItemsInput>;
export type InvoicesUpdateLineItemInput = z.infer<typeof invoicesUpdateLineItemInput>;
export type InvoicesConfirmInput = z.infer<typeof invoicesConfirmInput>;
export type InvoicesLockInput = z.infer<typeof invoicesLockInput>;

export type ReadingsLatestInput = z.infer<typeof readingsLatestInput>;
export type ReadingsMonthToDateInput = z.infer<typeof readingsMonthToDateInput>;
export type ReadingsEnergyByPeriodInput = z.infer<typeof readingsEnergyByPeriodInput>;
export type DemandListIntervalsInput = z.infer<typeof demandListIntervalsInput>;
