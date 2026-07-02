# 03 — Developer Prompts (Sparks) · No-Veer Checkpoint Protocol

**Audience:** a separate developer agent (Claude Haiku) building the Sparks monorepo.
**How to use:** copy **one** phase block at a time into the developer agent. Do not paste the next phase until the previous one has stopped and you have manually reviewed its summary.

**Ground rules that apply to every phase (the agent must obey these even though they are restated per phase):**
- Stack is fixed: Bun · Turborepo · Next.js (App Router) · Hono · oRPC · better-auth (+ organization plugin) · Postgres/Neon · Drizzle · Biome/Ultracite. Do **not** introduce new frameworks, ORMs, or state libraries without an explicit instruction.
- Source of truth for data model, API map, and risks is `docs/02_Technical_Architecture.md`. Follow it exactly; if reality contradicts it, **stop and report**, do not improvise a redesign.
- Money = integer cents (ZAR). Time = `timestamptz` stored UTC; billing/demand alignment uses the site timezone. Energy/power = `numeric`.
- Run `bun run check` (Biome/Ultracite) and `bunx tsc --noEmit` before declaring a phase complete.

---

## Phase 0 — Scaffold verification & repo map

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: Verify the better-t-stack monorepo scaffold only. Do NOT add features.
1. Confirm the workspace layout (apps/web, apps/server, packages/*) and that Bun + Turborepo are wired.
2. Confirm better-auth, Drizzle, and the Neon connection are configured; locate the drizzle config and the better-auth server instance.
3. Confirm oRPC is mounted in the Hono server and reachable from apps/web.
4. Produce a short map: which file holds the Drizzle schema, the Hono app entry, the oRPC root router, the better-auth config, and env var names for the Neon URL and auth secret.
5. Run `bun install`, `bun run check`, and `bunx tsc --noEmit`; report any pre-existing errors. Fix ONLY scaffold breakage, nothing else.

When complete, stop. Output a summary of modified/created files, list any roadblocks, and state the exact next file to be touched. Do not proceed to the next phase until manually instructed.
```

---

## Phase 1 — Database schema, migrations, partitioning & seed

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: Implement the Drizzle schema exactly as specified in docs/02_Technical_Architecture.md §3, plus migrations and a seed script. No routers, no UI.
1. Create/replace the domain schema file (e.g. packages/db/src/schema.ts) with all enums and tables from §3: sites, siteAccess, billingCyclePolicies, billingPeriods, devices, meters, readings, demandIntervals, dataGaps, tariffProfiles, tariffRates, siteTariffAssignments, landlordInvoices (with billingPeriodId), invoiceLineItems, reconciliations (with billingPeriodId), alerts, alertDeliveries, deviceHealthSamples, auditLog. Reference better-auth's user/organization tables — do NOT redefine auth tables. Note: the billing cycle is NOT fixed columns on sites — it is billingCyclePolicies (rule) + billingPeriods (concrete periods) per §3.0.
2. Add better-auth additionalField `isPlatformOperator` (boolean, default false) on user.
3. Generate the migration with drizzle-kit. Then add a raw-SQL migration that makes `readings` RANGE-partitioned by `time` and creates the current + next monthly partition. Add a helper (SQL function or a documented job stub) to create future monthly partitions.
4. Write a seed script (bun) that inserts: one org, one owner user, one operator user (isPlatformOperator=true), one site (demand_interval_minutes=30), one billing_cycle_policy for that site (recurrence=day_of_month, anchor_day=20, short_month_policy=clamp_last_day, boundary_inclusivity=half_open), two materialized billing_periods generated from it (each snapshotting demand_interval_minutes + boundary_inclusivity), one device, one meter, one library legal_ceiling tariff_profile with a few tariff_rates, and one landlord tariff_profile assigned to the site.
5. Verify migrations apply cleanly against Neon and the seed runs. Run `bun run check` and `bunx tsc --noEmit`.

Constraints: money as integer cents; timestamps timestamptz; do NOT add indexes/tables beyond §3.

When complete, stop. Output a summary of modified/created files, list any roadblocks, and state the exact next file to be touched. Do not proceed to the next phase until manually instructed.
```

---

## Phase 2 — Auth, org plugin & RBAC middleware

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: Authentication and authorization only. No business routers yet.
1. Enable the better-auth organization plugin (org = customer business/Account). Configure org roles: owner, operator.
2. Implement reusable oRPC middleware in the layered order from §4.1: requireSession → requireOrg → requireSiteAccess(role?) → requirePlatformOperator. requireSiteAccess must grant access to org owners for all org sites AND to users with an explicit site_access grant (site_manager scope).
3. Add small helper procedures: session.me and session.listMemberships.
4. Write unit tests proving: a site_manager with a grant can read their site; the same user is denied a sibling site; an org owner can read all org sites; a non-operator is denied fleet.* ; cross-org access is denied.
5. Run `bun run check` and `bunx tsc --noEmit`.

Do NOT implement sites/devices/invoice logic here — only the auth primitives and their tests.

When complete, stop. Output a summary of modified/created files, list any roadblocks, and state the exact next file to be touched. Do not proceed to the next phase until manually instructed.
```

---

## Phase 3 — Core oRPC routers (org, sites, access, devices, meters)

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: Implement these oRPC routers per §4.1, wired into the app router. CRUD + validation only; no aggregation, no reconciliation, no LLM.
- org: create, get, listMembers, invite, setMemberRole (owner-guarded)
- sites: list, get, create, update, setDefaultDemandInterval (validate ∈ {15,30}), delete
- billing (per §3.0): policies.get/set (versioned; changing a policy closes the old version, opens a new one — never rewrite history), periods.list, periods.materialize (calls the PURE materializePeriods(policy, range) generator and upserts candidate rows), periods.upsert (manual/meter_read override — stamps source, snapshots demand_interval_minutes + boundary_inclusivity), periods.close. Implement materializePeriods as a pure, DB-free function covering all §3.0 recurrences (calendar_month, day_of_month + short_month_policy, n_monthly, weekly, fiscal, meter_read=no-op, manual=no-op) with unit tests including anchor_day=31 in February and a "20th→20th" run. For recurrence=fiscal, drive the layout from fiscal_pattern ("4-4-5" | "4-5-4" | "5-4-4"), anchor_date (fiscal-year start), and leap_week_placement (53rd week in a 53-week year) — do NOT hardcode 4-4-5; test all three patterns and one 53-week year.
- siteAccess: list, grant, revoke (owner-guarded)
- devices: list, get, provision (returns a device secret; store only its hash), rotateKey, getHealth, updateSite
- meters: get, create, commission (sets installed/commissioned metadata + MID fields)

Rules: validate all inputs with the stack's schema validator; apply the Phase-2 RBAC middleware on every procedure; write oRPC procedure-level tests for the happy path + one auth-denied case each. Do not touch readings/ingestion.

When complete, stop. Output a summary of modified/created files, list any roadblocks, and state the exact next file to be touched. Do not proceed to the next phase until manually instructed.
```

---

## Phase 4 — Ingestion API, demand aggregation & gap detection (Hono + workers)

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: Device-facing HTTP + the aggregation/gap pipeline per §1.2, §4.2, and risks R1/R2. No UI.
1. Hono routes (separate from oRPC): POST /ingest/readings (HMAC device auth, batch, idempotent upsert on (meter_id,time), return highest accepted seq), POST /ingest/health (→ device_health_samples, update devices.last_seen_at/ups_status), GET /device/config/:deviceId (returns demand_interval_minutes + poll rate), POST /device/commission (one-time provisioning token → issues device key).
2. Worker aggregateDemandIntervals: compute clock-aligned intervals in the SITE timezone at the site's demand_interval_minutes; derive avg_demand_kw/kva from cumulative energy DELTAS (kWh_end − kWh_start)/interval_hours; set sample_count/expected_samples/is_complete; upsert demand_intervals.
3. Worker detectDataGaps: open data_gaps on seq discontinuity OR is_complete=false; where bounded by good cumulative registers, mark reconstructable.
4. Worker evaluateDeviceOffline: no heartbeat > threshold → create an alert row (delivery handled in a later phase).
5. Tests: golden-file interval alignment incl. a 23:45→00:00 boundary and a dropped mid-interval minute (interval energy must remain correct); HMAC rejection of a bad signature; idempotent re-POST of the same batch.

Do NOT build tariff/reconciliation/LLM here. Keep the ingestion payload MQTT-portable but implement HTTP only.

When complete, stop. Output a summary of modified/created files, list any roadblocks, and state the exact next file to be touched. Do not proceed to the next phase until manually instructed.
```

---

## Phase 5 — Tariff library & rates

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: Tariff domain per §3 and §4.1 tariffs.* only.
1. Routers: tariffs.library.list/get (operator writes), tariffs.profiles.create/update/addRate/listRates, tariffs.assign.set/list (roles landlord | legal_ceiling per site, with effective dates).
2. Enforce: a legal_ceiling profile cannot be assigned/asserted unless validated_by_attorney=true — reject at the assign procedure with a clear error.
3. Support custom tariff entry (source=custom, org-scoped) and library entries (source=library, organization_id null, operator-only writes). Model TOU/season via tariff_rates + tou_schedule jsonb as in §3.
4. Provide a pure pricing helper `priceUsage({activeKwh, maxDemandKva, reactiveKvarh, intervalStarts...}, tariffProfile)` returning a per-charge breakdown in cents. Keep it PURE (no DB) so Phase 6 can reuse it. Unit-test against a hand-computed TOU example.

Do NOT build the reconciliation orchestration or PDF here — only tariff data + the pure pricing function.

When complete, stop. Output a summary of modified/created files, list any roadblocks, and state the exact next file to be touched. Do not proceed to the next phase until manually instructed.
```

---

## Phase 6 — Reconciliation engine

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: reconciliation.* per §4.1 and the data flow step 6. Reuse Phase-5 priceUsage. No LLM, no PDF bytes yet.
1. reconciliation.generate(billingPeriodId): read the CONCRETE billing_periods row for its authoritative period_start/period_end and snapshotted boundary_inclusivity + demand_interval_minutes — do NOT re-derive boundaries from any rule (§3.0/§5 R2). Gather measured active_kWh (sum interval energy), max_demand_kva (max avg_demand_kva across clock-aligned intervals in the period), reactive_kVArh; price against the landlord AND legal_ceiling profiles effective in the period; compare to the CONFIRMED invoice totals; compute discrepancies; set data_integrity_status/gap_count/gap_minutes_total from data_gaps; write a versioned reconciliations row (status=draft, billing_period_id set) with a full breakdown jsonb.
2. reconciliation.get/list/listVersions. Snapshot billing_period_id, period start/end, boundary_inclusivity, demand_interval_minutes, and tariff profile ids onto the row.
3. Guard: refuse to finalise if the linked invoice is not status=locked.
4. Tests: a clean month (calendar_month period) with a known overcharge; a month with a data gap (must set gaps_present and still compute); a day_of_month "20th→20th" period crossing a tariff effective-date change; an inclusive-boundary period and a half-open period yielding the expected difference at the edge interval.

Do NOT generate PDF bytes here (Phase 8). Do NOT parse invoices here (Phase 7).

When complete, stop. Output a summary of modified/created files, list any roadblocks, and state the exact next file to be touched. Do not proceed to the next phase until manually instructed.
```

---

## Phase 7 — LLM invoice parsing with confirm-before-lock

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: invoices.* per §4.1 and risk R4. Human confirm-before-lock is MANDATORY.
1. invoices.createUpload(siteId, billingPeriodId) → presigned upload to the object store; persist landlord_invoices (status=uploaded, file_hash, billing_period_id + snapshotted period start/end from the billing_periods row).
2. Worker/procedure triggerParse: render the PDF to images, call Claude via structured tool-use returning a typed JSON schema (line items with rawLabel, category, valueCents, confidence). Persist parsed_raw + parse_model; write invoice_line_items; set status=parsed_pending_confirm. Arithmetic self-check: sum of lines must equal parsed total or flag for manual review. Categorise impermissible add-ons (metering/admin/vending) → is_impermissible_add_on=true.
3. invoices.listLineItems / updateLineItem (user corrects category/value) / confirm (writes confirmed_* totals, confirmed_by/at) / lock (status=locked, locked_at). NOTHING may auto-lock; reconciliation must read only confirmed+locked data.
4. Tests: low-confidence field is surfaced (not silently accepted); confirm then lock transitions; attempting to lock before confirm is rejected; add-on line flagged.

Use the model ids from §7 Q7. Do NOT build reconciliation logic here.

When complete, stop. Output a summary of modified/created files, list any roadblocks, and state the exact next file to be touched. Do not proceed to the next phase until manually instructed.
```

---

## Phase 8 — Dispute-ready PDF report (hash-sealed, provenance)

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: Report generation per risk R5 and §4.2 /reports/:id/pdf. Runs as a worker off the request path.
1. Worker generateReportPdf(reconId): render a React→HTML→PDF (Playwright/Chromium) report containing: site + meter provenance (serial, MID certificate ref, CT ratios, installer name + wireman's licence, commissioned date), billing window + demand interval used, measured active/max-demand/reactive, expected-vs-landlord-vs-legal-ceiling with discrepancies, data-integrity status with any gaps shown as flagged events, and the NERSA recourse path text.
2. Store the PDF in the private bucket; set pdf_storage_key + pdf_hash (sha256) + generated_at; bump version on regeneration (never overwrite prior versions).
3. GET /reports/:reconId/pdf returns a short-lived signed URL, session-guarded via site access.
4. Guard: refuse to seal a report whose legal_ceiling tariff has validated_by_attorney=false. Write an audit_log entry on generation.
5. Tests: hash stability for identical inputs; version increments on regeneration; a gaps_present recon renders the flag.

Do NOT change the reconciliation math here — only rendering/sealing.

When complete, stop. Output a summary of modified/created files, list any roadblocks, and state the exact next file to be touched. Do not proceed to the next phase until manually instructed.
```

---

## Phase 9 — Web app (Next.js): auth, site dashboard, invoice & reconcile flow

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: apps/web only, consuming existing oRPC procedures. No new backend logic.
1. Auth screens via better-auth; org/site selector respecting RBAC.
2. Site dashboard: near-real-time load + month-to-date active/demand/reactive per site (read from demand/readings procedures); device/connectivity status badge.
3. Monthly flow: upload invoice → show parsed line items with confidence-based "needs review" highlighting → user confirms/corrects → lock → generate reconciliation → download sealed PDF.
4. Surface data-gap / integrity state prominently on the reconciliation view.

Rules: use the generated oRPC client + the stack's data-fetching; no direct DB access from the frontend; keep components within the existing design system. Do NOT add mobile here.

When complete, stop. Output a summary of modified/created files, list any roadblocks, and state the exact next file to be touched. Do not proceed to the next phase until manually instructed.
```

---

## Phase 10 — Fleet/admin dashboard (operator)

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: Operator-only fleet area, gated by requirePlatformOperator. Consumes fleet.* (§4.1).
1. fleet.overview (counts: online/offline/degraded), fleet.deviceHealth (per-device: last_seen, connectivity, ups status, battery %, buffered backlog), fleet.simStatus, fleet.offlineDevices. Add the read procedures if missing, but nothing beyond §4.1.
2. Web pages: fleet table with filters, per-device drilldown (recent device_health_samples), SIM status column.
3. Enforce that a non-operator cannot reach these routes or procedures (test it).

Do NOT expose tenant billing data in the fleet views beyond site/device identifiers.

When complete, stop. Output a summary of modified/created files, list any roadblocks, and state the exact next file to be touched. Do not proceed to the next phase until manually instructed.
```

---

## Phase 11 — Notification service & alerts (app + email + SMS)

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: alerts.* + delivery per §3/§4. Alert ROWS may already be created by Phase-4 workers; this phase adds delivery + preferences + UI.
1. Notification dispatcher: for each open alert, fan out to channels (app in-DB, email via Resend, SMS via the SA aggregator) writing alert_deliveries rows with status/provider_ref; handle POST /webhooks/sms delivery callbacks.
2. Alert types required by spec: device_offline, sim_down, data_gap, ups_degraded (+ power_restored, invoice_ready). Ensure Phase-4/others emit these.
3. alerts.list/acknowledge/resolve; alerts.getPreferences/setPreferences (per-user channel opt-in).
4. Web: alerts inbox + notification preferences.
5. Tests: dispatch creates deliveries per enabled channel; a failed SMS is recorded as failed; ack/resolve transitions.

Do NOT redesign alert creation logic; only deliver + manage.

When complete, stop. Output a summary of modified/created files, list any roadblocks, and state the exact next file to be touched. Do not proceed to the next phase until manually instructed.
```

---

## Phase 12 — Native mobile (Expo iOS/Android)

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: apps/mobile (Expo/React Native) reusing the existing oRPC TS client + better-auth. Parity with the core web journeys only.
1. Auth + org/site selection.
2. Site dashboard (near-real-time + month-to-date), alerts inbox, invoice upload → confirm → reconcile → view/download PDF.
3. Push registration wired to the notification service (app channel).

Rules: share the oRPC client and types from packages/*; do NOT fork business logic into the app; no new backend procedures. Keep both platforms from one codebase.

When complete, stop. Output a summary of modified/created files, list any roadblocks, and state the exact next file to be touched. Do not proceed to the next phase until manually instructed.
```

---

### Phase sequencing (critical path in bold)

**P0 → P1 → P2 → P3 → P4 → P6 → P8** is the evidence-pipeline spine. P5 must land before P6; P7 must land before a real reconciliation uses confirmed invoice data; P9–P12 are consumers. Do not parallelise P4 and P6 with the same agent — keep phases isolated per the No-Veer protocol.

*End of 03_Developer_Prompts.md*
