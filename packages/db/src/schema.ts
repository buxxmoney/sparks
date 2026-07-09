import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ─────────────── Better-Auth Tables ─────────────── */
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: boolean("emailVerified"),
  image: text("image"),
  createdAt: timestamp("createdAt").defaultNow(),
  updatedAt: timestamp("updatedAt").defaultNow(),
  // Platform-operator (internal cross-tenant admin) flag. Declared to better-auth
  // as an additionalField (see apps/server/src/auth.ts); gates requirePlatformOperator.
  isPlatformOperator: boolean("is_platform_operator").notNull().default(false),
  // Optional mobile number for the SMS outcome nudge (set at set-password + Settings).
  phone: text("phone"),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expiresAt").notNull(),
  token: text("token").unique().notNull(),
  createdAt: timestamp("createdAt").defaultNow(),
  updatedAt: timestamp("updatedAt").defaultNow(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  expiresAt: timestamp("expiresAt"),
  password: text("password"),
  createdAt: timestamp("createdAt").defaultNow(),
  updatedAt: timestamp("updatedAt").defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow(),
  updatedAt: timestamp("updatedAt").defaultNow(),
});

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug"),
  logo: text("logo"),
  createdAt: timestamp("createdAt").defaultNow(),
  metadata: jsonb("metadata"),
});

export const member = pgTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organizationId")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  createdAt: timestamp("createdAt").defaultNow(),
});

export const invitation = pgTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organizationId")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  invitedBy: text("invitedBy")
    .notNull()
    .references(() => user.id),
  createdAt: timestamp("createdAt").defaultNow(),
});

/* ─────────────── Type stubs for reference ─────────────── */
export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;

/* ─────────────── Enums ─────────────── */
export const siteRole = pgEnum("site_role", ["owner", "site_manager"]);
export const siteInviteStatus = pgEnum("site_invite_status", ["pending", "accepted", "cancelled"]);
export const billingRecurrence = pgEnum("billing_recurrence", [
  "calendar_month",
  "day_of_month",
  "n_monthly",
  "weekly",
  "fiscal",
  "meter_read",
  "manual",
]);
export const shortMonthPolicy = pgEnum("short_month_policy", [
  "clamp_last_day",
  "skip",
  "rollover",
]);
export const boundaryInclusivity = pgEnum("boundary_inclusivity", [
  "half_open",
  "inclusive",
  "half_open_end",
]);
export const billingPeriodSource = pgEnum("billing_period_source", [
  "generated",
  "manual",
  "meter_read",
  "invoice_derived",
]);
export const billingPeriodStatus = pgEnum("billing_period_status", ["open", "closed"]);
export const connectivityMode = pgEnum("connectivity_mode", ["lte", "wifi"]);
export const deviceStatus = pgEnum("device_status", [
  "provisioning",
  "online",
  "offline",
  "degraded",
]);
export const upsStatus = pgEnum("ups_status", [
  "on_mains",
  "charging",
  "on_battery",
  "degraded",
  "unknown",
]);
export const readingSource = pgEnum("reading_source", ["live", "backfill_register", "manual"]);
export const tariffType = pgEnum("tariff_type", ["landlord_stated", "legal_ceiling"]);
export const tariffSource = pgEnum("tariff_source", ["library", "custom"]);
export const chargeType = pgEnum("charge_type", [
  "active_energy",
  "demand",
  "reactive_energy",
  "fixed",
  "ancillary",
]);
export const rateUnit = pgEnum("rate_unit", [
  "c_per_kwh",
  "r_per_kva",
  "c_per_kvarh",
  "r_per_day",
  "r_per_month",
]);
export const touPeriod = pgEnum("tou_period", ["peak", "standard", "offpeak", "all"]);
export const season = pgEnum("season", ["high", "low", "all"]);
export const siteTariffRole = pgEnum("site_tariff_role", ["landlord", "legal_ceiling"]);
export const invoiceStatus = pgEnum("invoice_status", [
  "uploaded",
  "parsing",
  "parsed_pending_confirm",
  "confirmed",
  "locked",
]);
export const lineCategory = pgEnum("line_category", [
  "active",
  "demand",
  "reactive",
  "fixed",
  "vat",
  "add_on_metering",
  "add_on_admin",
  "add_on_vending",
  "other",
]);
export const reconStatus = pgEnum("recon_status", ["draft", "final"]);
export const integrityStatus = pgEnum("integrity_status", ["clean", "gaps_present"]);
export const alertType = pgEnum("alert_type", [
  "device_offline",
  "sim_down",
  "data_gap",
  "ups_degraded",
  "power_restored",
  "demand_spike",
  "invoice_ready",
  "invoice_parsed",
]);
export const alertSeverity = pgEnum("alert_severity", ["info", "warning", "critical"]);
export const alertStatus = pgEnum("alert_status", ["open", "acknowledged", "resolved"]);
export const deliveryChannel = pgEnum("delivery_channel", ["app", "email", "sms"]);
export const deliveryStatus = pgEnum("delivery_status", ["pending", "sent", "failed"]);

