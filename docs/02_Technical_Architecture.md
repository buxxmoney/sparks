# 02 — Technical Architecture (Sparks)

**Status:** Draft for build sign-off · **Owner:** Technical Analyst / Solutions Architect
**Inputs:** `01_Product_Definition.md` (approved Business Handover Pack)
**Scope:** End-to-end architecture, concrete tech stack, Drizzle schema, API/routing map, risks, phased plan, open questions.

> Business requirements from Phase 1 are treated as **fixed**. Where a genuine technical contradiction with the mandated stack exists it is flagged inline as **⚠ CONTRADICTION**. Where the spec is silent, an industry-standard default is chosen and stated as **[DEFAULT]**.

---

## 0. Tech Stack Confirmation

The application layer is the mandated `better-t-stack` monorepo:

```
bun create better-t-stack@latest sparks \
  --frontend next --backend hono --runtime bun --api orpc \
  --auth better-auth --payments none --database postgres \
  --orm drizzle --db-setup neon --package-manager bun \
  --addons biome fumadocs skills turborepo ultracite
```

| Layer | Choice | Role in Sparks |
|---|---|---|
| Runtime | **Bun** | Backend + tooling runtime |
| Monorepo | **Turborepo** | `apps/web`, `apps/server`, `packages/*`, plus `apps/edge` (Python, non-Bun) and `apps/mobile` (Expo) added later |
| Frontend | **Next.js** (App Router) | Web app for Owner / Site Manager / Operator |
| Backend | **Hono** on Bun | HTTP server: mounts oRPC, better-auth, device ingestion, webhooks |
| API | **oRPC** | Type-safe app↔server contract (browser + mobile) |
| Auth | **better-auth** | Identity, sessions, **organization plugin** for multi-tenant orgs + membership |
| DB | **Postgres on Neon** | Single source of truth incl. time-series (see ⚠ below) |
| ORM | **Drizzle** | Schema + migrations |
| Quality | **Biome + Ultracite** | Lint/format gates |
| Docs | **Fumadocs** | Internal + install/runbook docs |

**⚠ CONTRADICTION — Time-series on Neon.** The Phase-1 spec implies a time-series workload (1-minute readings per meter, indefinitely). Neon is **vanilla Postgres and does not offer the TimescaleDB extension.** We therefore do **not** assume a hypertable. Decision: use **native declarative range partitioning** on the `readings` table (monthly partitions) with **BRIN** indexes on `time`. This scales comfortably to the fleet sizes in the business plan (hundreds → low thousands of meters × 1,440 readings/day). If the fleet outgrows this, migrate `readings` to a dedicated TSDB (Timescale Cloud / ClickHouse) behind the same ingestion contract — **no app-layer change required.** Captured as Open Question Q1.

---

## 1. System Architecture

### 1.1 Component diagram (description)