/* ─────────────── Sites & access ─────────────── */
export const sites = pgTable(
  "sites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    addressLine1: text("address_line1"),
    city: text("city"),
    province: text("province"),
    supplyZone: text("supply_zone"),
    timezone: text("timezone").notNull().default("Africa/Johannesburg"),
    demandIntervalMinutes: integer("demand_interval_minutes").notNull().default(30),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("sites_org_idx").on(t.organizationId),
  }),
);

export const siteAccess = pgTable(
  "site_access",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, {
        onDelete: "cascade",
      }),
    userId: text("user_id").notNull(),
    // Per-site level: viewer | editor | site_admin (see middleware.normalizeSiteLevel).
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex("site_access_uq").on(t.siteId, t.userId),
  }),
);

/* Site-scoped invitations (Slice 4): an org-owner invites someone by email to a
   specific site. On accept the invitee becomes an org member (non-owner) and gets
   a site_access grant for that site. */
export const siteInvitations = pgTable(
  "site_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    email: text("email").notNull(),
    // Per-site level: viewer | editor | site_admin (see middleware.normalizeSiteLevel).
    role: text("role").notNull().default("viewer"),
    token: text("token").notNull().unique(),
    invitedByUserId: text("invited_by_user_id").notNull(),
    status: siteInviteStatus("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: text("accepted_by_user_id"),
  },
  (t) => ({
    siteIdx: index("site_invitations_site_idx").on(t.siteId, t.status),
  }),
);

/* ─────────────── Billing cycle: policy (rule) + materialized periods ─────────────── */
export const billingCyclePolicies = pgTable(
  "billing_cycle_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, {
        onDelete: "cascade",
      }),
    recurrence: billingRecurrence("recurrence").notNull().default("calendar_month"),
    anchorDay: integer("anchor_day"),
    shortMonthPolicy: shortMonthPolicy("short_month_policy").notNull().default("clamp_last_day"),
    intervalCount: integer("interval_count").notNull().default(1),
    anchorDate: timestamp("anchor_date", { withTimezone: true }),
    fiscalPattern: text("fiscal_pattern").default("4-4-5"),
    leapWeekPlacement: text("leap_week_placement").default("last"),
    anchorTimeOfDay: text("anchor_time_of_day").notNull().default("00:00"),
    boundaryInclusivity: boundaryInclusivity("boundary_inclusivity").notNull().default("half_open"),
    snapToDemandGrid: boolean("snap_to_demand_grid").notNull().default(true),
    version: integer("version").notNull().default(1),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    siteIdx: index("billing_policy_site_idx").on(t.siteId, t.effectiveFrom),
  }),
);

export const billingPeriods = pgTable(
  "billing_periods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, {
        onDelete: "cascade",
      }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    boundaryInclusivity: boundaryInclusivity("boundary_inclusivity").notNull().default("half_open"),
    demandIntervalMinutes: integer("demand_interval_minutes").notNull(),
    label: text("label"),
    source: billingPeriodSource("source").notNull().default("generated"),
    policyId: uuid("policy_id").references(() => billingCyclePolicies.id),
    status: billingPeriodStatus("status").notNull().default("open"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex("billing_period_uq").on(t.siteId, t.periodStart),
  }),
);

/* ─────────────── Devices & meters ─────────────── */
export const devices = pgTable(
  "devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id").references(() => sites.id, {
      onDelete: "set null",
    }),
    serialNumber: text("serial_number").notNull().unique(),
    hardwareModel: text("hardware_model").notNull().default("rpi"),
    simIccid: text("sim_iccid"),
    simMsisdn: text("sim_msisdn"),
    simProvider: text("sim_provider"),
    connectivityMode: connectivityMode("connectivity_mode").notNull().default("lte"),
    firmwareVersion: text("firmware_version"),
    apiKeyHash: text("api_key_hash").notNull(),
    status: deviceStatus("status").notNull().default("provisioning"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    upsStatus: upsStatus("ups_status").notNull().default("unknown"),
    upsBatteryPct: integer("ups_battery_pct"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    siteIdx: index("devices_site_idx").on(t.siteId),
  }),
);

export const meters = pgTable(
  "meters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, {
        onDelete: "cascade",
      }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, {
        onDelete: "cascade",
      }),
    serialNumber: text("serial_number").notNull(),
    model: text("model").notNull().default("SDM630MCT"),
    midCertifiedVariant: boolean("mid_certified_variant").notNull().default(true),
    midCertificateRef: text("mid_certificate_ref"),
    ctRatioPrimary: integer("ct_ratio_primary"),
    ctRatioSecondary: integer("ct_ratio_secondary").default(5),
    phaseConfig: text("phase_config").default("3P4W"),
    installedByName: text("installed_by_name"),
    installerRegistration: text("installer_registration"),
    installedAt: timestamp("installed_at", { withTimezone: true }),
    commissionedAt: timestamp("commissioned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    deviceIdx: index("meters_device_idx").on(t.deviceId),
  }),
);

/* ─────────────── Time-series: readings (PARTITIONED) ─────────────── */
export const readings = pgTable(
  "readings",
  {
    meterId: uuid("meter_id")
      .notNull()
      .references(() => meters.id, {
        onDelete: "cascade",
      }),
    time: timestamp("time", { withTimezone: true }).notNull(),
    seq: bigint("seq", { mode: "number" }),
    activeEnergyKwh: numeric("active_energy_kwh", {
      precision: 14,
      scale: 3,
    }),
    reactiveEnergyKvarh: numeric("reactive_energy_kvarh", {
      precision: 14,
      scale: 3,
    }),
    apparentEnergyKvah: numeric("apparent_energy_kvah", {
      precision: 14,
      scale: 3,
    }),
    totalPowerKw: numeric("total_power_kw", { precision: 12, scale: 3 }),
    totalApparentKva: numeric("total_apparent_kva", {
      precision: 12,
      scale: 3,
    }),
    powerFactor: numeric("power_factor", { precision: 5, scale: 4 }),
    source: readingSource("source").notNull().default("live"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.meterId, t.time] }),
    timeIdx: index("readings_time_idx").on(t.time),
  }),
);

/* ─────────────── Aggregated demand intervals ─────────────── */
export const demandIntervals = pgTable(
  "demand_intervals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    meterId: uuid("meter_id")
      .notNull()
      .references(() => meters.id, {
        onDelete: "cascade",
      }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, {
        onDelete: "cascade",
      }),
    intervalStart: timestamp("interval_start", {
      withTimezone: true,
    }).notNull(),
    intervalMinutes: integer("interval_minutes").notNull(),
    activeEnergyKwh: numeric("active_energy_kwh", {
      precision: 12,
      scale: 3,
    }),
    reactiveEnergyKvarh: numeric("reactive_energy_kvarh", {
      precision: 12,
      scale: 3,
    }),
    avgDemandKw: numeric("avg_demand_kw", { precision: 12, scale: 3 }),
    avgDemandKva: numeric("avg_demand_kva", { precision: 12, scale: 3 }),
    avgPowerFactor: numeric("avg_power_factor", { precision: 5, scale: 4 }),
    sampleCount: integer("sample_count").notNull().default(0),
    expectedSamples: integer("expected_samples").notNull(),
    isComplete: boolean("is_complete").notNull().default(false),
    source: readingSource("source").notNull().default("live"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex("demand_interval_uq").on(t.meterId, t.intervalStart, t.intervalMinutes),
    siteTimeIdx: index("demand_site_time_idx").on(t.siteId, t.intervalStart),
  }),
);