```
┌──────────────────────────── SITE (tenant DB board) ────────────────────────────┐
│                                                                                  │
│  Mains ─▶ DIN AC/DC PSU (5V) ─▶ Li-ion UPS HAT ─▶ Raspberry Pi (edge agent)      │
│                                         │                                        │
│  SDM630MCT (MID) ──RS485 / Modbus RTU───┘   [USB-RS485 adapter]                  │
│      │  CTs on phases                                                            │
│      ▼                                                                           │
│  Edge Agent (Python, systemd):                                                   │
│   • poll registers @ 1-min  • local SQLite buffer (store-and-forward)            │
│   • HMAC-signed batch POST   • health heartbeat  • config pull  • watchdog       │
│                                         │                                        │
│         LTE modem (default) ──┬── Wi-Fi (fallback)                               │
└─────────────────────────────┼───────────────────────────────────────────────────┘
                              │  HTTPS (TLS)
                              ▼
┌──────────────────────────── CLOUD (Hono on Bun / Neon) ──────────────────────────┐
│                                                                                   │
│  Ingestion API (Hono routes, device-auth)                                         │
│    POST /ingest/readings   POST /ingest/health   GET /device/config/:id           │
│        │                                                                          │
│        ▼                                                                          │
│  Postgres (Neon):  readings (partitioned) ─▶ [Aggregation worker] ─▶ demand_intervals
│        │                                            │                             │
│        ├─▶ data_gap detector                        └─▶ reconciliations           │
│        │                                                                          │
│  App API (oRPC over Hono)  ◀────────────  Next.js web  +  Expo mobile (iOS/Android)│
│  Auth (better-auth + org plugin)                                                  │
│  Services:  Tariff library │ Reconciliation engine │ LLM invoice parser (confirm) │
│             PDF report gen │ Notification service (app/email/SMS)                 │
│             Fleet-health dashboard (operator)                                     │
│                                                                                   │
│  External: Object store (R2/S3) │ LLM API (Claude) │ Email (Resend) │ SMS (Clickatell)
│            SIM mgmt API (MNO/MVNO)                                                 │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Data flow: 1-min reading → clock-aligned 15/30-min demand

1. **Poll (edge, every 60s).** The agent reads SDM630MCT **input registers** (float32) over Modbus RTU: cumulative `kWh` (import active energy), cumulative `kVArh` (reactive), total power `kW`, total apparent power `kVA`, and power factor. It stamps `time` in **UTC** and a monotonic `seq` counter.
2. **Buffer.** Each sample is written to local **SQLite** first (durability), then queued for upload. On connectivity loss the queue grows; on reconnect it drains oldest-first. `seq` lets the server detect drops.
3. **Ingest.** Agent POSTs a batch (JSON, gzip) to `POST /ingest/readings` with an HMAC signature over the body + device key. Server validates, upserts into `readings` (idempotent on `(meter_id, time)`), and ACKs the highest accepted `seq` so the edge can purge its buffer.
4. **Aggregate (server, clock-aligned).** A worker computes `demand_intervals` keyed to **wall-clock boundaries in the site's billing timezone** (`Africa/Johannesburg`) at the site's configured `demand_interval_minutes` (15 or 30). Interval demand is derived from **energy deltas**, which is the metrologically correct definition and robust to a missing minute:
   - `avg_demand_kw = (kWh_end − kWh_start) / (interval_hours)`
   - `avg_demand_kva` from apparent-energy delta (or `√(kWh² + kVArh²)` deltas if the apparent register is unused).
   - `sample_count` = 1-min readings present in the interval; `expected = interval_minutes`; `is_complete = sample_count == expected`.
5. **Gap detection.** If `is_complete = false` (or a `seq` discontinuity is seen) a `data_gaps` row is opened. The aggregation flags the interval; the reconciliation later surfaces it as a **dispute-integrity event**. Where the meter's onboard registers can cover the gap, a backfill job reconstructs energy deltas (see Risk R1).
6. **Reconcile (monthly).** The engine reads a concrete `billing_periods` row (authoritative `period_start`/`period_end`, snapshotted `boundary_inclusivity` and `demand_interval_minutes` — see §3.0); it takes measured `active_kWh`, **max** `demand_kVA` (the maximum `avg_demand_kva` across clock-aligned intervals in that period), and `reactive_kVArh`; prices them against the site's **landlord tariff** and **legal-ceiling tariff**; compares to the **confirmed** invoice totals; and emits a versioned, timestamped, hash-sealed **PDF**. It never re-derives period boundaries from a rule.

**Why energy-delta demand (not instantaneous averaging):** it matches how utilities compute maximum demand, tolerates a dropped 1-min sample without biasing the interval, and reconciles exactly against the meter's own registers — critical for dispute-grade evidence.

---

## 2. Technology Stack — recommendations & trade-offs

| Concern | Recommendation | Justification / trade-off |
|---|---|---|
| **Edge software** | **Python 3** on DietPi/Raspberry Pi OS Lite; `pymodbus` (RTU), `SQLite` buffer, `systemd` units + `systemd` watchdog, `requests`/`httpx` sync agent | Python is the norm for Modbus/Pi and keeps the electrician-facing commissioning script simple. **Not** Bun on-device: no mature Modbus story, heavier footprint. Trade-off: a second language, but the edge contract is plain HTTP+JSON so it stays decoupled. |
| **Device transport** | **HTTPS batch POST** for MVP; contract designed so **MQTT** (EMQX) can replace it later | HTTP is trivial over LTE, firewall-friendly, easy to auth (HMAC). MQTT is better at fleet scale/push-config but is premature at MVP volumes. [DEFAULT] |
| **Ingestion/backend** | **Hono on Bun**, device routes separate from oRPC | Devices are Python and shouldn't consume oRPC's TS client; a versioned REST contract (`/ingest/*`) is the right seam. oRPC is reserved for first-party TS clients (web + Expo). |
| **Time-series DB** | **Neon Postgres, `readings` range-partitioned monthly + BRIN**; aggregates in `demand_intervals` | Single DB = simplest ops, transactional joins between readings and billing entities. ⚠ No Timescale on Neon (§0). Trade-off: manual partition management via a scheduled `CREATE TABLE … PARTITION OF`; mitigated by a cron. |
| **Aggregation/jobs** | **Bun worker** triggered by cron (Neon/host scheduler) + on-ingest debounce | Keeps everything in one runtime/repo. Trade-off: no heavy stream processor — fine at this cadence. |
| **LLM invoice parsing** | **Claude (`claude-opus-4-8` for hard invoices / `claude-haiku-4-5` for routine)** via structured tool-use returning a **typed JSON schema**; **always human confirm-before-lock** | Vision+structured output handles messy municipal/centre PDFs. **Never auto-lock** — every parsed line carries a `confidence`; low-confidence fields are visually flagged for the user to confirm/correct. Trade-off: per-invoice API cost, acceptable at monthly cadence. |
| **PDF generation** | **React → HTML → PDF via Playwright/Chromium** (server-side) | Reuses React components + design system for pixel-perfect, auditable reports; Chromium renders complex tables/charts reliably. Alternative `@react-pdf/renderer` is lighter but weaker on layout. Every PDF is content-hashed and stored immutably. |
| **Auth / RBAC** | **better-auth** core + **organization plugin**; org roles `owner`/`operator`; **site-scoped** `site_manager` via `site_access`; **platform operator** via a global `is_platform_operator` flag | Maps cleanly to Owner (org-wide), Site Manager (single site → needs per-site grant, not an org role), and Internal Operator (cross-tenant admin → not an org member). Trade-off: two authorization axes (org membership + site grant) — enforced centrally in an oRPC middleware. |
| **Fleet-health dashboard** | Operator-only **Next.js** area backed by `fleet.*` oRPC procedures over `devices` + `device_health_samples` | Reuses the same app/stack; gated by `is_platform_operator`. Trade-off: co-located with tenant app — acceptable, isolated by RBAC + separate routes. |
| **Object storage** | **Cloudflare R2** (or S3) for invoice PDFs + generated reports | Cheap, S3-compatible; presigned uploads keep large files off the API. |
| **Email / SMS** | **Resend** (email), **Clickatell/BulkSMS** (SA-local SMS) | SA SMS deliverability favours a local aggregator. Multichannel required by spec. |

---

## 3. Data Model (Drizzle ORM — `packages/db/src/schema.ts`)

Design notes:
- **better-auth owns** `user`, `session`, `account`, `verification`, and (org plugin) `organization`, `member`, `invitation`. We add `is_platform_operator` to `user` via better-auth `additionalFields`. Domain tables below reference `organization.id` and `user.id`.
- All money in **integer cents (ZAR)** to avoid float error; all energy/power as `numeric` (exact decimal).
- All timestamps `timestamp with time zone`, stored **UTC**; billing/demand alignment uses the site `timezone`.
- `readings` is **range-partitioned by `time`** — Drizzle defines the table; partitioning is applied via a raw-SQL migration (shown after the table).

### 3.0 Billing-cycle model (malleable by design)

The billing cycle is deliberately **not** a couple of fixed columns on `sites`. It is split into a **recurrence policy** (the rule that *generates* periods) and **materialized `billing_periods`** (the concrete, authoritative start/end that every downstream computation reads). This is the single most important flexibility decision in the schema:

- **All reconciliation math reads `billing_periods.period_start/period_end`** — never re-derives boundaries from a rule at compute time. A concrete period is a plain timestamp range, so *any* cycle a landlord uses is representable.
- **Rule-generated, but always overridable.** `billingCyclePolicies` produces candidate periods; a user (or the meter-read date) can override any single period. Overridden rows are stamped `source = manual | meter_read | invoice_derived` and are never regenerated.
- **History is immutable.** Policies are versioned (`effectiveFrom/To`) and each `billing_periods` row snapshots its `demandIntervalMinutes` and `boundaryInclusivity`. Changing the rule (or the demand interval) next month never rewrites a past period or a sealed report.

Cases this covers without schema change:

| Landlord convention | How it's modelled |
|---|---|
| Calendar month (28/29/30/31) | `recurrence = calendar_month` |
| Fixed day-of-month, e.g. 20th→20th | `recurrence = day_of_month`, `anchorDay = 20` |
| Day-of-month past short months, e.g. "31st" in Feb | `anchorDay = 31` + `shortMonthPolicy = clamp_last_day` (or `skip`/`rollover`) — **no `≤28` restriction** |
| End-of-month billing | `anchorDay = 31` + `clamp_last_day` |
| Bi-monthly / quarterly | `recurrence = n_monthly`, `intervalCount = 2` (or 3) + `anchorDate` to phase it |
| Weekly / fortnightly | `recurrence = weekly`, `intervalCount = 1` or `2`, phased by `anchorDate` |
| Retail fiscal calendar — 4-4-5 / 4-5-4 / 5-4-4, incl. 53-week years | `recurrence = fiscal`, `fiscalPattern` (default `4-4-5`), `anchorDate` = fiscal-year start, `leapWeekPlacement` for the 53rd week |
| Boundary at meter-read time, not midnight | `anchorTimeOfDay = "09:00"` (+ `snapToDemandGrid` to align to the 15/30-min grid) |
| Inclusive `[start,end]` vs half-open `[start,end)` | `boundaryInclusivity` per policy, snapshotted per period |
| Irregular actual read dates (reader drifts a few days) | `recurrence = meter_read` → periods entered from actual reads (`source = meter_read`) |
| One-off / fully bespoke period, partial first/last (install proration) | `recurrence = manual` or a single hand-created `billing_periods` row (`source = manual`) |

A pure `materializePeriods(policy, range)` function generates candidates; the reconciliation engine never calls it — it only reads concrete rows. This keeps generation, override, and computation cleanly separable.

```ts
// packages/db/src/schema.ts
import {
  pgTable, pgEnum, uuid, text, integer, bigint, boolean, jsonb,
  numeric, timestamp, primaryKey, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { user, organization } from "./auth-schema"; // better-auth generated

/* ─────────────── Enums ─────────────── */
export const siteRole            = pgEnum("site_role", ["owner", "site_manager"]);
export const billingRecurrence   = pgEnum("billing_recurrence", ["calendar_month", "day_of_month", "n_monthly", "weekly", "fiscal", "meter_read", "manual"]);
export const shortMonthPolicy    = pgEnum("short_month_policy", ["clamp_last_day", "skip", "rollover"]);
export const boundaryInclusivity = pgEnum("boundary_inclusivity", ["half_open", "inclusive", "half_open_end"]);
export const billingPeriodSource = pgEnum("billing_period_source", ["generated", "manual", "meter_read", "invoice_derived"]);
export const billingPeriodStatus = pgEnum("billing_period_status", ["open", "closed"]);
export const connectivityMode    = pgEnum("connectivity_mode", ["lte", "wifi"]);
export const deviceStatus        = pgEnum("device_status", ["provisioning", "online", "offline", "degraded"]);
export const upsStatus           = pgEnum("ups_status", ["on_mains", "charging", "on_battery", "degraded", "unknown"]);
export const readingSource       = pgEnum("reading_source", ["live", "backfill_register", "manual"]);
export const tariffType          = pgEnum("tariff_type", ["landlord_stated", "legal_ceiling"]);
export const tariffSource        = pgEnum("tariff_source", ["library", "custom"]);
export const chargeType          = pgEnum("charge_type", ["active_energy", "demand", "reactive_energy", "fixed", "ancillary"]);
export const rateUnit            = pgEnum("rate_unit", ["c_per_kwh", "r_per_kva", "c_per_kvarh", "r_per_day", "r_per_month"]);
export const touPeriod           = pgEnum("tou_period", ["peak", "standard", "offpeak", "all"]);
export const season              = pgEnum("season", ["high", "low", "all"]);
export const siteTariffRole      = pgEnum("site_tariff_role", ["landlord", "legal_ceiling"]);
export const invoiceStatus       = pgEnum("invoice_status", ["uploaded", "parsing", "parsed_pending_confirm", "confirmed", "locked"]);
export const lineCategory        = pgEnum("line_category", ["active", "demand", "reactive", "fixed", "vat", "add_on_metering", "add_on_admin", "add_on_vending", "other"]);
export const reconStatus         = pgEnum("recon_status", ["draft", "final"]);
export const integrityStatus     = pgEnum("integrity_status", ["clean", "gaps_present"]);
export const alertType           = pgEnum("alert_type", ["device_offline", "sim_down", "data_gap", "ups_degraded", "power_restored", "demand_spike", "invoice_ready"]);
export const alertSeverity       = pgEnum("alert_severity", ["info", "warning", "critical"]);
export const alertStatus         = pgEnum("alert_status", ["open", "acknowledged", "resolved"]);
export const deliveryChannel     = pgEnum("delivery_channel", ["app", "email", "sms"]);
export const deliveryStatus      = pgEnum("delivery_status", ["pending", "sent", "failed"]);