/* ─────────────── Data gaps ─────────────── */
export const dataGaps = pgTable(
  "data_gaps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    meterId: uuid("meter_id")
      .notNull()
      .references(() => meters.id, {
        onDelete: "cascade",
      }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, {
        onDelete: "cascade",
      }),
    gapStart: timestamp("gap_start", { withTimezone: true }).notNull(),
    gapEnd: timestamp("gap_end", { withTimezone: true }).notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    backfilled: boolean("backfilled").notNull().default(false),
    backfillSource: text("backfill_source"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    siteIdx: index("data_gaps_site_idx").on(t.siteId, t.gapStart),
    uniqueGap: uniqueIndex("data_gaps_unique_gap").on(t.meterId, t.gapStart, t.gapEnd),
  }),
);

/* ─────────────── Tariffs ─────────────── */
export const tariffProfiles = pgTable(
  "tariff_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id"),
    name: text("name").notNull(),
    type: tariffType("type").notNull(),
    source: tariffSource("source").notNull(),
    supplyZone: text("supply_zone"),
    distributor: text("distributor"),
    currency: text("currency").notNull().default("ZAR"),
    touSchedule: jsonb("tou_schedule"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    validatedByAttorney: boolean("validated_by_attorney").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    libIdx: index("tariff_lib_idx").on(t.type, t.supplyZone),
  }),
);

export const tariffRates = pgTable(
  "tariff_rates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tariffProfileId: uuid("tariff_profile_id")
      .notNull()
      .references(() => tariffProfiles.id, { onDelete: "cascade" }),
    chargeType: chargeType("charge_type").notNull(),
    unit: rateUnit("unit").notNull(),
    rateValue: numeric("rate_value", { precision: 14, scale: 6 }).notNull(),
    season: season("season").notNull().default("all"),
    touPeriod: touPeriod("tou_period").notNull().default("all"),
    blockThresholdKwh: numeric("block_threshold_kwh", {
      precision: 12,
      scale: 2,
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    profIdx: index("tariff_rates_profile_idx").on(t.tariffProfileId),
  }),
);

export const siteTariffAssignments = pgTable(
  "site_tariff_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, {
        onDelete: "cascade",
      }),
    tariffProfileId: uuid("tariff_profile_id")
      .notNull()
      .references(() => tariffProfiles.id),
    role: siteTariffRole("role").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
  },
  (t) => ({
    siteIdx: index("site_tariff_idx").on(t.siteId, t.role),
  }),
);

/* ─────────────── Invoices ─────────────── */
export const landlordInvoices = pgTable(
  "landlord_invoices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, {
        onDelete: "cascade",
      }),
    billingPeriodId: uuid("billing_period_id").references(() => billingPeriods.id),
    billingPeriodStart: timestamp("billing_period_start", {
      withTimezone: true,
    }).notNull(),
    billingPeriodEnd: timestamp("billing_period_end", {
      withTimezone: true,
    }).notNull(),
    fileStorageKey: text("file_storage_key").notNull(),
    fileHash: text("file_hash").notNull(),
    status: invoiceStatus("status").notNull().default("uploaded"),
    parseModel: text("parse_model"),
    parsedRaw: jsonb("parsed_raw"),
    // Set when async parsing fails, so the review screen can show why and offer a
    // retry. Null while parsing/queued and once parsing has succeeded.
    parseError: text("parse_error"),
    confirmedActiveCents: integer("confirmed_active_cents"),
    confirmedDemandCents: integer("confirmed_demand_cents"),
    confirmedReactiveCents: integer("confirmed_reactive_cents"),
    confirmedFixedCents: integer("confirmed_fixed_cents"),
    confirmedTotalCents: integer("confirmed_total_cents"),
    uploadedByUserId: text("uploaded_by_user_id"),
    confirmedByUserId: text("confirmed_by_user_id"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    // Set when the customer explicitly clicks "Send to Sparks for review".
    reviewRequestedAt: timestamp("review_requested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    siteIdx: index("invoices_site_idx").on(t.siteId, t.billingPeriodStart),
  }),
);

export const invoiceLineItems = pgTable(
  "invoice_line_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => landlordInvoices.id, { onDelete: "cascade" }),
    rawLabel: text("raw_label").notNull(),
    parsedCategory: lineCategory("parsed_category").notNull(),
    parsedValueCents: integer("parsed_value_cents"),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    confirmedCategory: lineCategory("confirmed_category"),
    confirmedValueCents: integer("confirmed_value_cents"),
    // Human-confirmed grouping (editable in review) — the parser's utility/
    // supply_group/component are a suggestion; these override for reconciliation.
    confirmedUtility: text("confirmed_utility"),
    confirmedSupplyGroup: text("confirmed_supply_group"),
    confirmedComponent: text("confirmed_component"),
    isImpermissibleAddOn: boolean("is_impermissible_add_on").notNull().default(false),
    // Canonical grouping (Slice: grouped parsing) — utility + supply group + the
    // physical unit/quantity/rate the line was billed on. `component` is derived
    // from the unit (kWh→active_energy, kVA→demand, …) so grouping survives any
    // landlord's invoice format.
    utility: text("utility"),
    supplyGroup: text("supply_group"),
    unit: text("unit"),
    quantity: numeric("quantity", { precision: 14, scale: 4 }),
    rate: numeric("rate", { precision: 14, scale: 6 }),
    component: text("component"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    invIdx: index("line_items_invoice_idx").on(t.invoiceId),
  }),
);

/* ─────────────── Reconciliation / report ─────────────── */
export const reconciliations = pgTable(
  "reconciliations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, {
        onDelete: "cascade",
      }),
    invoiceId: uuid("invoice_id").references(() => landlordInvoices.id),
    billingPeriodId: uuid("billing_period_id").references(() => billingPeriods.id),
    billingPeriodStart: timestamp("billing_period_start", {
      withTimezone: true,
    }).notNull(),
    billingPeriodEnd: timestamp("billing_period_end", {
      withTimezone: true,
    }).notNull(),
    boundaryInclusivity: boundaryInclusivity("boundary_inclusivity").notNull().default("half_open"),
    demandIntervalMinutes: integer("demand_interval_minutes").notNull(),
    landlordTariffProfileId: uuid("landlord_tariff_profile_id").references(() => tariffProfiles.id),
    legalCeilingTariffProfileId: uuid("legal_ceiling_tariff_profile_id").references(
      () => tariffProfiles.id,
    ),
    measuredActiveKwh: numeric("measured_active_kwh", {
      precision: 14,
      scale: 3,
    }),
    measuredMaxDemandKva: numeric("measured_max_demand_kva", {
      precision: 12,
      scale: 3,
    }),
    measuredReactiveKvarh: numeric("measured_reactive_kvarh", {
      precision: 14,
      scale: 3,
    }),
    expectedLandlordCents: integer("expected_landlord_cents"),
    expectedCeilingCents: integer("expected_ceiling_cents"),
    chargedTotalCents: integer("charged_total_cents"),
    discrepancyVsLandlordCents: integer("discrepancy_vs_landlord_cents"),
    discrepancyVsCeilingCents: integer("discrepancy_vs_ceiling_cents"),
    dataIntegrityStatus: integrityStatus("data_integrity_status").notNull().default("clean"),
    gapCount: integer("gap_count").notNull().default(0),
    gapMinutesTotal: integer("gap_minutes_total").notNull().default(0),
    breakdown: jsonb("breakdown"),
    status: reconStatus("status").notNull().default("draft"),
    // Sparks QA workflow. A newly generated recon is 'provisional' — the customer
    // sees the numbers immediately but the sealed dispute PDF only unlocks once an
    // operator signs it off ('reviewed'); 'flagged' means QA found a problem.
    reviewStatus: text("review_status").notNull().default("provisional"),
    reviewedByUserId: text("reviewed_by_user_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    version: integer("version").notNull().default(1),
    pdfStorageKey: text("pdf_storage_key"),
    pdfHash: text("pdf_hash"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    siteIdx: index("recon_site_idx").on(t.siteId, t.billingPeriodStart),
  }),
);