/* ─────────────── Sites & access ─────────────── */
export const sites = pgTable("sites", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  addressLine1: text("address_line1"),
  city: text("city"),
  province: text("province"),
  supplyZone: text("supply_zone"),                 // municipality / distributor zone
  timezone: text("timezone").notNull().default("Africa/Johannesburg"),
  // Per-site DEFAULT demand interval (15 or 30) — snapshotted onto each billing period at materialization.
  // The billing cycle itself is NOT stored as fixed columns here: it lives in billing_cycle_policies
  // (the recurrence rule) + billing_periods (concrete, authoritative periods). See §3.0.
  demandIntervalMinutes: integer("demand_interval_minutes").notNull().default(30),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ orgIdx: index("sites_org_idx").on(t.organizationId) }));

// Site Manager scoping (Owner sees all org sites via org membership; Site Manager needs explicit grant)
export const siteAccess = pgTable("site_access", {
  id: uuid("id").defaultRandom().primaryKey(),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  role: siteRole("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uq: uniqueIndex("site_access_uq").on(t.siteId, t.userId) }));

/* ─────────────── Billing cycle: policy (rule) + materialized periods ─────────────── */
// The recurrence RULE. One active version per site; changes are versioned (effectiveFrom/To) so
// history is never rewritten. Generates candidate billing_periods; users may override any period.
export const billingCyclePolicies = pgTable("billing_cycle_policies", {
  id: uuid("id").defaultRandom().primaryKey(),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  recurrence: billingRecurrence("recurrence").notNull().default("calendar_month"),
  anchorDay: integer("anchor_day"),                        // 1..31 for day_of_month (31 ⇒ "last day of month")
  shortMonthPolicy: shortMonthPolicy("short_month_policy").notNull().default("clamp_last_day"),
  intervalCount: integer("interval_count").notNull().default(1), // step for n_monthly / n-weekly (e.g. 2 = bi-monthly)
  anchorDate: timestamp("anchor_date", { withTimezone: true }),   // phases weekly / n_monthly; fiscal-year start for recurrence=fiscal
  fiscalPattern: text("fiscal_pattern").default("4-4-5"),         // fiscal only: "4-4-5" | "4-5-4" | "5-4-4" (weeks per period in a quarter)
  leapWeekPlacement: text("leap_week_placement").default("last"), // fiscal only: where the 53rd week lands in a 53-week year ("last" | "P<n>")
  anchorTimeOfDay: text("anchor_time_of_day").notNull().default("00:00"), // boundary time-of-day in site tz (e.g. "09:00" meter-read time)
  boundaryInclusivity: boundaryInclusivity("boundary_inclusivity").notNull().default("half_open"), // [start,end) default
  snapToDemandGrid: boolean("snap_to_demand_grid").notNull().default(true), // align boundary to the demand-interval grid
  version: integer("version").notNull().default(1),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ siteIdx: index("billing_policy_site_idx").on(t.siteId, t.effectiveFrom) }));

// The CONCRETE period. Authoritative start/end that all downstream math reads. Rows may be
// rule-generated, hand-edited, or entered from actual meter-read/invoice dates — hence fully malleable.
export const billingPeriods = pgTable("billing_periods", {
  id: uuid("id").defaultRandom().primaryKey(),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  boundaryInclusivity: boundaryInclusivity("boundary_inclusivity").notNull().default("half_open"), // snapshot
  demandIntervalMinutes: integer("demand_interval_minutes").notNull(),   // snapshot (immutable history)
  label: text("label"),                                    // e.g. "20 Jun–19 Jul 2026", "FY26 P07"
  source: billingPeriodSource("source").notNull().default("generated"),
  policyId: uuid("policy_id").references(() => billingCyclePolicies.id), // provenance if generated
  status: billingPeriodStatus("status").notNull().default("open"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uq: uniqueIndex("billing_period_uq").on(t.siteId, t.periodStart) }));

/* ─────────────── Devices & meters ─────────────── */
export const devices = pgTable("devices", {
  id: uuid("id").defaultRandom().primaryKey(),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
  serialNumber: text("serial_number").notNull().unique(), // Pi provisioning id
  hardwareModel: text("hardware_model").notNull().default("rpi"),
  simIccid: text("sim_iccid"),
  simMsisdn: text("sim_msisdn"),
  simProvider: text("sim_provider"),
  connectivityMode: connectivityMode("connectivity_mode").notNull().default("lte"),
  firmwareVersion: text("firmware_version"),
  apiKeyHash: text("api_key_hash").notNull(),     // HMAC shared-secret hash for /ingest auth
  status: deviceStatus("status").notNull().default("provisioning"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  upsStatus: upsStatus("ups_status").notNull().default("unknown"),
  upsBatteryPct: integer("ups_battery_pct"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ siteIdx: index("devices_site_idx").on(t.siteId) }));

export const meters = pgTable("meters", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  serialNumber: text("serial_number").notNull(),
  model: text("model").notNull().default("SDM630MCT"),
  midCertifiedVariant: boolean("mid_certified_variant").notNull().default(true),
  midCertificateRef: text("mid_certificate_ref"),          // evidence traceability
  ctRatioPrimary: integer("ct_ratio_primary"),
  ctRatioSecondary: integer("ct_ratio_secondary").default(5),
  phaseConfig: text("phase_config").default("3P4W"),
  installedByName: text("installed_by_name"),              // licensed electrician
  installerRegistration: text("installer_registration"),   // wireman's licence no.
  installedAt: timestamp("installed_at", { withTimezone: true }),
  commissionedAt: timestamp("commissioned_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ deviceIdx: index("meters_device_idx").on(t.deviceId) }));

/* ─────────────── Time-series: readings (PARTITIONED) ─────────────── */
// Composite PK (meter_id, time) → idempotent upsert. Range-partitioned by `time` (see migration).
export const readings = pgTable("readings", {
  meterId: uuid("meter_id").notNull().references(() => meters.id, { onDelete: "cascade" }),
  time: timestamp("time", { withTimezone: true }).notNull(),
  seq: bigint("seq", { mode: "number" }),                  // edge monotonic counter (gap detection)
  activeEnergyKwh: numeric("active_energy_kwh", { precision: 14, scale: 3 }),      // cumulative register
  reactiveEnergyKvarh: numeric("reactive_energy_kvarh", { precision: 14, scale: 3 }), // cumulative register
  apparentEnergyKvah: numeric("apparent_energy_kvah", { precision: 14, scale: 3 }),   // cumulative (if present)
  totalPowerKw: numeric("total_power_kw", { precision: 12, scale: 3 }),            // instantaneous
  totalApparentKva: numeric("total_apparent_kva", { precision: 12, scale: 3 }),
  powerFactor: numeric("power_factor", { precision: 5, scale: 4 }),
  source: readingSource("source").notNull().default("live"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.meterId, t.time] }),
  timeBrin: index("readings_time_brin").using("brin", t.time),
}));

/* ─────────────── Aggregated demand intervals ─────────────── */
export const demandIntervals = pgTable("demand_intervals", {
  id: uuid("id").defaultRandom().primaryKey(),
  meterId: uuid("meter_id").notNull().references(() => meters.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  intervalStart: timestamp("interval_start", { withTimezone: true }).notNull(), // clock-aligned in site tz
  intervalMinutes: integer("interval_minutes").notNull(),                        // 15 or 30 (snapshot)
  activeEnergyKwh: numeric("active_energy_kwh", { precision: 12, scale: 3 }),     // consumed in interval
  reactiveEnergyKvarh: numeric("reactive_energy_kvarh", { precision: 12, scale: 3 }),
  avgDemandKw: numeric("avg_demand_kw", { precision: 12, scale: 3 }),
  avgDemandKva: numeric("avg_demand_kva", { precision: 12, scale: 3 }),
  avgPowerFactor: numeric("avg_power_factor", { precision: 5, scale: 4 }),
  sampleCount: integer("sample_count").notNull().default(0),
  expectedSamples: integer("expected_samples").notNull(),
  isComplete: boolean("is_complete").notNull().default(false),
  source: readingSource("source").notNull().default("live"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uq: uniqueIndex("demand_interval_uq").on(t.meterId, t.intervalStart, t.intervalMinutes),
  siteTimeIdx: index("demand_site_time_idx").on(t.siteId, t.intervalStart),
}));

/* ─────────────── Data gaps ─────────────── */
export const dataGaps = pgTable("data_gaps", {
  id: uuid("id").defaultRandom().primaryKey(),
  meterId: uuid("meter_id").notNull().references(() => meters.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  gapStart: timestamp("gap_start", { withTimezone: true }).notNull(),
  gapEnd: timestamp("gap_end", { withTimezone: true }).notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  backfilled: boolean("backfilled").notNull().default(false),
  backfillSource: text("backfill_source"),        // 'meter_register' | null
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => ({ siteIdx: index("data_gaps_site_idx").on(t.siteId, t.gapStart) }));

/* ─────────────── Tariffs ─────────────── */
export const tariffProfiles = pgTable("tariff_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }), // null = global library
  name: text("name").notNull(),
  type: tariffType("type").notNull(),
  source: tariffSource("source").notNull(),
  supplyZone: text("supply_zone"),
  distributor: text("distributor"),
  currency: text("currency").notNull().default("ZAR"),
  touSchedule: jsonb("tou_schedule"),             // hour→period map per season/day-type
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  validatedByAttorney: boolean("validated_by_attorney").notNull().default(false), // legal-ceiling gate (§6)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ libIdx: index("tariff_lib_idx").on(t.type, t.supplyZone) }));

export const tariffRates = pgTable("tariff_rates", {
  id: uuid("id").defaultRandom().primaryKey(),
  tariffProfileId: uuid("tariff_profile_id").notNull().references(() => tariffProfiles.id, { onDelete: "cascade" }),
  chargeType: chargeType("charge_type").notNull(),
  unit: rateUnit("unit").notNull(),
  rateValue: numeric("rate_value", { precision: 14, scale: 6 }).notNull(),
  season: season("season").notNull().default("all"),
  touPeriod: touPeriod("tou_period").notNull().default("all"),
  blockThresholdKwh: numeric("block_threshold_kwh", { precision: 12, scale: 2 }), // inclining block
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ profIdx: index("tariff_rates_profile_idx").on(t.tariffProfileId) }));

export const siteTariffAssignments = pgTable("site_tariff_assignments", {
  id: uuid("id").defaultRandom().primaryKey(),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  tariffProfileId: uuid("tariff_profile_id").notNull().references(() => tariffProfiles.id),
  role: siteTariffRole("role").notNull(),         // landlord | legal_ceiling
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
}, (t) => ({ siteIdx: index("site_tariff_idx").on(t.siteId, t.role) }));

/* ─────────────── Invoices ─────────────── */
export const landlordInvoices = pgTable("landlord_invoices", {
  id: uuid("id").defaultRandom().primaryKey(),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  billingPeriodId: uuid("billing_period_id").references(() => billingPeriods.id), // concrete period this invoice covers
  billingPeriodStart: timestamp("billing_period_start", { withTimezone: true }).notNull(), // snapshot from period
  billingPeriodEnd: timestamp("billing_period_end", { withTimezone: true }).notNull(),     // snapshot from period
  fileStorageKey: text("file_storage_key").notNull(),  // R2/S3 object key
  fileHash: text("file_hash").notNull(),               // sha256 of uploaded PDF
  status: invoiceStatus("status").notNull().default("uploaded"),
  parseModel: text("parse_model"),                     // llm model id used
  parsedRaw: jsonb("parsed_raw"),                      // full LLM structured output
  confirmedActiveCents: integer("confirmed_active_cents"),
  confirmedDemandCents: integer("confirmed_demand_cents"),
  confirmedReactiveCents: integer("confirmed_reactive_cents"),
  confirmedFixedCents: integer("confirmed_fixed_cents"),
  confirmedTotalCents: integer("confirmed_total_cents"),
  uploadedByUserId: text("uploaded_by_user_id").references(() => user.id),
  confirmedByUserId: text("confirmed_by_user_id").references(() => user.id),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ siteIdx: index("invoices_site_idx").on(t.siteId, t.billingPeriodStart) }));

export const invoiceLineItems = pgTable("invoice_line_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  invoiceId: uuid("invoice_id").notNull().references(() => landlordInvoices.id, { onDelete: "cascade" }),
  rawLabel: text("raw_label").notNull(),
  parsedCategory: lineCategory("parsed_category").notNull(),
  parsedValueCents: integer("parsed_value_cents"),
  confidence: numeric("confidence", { precision: 4, scale: 3 }),  // 0..1 → drives "needs review" UI
  confirmedCategory: lineCategory("confirmed_category"),
  confirmedValueCents: integer("confirmed_value_cents"),
  isImpermissibleAddOn: boolean("is_impermissible_add_on").notNull().default(false), // NERSA add-on flag
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ invIdx: index("line_items_invoice_idx").on(t.invoiceId) }));

/* ─────────────── Reconciliation / report ─────────────── */
export const reconciliations = pgTable("reconciliations", {
  id: uuid("id").defaultRandom().primaryKey(),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  invoiceId: uuid("invoice_id").references(() => landlordInvoices.id),
  billingPeriodId: uuid("billing_period_id").references(() => billingPeriods.id), // the concrete period reconciled
  billingPeriodStart: timestamp("billing_period_start", { withTimezone: true }).notNull(), // snapshot
  billingPeriodEnd: timestamp("billing_period_end", { withTimezone: true }).notNull(),     // snapshot
  boundaryInclusivity: boundaryInclusivity("boundary_inclusivity").notNull().default("half_open"), // snapshot
  demandIntervalMinutes: integer("demand_interval_minutes").notNull(),  // snapshot
  landlordTariffProfileId: uuid("landlord_tariff_profile_id").references(() => tariffProfiles.id),
  legalCeilingTariffProfileId: uuid("legal_ceiling_tariff_profile_id").references(() => tariffProfiles.id),
  measuredActiveKwh: numeric("measured_active_kwh", { precision: 14, scale: 3 }),
  measuredMaxDemandKva: numeric("measured_max_demand_kva", { precision: 12, scale: 3 }),
  measuredReactiveKvarh: numeric("measured_reactive_kvarh", { precision: 14, scale: 3 }),
  expectedLandlordCents: integer("expected_landlord_cents"),
  expectedCeilingCents: integer("expected_ceiling_cents"),
  chargedTotalCents: integer("charged_total_cents"),
  discrepancyVsLandlordCents: integer("discrepancy_vs_landlord_cents"),
  discrepancyVsCeilingCents: integer("discrepancy_vs_ceiling_cents"),
  dataIntegrityStatus: integrityStatus("data_integrity_status").notNull().default("clean"),
  gapCount: integer("gap_count").notNull().default(0),
  gapMinutesTotal: integer("gap_minutes_total").notNull().default(0),
  breakdown: jsonb("breakdown"),                        // full computed line detail
  status: reconStatus("status").notNull().default("draft"),
  version: integer("version").notNull().default(1),
  pdfStorageKey: text("pdf_storage_key"),
  pdfHash: text("pdf_hash"),                            // seals the evidence
  generatedAt: timestamp("generated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ siteIdx: index("recon_site_idx").on(t.siteId, t.billingPeriodStart) }));

/* ─────────────── Alerts / events + delivery ─────────────── */
export const alerts = pgTable("alerts", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").references(() => devices.id, { onDelete: "cascade" }),
  type: alertType("type").notNull(),
  severity: alertSeverity("severity").notNull().default("warning"),
  title: text("title").notNull(),
  message: text("message"),
  payload: jsonb("payload"),
  status: alertStatus("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => ({ orgIdx: index("alerts_org_idx").on(t.organizationId, t.status) }));

export const alertDeliveries = pgTable("alert_deliveries", {
  id: uuid("id").defaultRandom().primaryKey(),
  alertId: uuid("alert_id").notNull().references(() => alerts.id, { onDelete: "cascade" }),
  channel: deliveryChannel("channel").notNull(),
  recipientUserId: text("recipient_user_id").references(() => user.id),
  status: deliveryStatus("status").notNull().default("pending"),
  providerRef: text("provider_ref"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (t) => ({ alertIdx: index("alert_deliv_idx").on(t.alertId) }));

/* ─────────────── Device health (fleet) + audit ─────────────── */
export const deviceHealthSamples = pgTable("device_health_samples", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  time: timestamp("time", { withTimezone: true }).notNull(),
  connectivityMode: connectivityMode("connectivity_mode"),
  signalRssi: integer("signal_rssi"),
  upsStatus: upsStatus("ups_status"),
  batteryPct: integer("battery_pct"),
  cpuTempC: numeric("cpu_temp_c", { precision: 5, scale: 2 }),
  bufferedRecords: integer("buffered_records"),   // store-and-forward backlog depth
}, (t) => ({ devTimeIdx: index("dev_health_idx").on(t.deviceId, t.time) }));

export const auditLog = pgTable("audit_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(),
  actorType: text("actor_type").notNull(),        // user | system | device
  actorId: text("actor_id"),
  diff: jsonb("diff"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ entIdx: index("audit_entity_idx").on(t.entityType, t.entityId) }));
```

**Partitioning migration (raw SQL, applied after Drizzle push):**

```sql
-- Convert readings to a range-partitioned table on `time`, then create monthly partitions.
-- (Run in a migration; Drizzle emits the base table, we add PARTITION BY here.)
ALTER TABLE readings RENAME TO readings_default; -- if bootstrapping; otherwise create partitioned from start
-- Preferred: define partitioned parent explicitly in the first migration:
--   CREATE TABLE readings (...) PARTITION BY RANGE (time);
--   CREATE TABLE readings_2026_07 PARTITION OF readings
--     FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
-- A monthly cron creates next month's partition ahead of time.
```

### 3.1 Relationship summary

- `organization` **1—N** `sites`, `tariff_profiles` (org-custom), `alerts`.
- `sites` **1—N** `devices`, `meters`, `demand_intervals`, `data_gaps`, `landlord_invoices`, `reconciliations`, `site_access`, `site_tariff_assignments`, `billing_cycle_policies` (versioned), `billing_periods`.
- `billing_cycle_policies` **1—N** `billing_periods` (generated rows carry `policy_id`; manual rows may have none).
- `billing_periods` **1—1** `landlord_invoices` and **1—N** `reconciliations` (versions) — both snapshot the period's boundaries/interval.
- `devices` **1—N** `meters` (usually 1—1), `device_health_samples`.
- `meters` **1—N** `readings` (partitioned), `demand_intervals`, `data_gaps`.
- `tariff_profiles` **1—N** `tariff_rates`; **N—N** `sites` via `site_tariff_assignments` (roles landlord / legal_ceiling).
- `landlord_invoices` **1—N** `invoice_line_items`; **1—1(→N versions)** `reconciliations`.
- `user` **N—N** `sites` via `site_access` (site_manager scope); org-wide access via better-auth `member`.

---

## 4. API & Routing

Two seams: **oRPC** for first-party TS clients (web, Expo), **Hono REST** for devices/webhooks/files/auth.

### 4.1 oRPC router structure (`apps/server/src/routers`)

```
appRouter
├── session        me, listMemberships
├── org            create, get, listMembers, invite, setMemberRole            [owner]
├── sites          list, get, create, update, setBillingConfig, delete
├── siteAccess     list, grant, revoke                                        [owner]
├── devices        list, get, provision, rotateKey, getHealth, updateSite     [owner|operator]
├── meters         get, create, commission
├── readings       queryRange (meterId, from, to)                             [site-scoped]
├── demand         listIntervals, getMaxDemand (siteId, period)
├── dataGaps       list, requestBackfill, resolve
├── tariffs
│   ├── library    list, get                                                  [operator writes]
│   ├── profiles   create, update, addRate, listRates
│   └── assign     set, list (landlord | legal_ceiling per site)
├── invoices       createUpload(presign), list, get, listLineItems,
│                  triggerParse, updateLineItem, confirm, lock
├── reconciliation generate, get, list, listVersions, getPdfUrl
├── alerts         list, acknowledge, resolve, getPreferences, setPreferences
└── fleet          overview, deviceHealth, simStatus, offlineDevices          [platform_operator]
```

**Authorization** is enforced in a shared oRPC middleware, layered:
1. `requireSession` — valid better-auth session.
2. `requireOrg` — user is a `member` of the target `organizationId`.
3. `requireSiteAccess(role?)` — Owner (org member) OR explicit `site_access` grant for Site Managers.
4. `requirePlatformOperator` — `user.is_platform_operator` for `fleet.*` and library writes.

### 4.2 Hono endpoints (`apps/server/src/http`)

| Method / path | Auth | Purpose |
|---|---|---|
| `POST /ingest/readings` | Device HMAC (`deviceId` + signature over body) | Batch 1-min readings; idempotent upsert; returns highest accepted `seq` |
| `POST /ingest/health` | Device HMAC | Health heartbeat → `device_health_samples`, updates `devices.last_seen_at`/`ups_status` |
| `GET /device/config/:deviceId` | Device HMAC | Edge pulls `demand_interval_minutes`, poll rate, feature flags |
| `POST /device/commission` | Provisioning token (one-time) | First contact from a freshly installed Pi; issues device key |
| `POST /webhooks/sms` | Provider signature | SMS delivery-status callbacks → `alert_deliveries` |
| `GET /reports/:reconId/pdf` | Session (signed short-lived URL) | Stream sealed report PDF |
| `ALL /api/auth/*` | — | better-auth handler (mounted) |
| `ALL /rpc/*` | Session | oRPC handler (mounted) |

**Background workers (Bun, `apps/server/src/jobs`):** `aggregateDemandIntervals` (on-ingest + cron), `detectDataGaps`, `evaluateDeviceOffline` (no heartbeat > threshold → alert), `runReconciliation`, `generateReportPdf`, `parseInvoice` (LLM), `createNextPartition` (monthly), `pollSimFleet` (MNO API).

---

## 5. Key Technical Risks & Mitigations

| # | Risk | Mitigation |
|---|---|---|
| **R1** | **Data-gap detection & register backfill.** A missed minute biases demand and invalidates the dispute. | Dual detection: `seq` discontinuity **and** `sample_count < expected` per interval. Because energy fields are **cumulative registers**, a gap bounded by two good readings is exactly reconstructable: interval energy = `kWh_end − kWh_start` regardless of missing mid-samples → demand stays correct. True outages (device down) open a `data_gaps` row; on reconnect the edge replays its SQLite buffer, and if the buffer was lost, backfill from the SDM630's onboard energy registers. Any interval that remains non-reconstructable is stamped `gaps_present` and rendered as a flagged event on the report. |
| **R2** | **Demand-window alignment.** Wrong boundaries/timezone/interval → wrong max demand vs. the landlord. | Compute intervals on **clock-aligned wall-clock boundaries in the site timezone** at the per-site `demand_interval_minutes`. Snapshot the interval length onto `demand_intervals` and `reconciliations` so a later config change never silently rewrites history. Golden-file tests over DST-free `Africa/Johannesburg` and edge boundaries (23:45–00:00). Reconcile computed interval energy against register deltas as an invariant check. |
| **R3** | **Offline resilience & clean fast reboot to catch restoration peaks.** Power returns → big inrush/demand spike must be captured, but the Pi is rebooting. | UPS holds the Pi through brownouts. On mains loss the edge keeps sampling on battery and marks `ups_status=on_battery`. Fast boot: DietPi minimal image, service `WantedBy` early target, poll loop starts before non-essential units, watchdog auto-restarts a hung agent. On boot the agent immediately reads the meter's **max-demand register** (which kept accumulating on the meter's own supply) so the restoration peak is captured even for the seconds the Pi was down. Emit a `power_restored` alert. |
| **R4** | **LLM invoice-parse accuracy.** Mis-parsed totals → wrong dispute → credibility loss. | Structured tool-use with a strict JSON schema; **every** line carries a `confidence`; the total must equal the sum of parsed lines (arithmetic self-check) or the invoice is forced to manual review. **Confirm-before-lock is mandatory** — nothing feeds reconciliation until a user confirms; low-confidence fields are visually flagged. Store `parsed_raw` + `parse_model` for audit. Never auto-lock (spec §3). |
| **R5** | **MID-certification & evidence traceability.** Report must be defensible. | Persist `mid_certificate_ref`, meter serial, CT ratios, installer name + wireman's licence, `installed_at`/`commissioned_at`. Every report embeds the meter provenance, the exact tariff profile **version** used, data-integrity status, and a **content hash (`pdf_hash`)** with a `version` counter so any regeneration is traceable. `audit_log` records who confirmed/locked what. `legal_ceiling` tariffs cannot be asserted unless `validated_by_attorney = true` (spec §6 commercial-context caveat). |
| **R6** | **SIM fleet management.** Dead SIM = silent data loss. | Store `sim_iccid/msisdn/provider`; poll the MNO/MVNO API for session/data state via `pollSimFleet`; correlate with `last_seen_at`. Offline > threshold → `sim_down`/`device_offline` alert (app+email+SMS). Prefer a multi-network/roaming data SIM to reduce single-tower dead zones. Fleet dashboard surfaces SIM health per install. |
| **R7** | **Security of tenant billing data.** Financial + dispute-sensitive. | Per-request RBAC (org membership + site grant); tenant isolation enforced in oRPC middleware, never trusted from the client. Device auth via per-device HMAC secret (hash stored), rotatable. TLS everywhere; invoices/reports in a private bucket with short-lived signed URLs. Neon encryption at rest; secrets in the platform vault. `audit_log` on all confirm/lock/report actions. Least-privilege for platform operators; their cross-tenant access is itself audited. |

---

## 6. Phased Delivery Plan (mapped to MoSCoW)

Critical path is **bold**. Sizing in engineer-weeks (S≈1, M≈2–3, L≈4–6).

### MVP (commercial-launch gate — all *Must Have*)
| Phase | Deliverable | MoSCoW | Size |
|---|---|---|---|
| **P1** | **DB schema + migrations + partitioning + seed** | Must | **M** |
| **P2** | better-auth + org plugin + RBAC middleware | Must (auth, roles) | M |
| **P3** | **Edge agent: Modbus poll, SQLite buffer, HMAC sync, fast-boot/watchdog** | Must (edge, buffering, reboot, backfill) | **L** |
| **P4** | **Ingestion API + demand aggregation + gap detection** | Must (1-min→interval, gaps) | **L** |
| P5 | Tariff library + custom entry + rates model | Must (tariff library) | M |
| **P6** | **Reconciliation engine (active/demand/reactive × landlord/ceiling)** | Must | **M** |
| P7 | LLM invoice parse → confirm-before-lock | Must (invoice upload) | M |
| **P8** | **Dispute-ready PDF (hash-sealed, provenance, gap flags)** | Must | **M** |
| P9 | Web app: auth, site dashboard, invoice/reconcile flow | Must (web) | L |
| P10 | Fleet/admin dashboard (device/SIM/connectivity) | Must (fleet) | M |
| P11 | Notification service (app+email+SMS) + core alerts | Must (alerts) | M |
| P12 | Native iOS/Android (Expo, reusing oRPC client) | Must (mobile) | L |

**Critical path:** P1 → P3 → P4 → P6 → P8 (evidence pipeline). P5/P7 feed P6; P9/P12 consume everything; P2 gates all app APIs.

### Phase 2 (Should Have)
Rest-of-month forecast (S); power-factor insight (S); illegal add-on detection surfaced from `invoice_line_items.is_impermissible_add_on` (S); NERSA recourse path on report (S); deliverable-guarantee tracking (S).

### Phase 3 (Could Have)
Parse-quality improvements/feedback loop; historical trends & cross-site benchmarking; near-real-time demand-spike alerting; automated regulatory-change tariff ingestion.

**Explicitly deferred (Won't, v1):** own-meter manufacture; savings guarantee; self-service onboarding; direct billing-system integrations; automated legal filing; load control.

---

## 7. Open Technical Questions (each with recommended default)

| # | Question | Recommended default |
|---|---|---|
| Q1 | Time-series on Neon vs. dedicated TSDB? | **[DEFAULT]** Ship on Neon with monthly range partitions + BRIN; revisit only if a meter count/query SLA is breached. Contract-isolate so migration is app-transparent. |
| Q2 | Device transport: HTTP batch vs. MQTT? | **[DEFAULT]** HTTPS batch POST for MVP; keep the ingestion payload MQTT-portable. |
| Q3 | Poll granularity & battery: sample every 60s always? | **[DEFAULT]** 60s on mains; on `on_battery`, keep 60s but rely on meter max-demand register for the peak of truth. |
| Q4 | `kVA` demand from apparent register vs. `√(kWh²+kVArh²)`? | **[DEFAULT]** Use the SDM630 apparent-energy register if populated; else derive; store which method per interval. |
| Q5 | Reconciliation trigger — auto on invoice-lock or manual "Generate"? | **[DEFAULT]** Auto-draft on lock, require explicit user "Finalise" to seal the versioned PDF. |
| Q6 | Mobile: Expo/React Native vs. two native codebases? | **[DEFAULT]** Expo (React Native) reusing the oRPC TS client — one codebase, both stores. |
| Q7 | LLM provider/model for parsing? | **[DEFAULT]** Claude `claude-opus-4-8` (hard) / `claude-haiku-4-5` (routine) via structured tool-use; PDFs rendered to images for robustness. |
| Q8 | SIM provider & management API? | **[DEFAULT]** A managed multi-network IoT data SIM (roaming) with a REST fleet API; confirm SA coverage/pricing before commit. |
| Q9 | Billing-cycle boundary semantics. | **RESOLVED** — modelled malleably (§3.0): `billing_cycle_policies` (recurrence rule) + materialized `billing_periods` (authoritative timestamps). Covers calendar-month, day-of-month with `short_month_policy` (no `≤28` limit), n-monthly, weekly, 4-4-5, meter-read, and fully manual periods; per-policy `boundary_inclusivity` and `anchor_time_of_day`. Default policy for a new site: `calendar_month`, `half_open`, `00:00`. |
| Q10 | PDF renderer footprint (Chromium) in the deploy target? | **[DEFAULT]** Run report generation as a separate worker/container with Playwright; keep it off the request path. |

---
*End of 02_Technical_Architecture.md*