/* ─────────────── Alerts / events + delivery ─────────────── */
export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id"),
    siteId: uuid("site_id").references(() => sites.id, {
      onDelete: "cascade",
    }),
    deviceId: uuid("device_id").references(() => devices.id, {
      onDelete: "cascade",
    }),
    type: alertType("type").notNull(),
    severity: alertSeverity("severity").notNull().default("warning"),
    title: text("title").notNull(),
    message: text("message"),
    payload: jsonb("payload"),
    status: alertStatus("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    orgIdx: index("alerts_org_idx").on(t.organizationId, t.status),
  }),
);

export const alertDeliveries = pgTable(
  "alert_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => alerts.id, {
        onDelete: "cascade",
      }),
    channel: deliveryChannel("channel").notNull(),
    recipientUserId: text("recipient_user_id"),
    status: deliveryStatus("status").notNull().default("pending"),
    providerRef: text("provider_ref"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    // Per-recipient read state for the in-app inbox (app-channel rows only).
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => ({
    alertIdx: index("alert_deliv_idx").on(t.alertId),
  }),
);

/* ─────────────── Device health (fleet) + audit ─────────────── */
export const deviceHealthSamples = pgTable(
  "device_health_samples",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, {
        onDelete: "cascade",
      }),
    time: timestamp("time", { withTimezone: true }).notNull(),
    connectivityMode: connectivityMode("connectivity_mode"),
    signalRssi: integer("signal_rssi"),
    upsStatus: upsStatus("ups_status"),
    batteryPct: integer("battery_pct"),
    cpuTempC: numeric("cpu_temp_c", { precision: 5, scale: 2 }),
    bufferedRecords: integer("buffered_records"),
  },
  (t) => ({
    devTimeIdx: index("dev_health_idx").on(t.deviceId, t.time),
  }),
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    diff: jsonb("diff"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entIdx: index("audit_entity_idx").on(t.entityType, t.entityId),
  }),
);

/* ─────────────── Type exports ─────────────── */
export type Site = typeof sites.$inferSelect;
export type NewSite = typeof sites.$inferInsert;

export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;

export type Meter = typeof meters.$inferSelect;
export type NewMeter = typeof meters.$inferInsert;

export type Reading = typeof readings.$inferSelect;
export type NewReading = typeof readings.$inferInsert;

export type DemandInterval = typeof demandIntervals.$inferSelect;
export type NewDemandInterval = typeof demandIntervals.$inferInsert;

export type BillingPeriod = typeof billingPeriods.$inferSelect;
export type NewBillingPeriod = typeof billingPeriods.$inferInsert;

export type BillingCyclePolicy = typeof billingCyclePolicies.$inferSelect;
export type NewBillingCyclePolicy = typeof billingCyclePolicies.$inferInsert;

export type TariffProfile = typeof tariffProfiles.$inferSelect;
export type NewTariffProfile = typeof tariffProfiles.$inferInsert;

export type TariffRate = typeof tariffRates.$inferSelect;
export type NewTariffRate = typeof tariffRates.$inferInsert;

export type LandlordInvoice = typeof landlordInvoices.$inferSelect;
export type NewLandlordInvoice = typeof landlordInvoices.$inferInsert;

export type Reconciliation = typeof reconciliations.$inferSelect;
export type NewReconciliation = typeof reconciliations.$inferInsert;

export type Alert = typeof alerts.$inferSelect;
export type NewAlert = typeof alerts.$inferInsert;
