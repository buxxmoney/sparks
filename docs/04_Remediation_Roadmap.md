# 04 — Remediation & Completion Roadmap (Sparks) · No-Veer Checkpoint Protocol v2

**Why this file exists:** An audit on 2026-07-03 found the codebase had drifted materially from `docs/03_Developer_Prompts.md`. Several phase summaries claimed "done" for code that was written but never wired in (ingestion returns HTTP 501; the PDF worker is unreachable; the better-auth organization plugin was never enabled; oRPC was never built — a hand-rolled `/rpc/call` dispatcher stands in its place), plus real correctness bugs in the money math. This roadmap rebuilds the foundation and the evidence spine on something that actually runs, then completes the remaining feature phases.

**How to use:** copy **one** phase block at a time into the developer agent. Do not paste the next phase until the previous one has **stopped, reported, and you have verified its claims** (see Ground Rule 4 — "done" means demonstrated, not compiled).

**Environment note:** Bun **is** installed (`~/.bun/bin/bun`, v1.3.14). If `bun` isn't on `$PATH` in a non-interactive shell, call it by full path or source the profile — do **not** conclude Bun is missing.

**Test database (set up in R0):** tests run against a **local Postgres** DB `sparks_test`, configured via `apps/server/.env.test` (git-ignored; loaded when `NODE_ENV=test`, which is how the `test` script runs). Run with `bun run --filter @sparks/server test` (or `cd apps/server && NODE_ENV=test bun test`). To recreate the test DB from scratch:
```
psql -h localhost -d postgres -c "CREATE DATABASE sparks_test;"
cd packages/db && DATABASE_URL=postgresql://localhost:5432/sparks_test bun apply-migrations.ts
psql -h localhost -d sparks_test -c "CREATE TABLE IF NOT EXISTS readings_default PARTITION OF readings DEFAULT;"
```
The `readings_default` partition is required locally: `readings` is RANGE-partitioned and the migrations only create current/next-month partitions, so without a DEFAULT partition any test inserting readings outside that window fails with `ExecFindPartition`. A disposable Neon branch also works but is ~250× slower (remote latency; the full suite takes minutes and flakes on Bun's default 5 s timeout) — prefer local.

---

## ✅ R0 baseline — COMPLETE (verified 2026-07-03)

Harness wired (`test` scripts in root + `apps/server` `package.json` + `turbo.json`; local `sparks_test` DB). Results on a clean local DB:

- **`tsc --noEmit`:** clean for both apps.
- **Biome lint:** **43 errors** (quality only — `noExplicitAny`, button `type`, `useNumberNamespace`, exhaustive-deps). Not blocking; chip away opportunistically, do not mass-refactor.
- **Tests:** **137 pass / 0 fail across 10 files in ~7.6 s** locally. (On the Neon branch the same suite was flaky and took >9 min — a false "1 fail" in `routers` and a `workers` timeout were both remote-latency/contamination artifacts, not code bugs.)

**Caveats the green suite hides — these are load-bearing for later phases:**
1. **False greens (unreachable code):** `ingestion.test.ts` (9 pass) and `reports.test.ts` (8 pass) call module functions **directly**, but in the running app ingestion is a 501 stub and `generateReportPdf` is never invoked by any procedure. Green here proves the functions work in isolation, **not** that the feature is reachable. **R3** and **R6** must re-point/extend these tests to hit the *mounted route / reachable procedure*, and add a test that fails if the wiring is absent.
2. **Pricing tests don't cover the bug:** `tariffs.test.ts` is 19/0 green **despite** `priceUsage` silently pricing all TOU/seasonal/block rates as 0 — because the tests only use flat `all/all` tariffs. **R4** must add TOU/season/block cases; do not trust the existing green.
3. **Baseline is behavior — not correctness.** These 137 tests encode current behavior, including the bugs the audit found. Passing them is necessary (R1 must not regress them) but not sufficient; each spine phase adds the missing correctness tests.

---

## 📍 Status ledger & session handoff (updated 2026-07-06)

**Spine progress (the phase prompts below are unchanged; this is their live status):**
- **R0 ✅** baseline (2026-07-03).
- **R1 ✅** oRPC transport in place — real `appRouter` in `apps/server/src/router.orpc.ts` via `proc()` adapter (`orpc.ts`); typed client in `packages/api`; web calls `client.<ns>.<proc>()`.
- **R2 ✅** auth/org/RBAC — better-auth organization plugin enabled (`auth.ts`); layered `requireSession → requireOrg → requireSiteAccess → requirePlatformOperator` (`middleware.ts`).
- **R3 ✅ (verified end-to-end 2026-07-05)** — ingestion mounted (`/ingest/*`, `/device/*`), **HMAC body auth** (server recomputes `HMAC-SHA256(key = stored api_key_hash = sha256(deviceKey), body)`, constant-time compare), real `/device/commission` (one-time provisioning token → issue key, store only hash, one-time via status flip), inline `aggregateDemandIntervals + detectDataGaps` after ingest. Tests re-pointed to the mounted route + a regression test that fails if `/ingest/*` is unmounted. Smoke proven: commission → signed POST → readings → demand_intervals → dashboard shows non-zero.
  - **New read endpoint added (in-spec §4.1):** `demand.listIntervals(siteId, from?, to?)` — read-only, feeds the consumption chart. Trailing-24h default.
- **R4 ✅ (verified 2026-07-06)** — `priceUsage` (`apps/server/src/tariffs.ts`) rewritten so ALL season (high/low) + touPeriod (peak/standard/offpeak) rates apply and `blockThresholdKwh` inclining-block tiers work. Pure (no DB/clock; time comes in via `UsageData`). Active energy is bucketed per interval into (season, TOU-band) via a documented `TouSchedule` (`highSeasonMonths` default SA Jun–Aug; `weekday`/`weekend` hour→band maps; local hour/month resolved with `Intl` in the passed `timezone`) and priced by the most-specific matching rate; block tariffs tier the total; demand/reactive/fixed/ancillary are scalar charges applied per season-present rate. Integer cents, `Math.round` once per line. **150 tests pass** (+4 hand-computed: TOU split, seasonal high/low, seasonal-demand selection, inclining-block); existing 19 flat/all cases unchanged. `UsageData` gained optional `intervalStarts`/`intervalActiveKwh`/`timezone` (backward-compatible; reconciliation caller untouched).
  - **⚠️ R5 WIRING CAVEAT (honest report):** the pure function is correct, but the running reconciliation (`reconciliation.ts` builds `UsageData` from only aggregate `activeKwh`, no `intervalStarts`) still collapses to a single all/all bucket — so **flat and block tariffs price correctly end-to-end now, but TOU/seasonal tariffs will still yield 0 for their bands until R5 feeds period-scoped per-interval energy + the site timezone into `priceUsage`.** That wiring is explicitly R5's scope ("Reuse the R4-fixed priceUsage"), not R4's. Do it there.
- **R5 ✅ (verified 2026-07-06)** — reconciliation correctness (`routers.ts` `reconciliationGenerate` + `reconciliation.ts`). (1) **data_gaps period-scoped** — filtered to gaps whose `gapStart` is inside `[period_start, period_end)` honoring `boundary_inclusivity` (was siteId-only, so every historical gap inflated the flag); helper `instantInPeriod` shared with the interval filter. (2) **Effective-dated tariffs** — new `priceRoleOverPeriod` selects the `siteTariffAssignments` overlapping the period, attributes each interval to the assignment effective at its start, and prices each slice under its own profile (period crossing a tariff change is split + summed via new pure `priceSegments`/`emptyBreakdown` in `reconciliation.ts`); stored FK = profile effective at period start. (3) **Locked-invoice guard on generate** — refuses unless `invoice.status === "locked"` (finalize already had it). (4) **R4 carry-over wired** — per-interval `intervalStarts`/`intervalActiveKwh` + site `timezone` now flow into `priceUsage`, so TOU/seasonal pricing takes effect end-to-end. `generateReconciliation` refactored to take precomputed `PricingBreakdown`s. **153 tests pass** (+3: gap out-of-period exclusion, effective-date split with hand-computed R13,300 total, inclusive-vs-half-open edge interval; the misnamed e2e "rejects reconciliation without locked invoice" was corrected to assert generate now throws). Concrete `billing_periods` snapshot (period bounds/inclusivity/interval minutes) still read authoritatively — not regressed.
- **R6 ✅ (verified 2026-07-06)** — sealed-PDF report worker now reachable end-to-end. New **`reconciliation.generatePdf(reconId)`** oRPC procedure (site-access guarded, `router.orpc.ts`) runs `generateReportPdf` (workers.ts) which renders → hashes → **persists bytes** → versions (never overwrites) → audit-logs → keeps the attorney-seal guard. New **`storage.ts`** object store: **filesystem backend by default** (honest, verifiable — bytes actually written under `<tmpdir>/sparks-report-storage`), S3/R2 documented and **fails loudly** if `STORAGE_BACKEND=s3` without the client. `report.getPdf` now returns a **real short-lived signed URL** (HMAC capability token) served by a new **`GET /reports/file`** Hono route (verifies token+expiry, streams the PDF); the fake `r2.example.com` URL is gone. Web reconciliation-detail **Download button wired to generate-then-download**. **158 tests pass** (+5: bytes-hash-match, procedure e2e, refuse-before-gen, outsider-denied, and the full signed-URL HTTP download with tamper rejection). **The evidence spine now conducts end-to-end: device → readings → intervals → reconciliation → sealed PDF whose sha256 matches the stored `pdf_hash`.**
  - **⚠️ PROD STORAGE NOTE:** the filesystem backend is dev/test-grade (bytes live in tmpdir, not shared across hosts). Production must set `STORAGE_BACKEND=s3` + wire an S3/R2 client (currently throws by design) and a durable bucket; the signed-URL route can then 302 to the bucket's presigned URL instead of streaming.
- **R7–R9** unchanged (pending) — these are consumer features (fleet dashboard, notifications, mobile), not part of the money/evidence critical path, which is now COMPLETE through R6.

**Baseline is now 146 tests green** (was 137; +2 demand.listIntervals, +6 rewritten ingestion route tests, +1 "non-operator denied site creation", minus false-green churn). Both apps `tsc --noEmit` clean.

**Parallel UI track (product-owner directed, OUTSIDE the linear spine — deliberate detour):**
- Product framing confirmed: **private metering & dispute resolution, South Africa** (site timezone/interval default to Africa/Johannesburg / 30 min; not asked at site creation).
- **Phase A (done, then superseded):** a full shadcn/ui + Tailwind + Recharts redesign — dark app-shell (sidebar/topbar), redesigned Overview + Site Dashboard, `?`-tooltips on every metric, **consumption chart defaulting to kWh** with a dropdown (kWh/kW/kVA/kVArh), **Site Settings** page (edit site details + **billing period** via `billing.policies.set` + demand interval), simplified create-site form. All screens migrated off legacy CSS.
- **Phase B (✅ COMPLETE 2026-07-06 — every screen migrated, Tailwind/shadcn fully removed; see the "ASTRYX MIGRATION COMPLETE" + "TAILWIND + SHADCN REMOVED" entries in the invoice/reconciliation section below for the finishing work): migrate the UI to _Astryx_** (`@astryxdesign/core` — Meta's open-source design system, `github.com/facebook/astryx`; **requires React 19**). Done so far: **upgraded Next 14→15, React 18→19**; installed `@astryxdesign/core` + `@astryxdesign/theme-neutral` + `@astryxdesign/cli`; wired `Theme`/`LinkProvider`/`MediaTheme mode="light"` (`app/providers.tsx`) + the 3 CSS imports in `globals.css`; **converted the login screen**; **(2026-07-06) rebuilt the app shell on Astryx** — `components/app-chrome/{AppChrome,Sidebar,Topbar}.tsx` now use `AppShell`/`SideNav`/`TopNav`/`MobileNav` (shared `NavSections` feeds both desktop SideNav + mobile drawer; user menu via `DropdownMenu`); **converted the Overview dashboard** (`app/dashboard/page.tsx` → `Grid`+`ClickableCard`+`EmptyState`). All verified: `tsc` clean, SSR renders Astryx classes, HTTP 200, no module/runtime errors. **Get component APIs from the CLI, don't guess:** `node node_modules/@astryxdesign/core/docs.mjs <Name>` (or `--list`); for sub-component prop tables the CLI prints `undefined`, so read the `.d.ts` in `node_modules/@astryxdesign/core/dist/<Name>/`. Import paths are per-component subpaths, e.g. `@astryxdesign/core/SideNav`. **(2026-07-06, cont.) converted the Site Dashboard** (`app/sites/[siteId]/page.tsx` → `Card`+`Grid`+`Table`+`Banner`) plus its two helpers `components/metric.tsx` (`Text`+`Tooltip` for the `?` glossary hints) and `components/charts/ConsumptionChart.tsx` (kept Recharts; shadcn `Select`→Astryx `Selector`, Tailwind wrappers→`Stack`+inline styles). **Verified end-to-end in the browser** (signed up a throwaway user, created an org via `POST /api/auth/organization/create` + a site via `POST /rpc/sites/create` with body `{json:input}`, then loaded the pages): shell + Overview + Site Dashboard all render, `Selector` metric-switch works, no console errors. **(2026-07-06, cont.) converted the auth screens** — `AuthShell` (shared branded shell) + `signup` + `org-selector` now Astryx (`TextInput`/`Banner`/`ClickableCard`). Verified in-browser: both render correctly, signup creates user+org end-to-end (the migrated Astryx form's submit fires; only the automated post-submit redirect doesn't complete under preview — a real user is fine), org-selector lists memberships as `ClickableCard` rows.
  - **★ ROOT-CAUSE FIX for the whole Astryx-vs-Tailwind conflict (`tailwind.config.ts`: `corePlugins:{preflight:false}`):** Astryx ships its CSS in cascade **layers** (`reset`, `astryx-base`, `astryx-theme`); Tailwind's Preflight is **unlayered**; unlayered CSS always beats layered — so Preflight's `*{border-width:0}` and `button/input{background:transparent}` were silently stripping borders off Astryx inputs and backgrounds off native `<button>` controls (invisible fields, black-on-black buttons). `<a>`-rendered buttons escaped because Tailwind doesn't reset anchors — which is why the earlier symptom looked button-text-specific. Astryx ships a Preflight-grade `reset.css` (already imported), so disabling Tailwind Preflight is safe: **verified** the still-shadcn screens (sites/new) are unregressed, and all Astryx form controls now render correctly. This **superseded and removed** the earlier `.astryx-button` colour shim. **Any future Astryx breakage that looks like "Tailwind is winning" is this layered-vs-unlayered rule — check it first.** (For the current remaining-screens list + next steps see the **"➡️ NEXT (new chat starts here)"** marker further down — it is the authoritative status.) **Automation note:** shadcn/controlled forms don't submit under preview automation (controlled-input state doesn't pick up programmatic value-sets) — seed data via API instead (`POST /api/auth/sign-up/email`, `/api/auth/organization/create`, `POST /rpc/sites/create` with body `{json:input}`).
- **User-flow map captured** (be exhaustive when building): roles = **Astryx-internal operator** (installs meter, commissions device, creates the account + sites) vs **Customer/org-owner** (gets credentials, sets password via emailed link, sees only their sites) vs **Site Manager** (site-scoped, invitable). Onboarding = install → we create account → password-reset email → we add sites. **Single site → open it directly; multiple → Overview grid.** Settings must include contact details, tariffs, notification prefs. Graphs: **default kWh**, dropdown for the rest.

**Infra / dependency gotchas (bit us this session — read before reinstalling):**
- `apps/server` now **declares** `drizzle-orm`, `zod` (**^3.25 — server uses zod v3**; oRPC + better-auth carry their own v4), and `@hono/node-server`. These were imported but undeclared and only resolved via bun hoisting; a clean `node_modules` nuke exposed it. Do NOT bump server zod to v4 (breaks `z.record(z.any())` + the oRPC adapter).
- Root `package.json` has `overrides` pinning `@types/react`/`@types/react-dom` to 19 (avoids duplicate-React-types JSX errors after the React 19 upgrade).
- `next.config.cjs` → **`next.config.mjs`** (Next 15 dropped `.cjs`); `experimental.serverComponentsExternalPackages` → top-level `serverExternalPackages`.
- Bar after any dependency change: both apps `tsc` green **and** `cd apps/server && NODE_ENV=test bun test` = 146 pass.

**Neon vs local DB drift (dev server uses NEON; tests use local `sparks_test`):**
- Applied `0002_platform_operator.sql` to **Neon** (was the sign-up 500: missing `is_platform_operator`). All seven better-auth tables now **match** local. **Non-auth tables (ingestion/demand/etc.) may still be behind** — the early migrations aren't idempotent, so sync by **diffing local↔Neon and applying targeted patches**, not a blind re-run. Reaching Neon from tooling needs the sandbox network path.
- **Sign-up 403 fixed:** a stale `x-organization-id` in `localStorage` (from prior testing) made `requireSession → requireMembership` reject a brand-new user → `createOrganization` 403. Fix = `clearSelectedOrganization()` before the createOrganization call in signup.

**ROLE MODEL (product-owner confirmed 2026-07-06) — now being enforced:** **Sparks (platform operator, internal)** creates the customer's account + org, **provisions sites**, and controls how many sites an org has; installs/commissions meters. **Customer / org-owner** gets an account created *for* them → password-reset email → sets password → logs in → **views** their sites and **invites people by email to view specific sites**; they **cannot add sites**. **Site Manager** = invited by the org-owner, site-scoped (only the sites they're invited to). Onboarding is operator-driven, NOT customer self-signup.

**Onboarding/invites build (IN PROGRESS, product-owner directed — takes priority; chosen over finishing the screen migration):**
- **Slice 1 ✅ (done + verified 2026-07-06):** permission lockdown. `sites.create` + `sites.delete` now require `requirePlatformOperator` (`routers.ts`); removed the customer's add-site UI from the Overview (`app/dashboard/page.tsx` — empty state now says "contact Sparks"). Tests updated (146 pass; added a "non-operator org owner denied site creation" case, seeds an `isPlatformOperator` user). Runtime-verified: org-owner `POST /rpc/sites/create` → 403. `sites.update` stays org-owner (customers still edit site settings).
- **Slice 2 ✅ + Slice 3 (email) ✅ (done + verified 2026-07-06):** operator provisioning + onboarding email.
  - **Operator surface** = new **`/admin`** page (`app/admin/page.tsx`), gated by `admin.listOrganizations` (operator-only); shows a "Provision a customer" form + "Add a site to an org" form + an orgs table (name/owner/site-count). Sidebar shows an "Operator admin" link only when `session.me().isPlatformOperator` (added that field to `sessionMe`). Nav via `useOrganization().isPlatformOperator`.
  - **Backend** (`admin.ts`): `admin.createCustomer` (operator-gated) creates the customer user (`auth.api.signUpEmail` with a throwaway password) + the org **owned by the customer** (direct `organization`+`member` insert — the plugin would own it to the acting operator) + triggers `auth.api.requestPasswordReset`; `admin.listOrganizations`. Wired in `router.orpc.ts` under `admin.*`.
  - **Email** (`email.ts` + `auth.ts` `sendResetPassword`): Resend, key read lazily; missing-key → logs instead of throwing. **`.env` now loaded** via `import "dotenv/config"` at the top of `index.ts` (tsx/Node doesn't auto-load `.env`; dotenv doesn't override the launch-config inline vars). Web **set-password page** at `/auth/set-password?token=…` (`POST /api/auth/reset-password`).
  - **Verified end-to-end:** server `tsc` clean + **146 tests pass**; `POST /rpc/admin/createCustomer` → 200 (user+org+owner created); `/admin` renders for an operator and is FORBIDDEN-gated for non-operators; nav link operator-only; **full onboarding chain proven:** `reset-password` with a live token → 200, then customer sign-in with the new password → 200.
  - **Dev aids added:** (1) `sendResetPassword` (auth.ts) **logs the set-password link to the backend console** in non-production (`[onboarding] set-password link for <email>: …`) so onboarding is testable without email delivery. (2) **`apps/server/scripts/make-operator.ts`** — run `bun scripts/make-operator.ts <email>` (loads `.env`, same Neon DB the app uses) to grant `is_platform_operator` (input:false — never client-settable; sign the user up first).
  - **RESEND caveat:** the key (`apps/server/.env`) works but Resend is in **test mode** — it only delivers to the account owner's own email until a **domain is verified at resend.com/domains + `EMAIL_FROM` set to it**; sends to other recipients are rejected (better-auth runs `sendResetPassword` as a swallowed background task, so provisioning still succeeds — the console link is the reliable dev path).
  - **Manual test recipe:** sign up with your email → `bun scripts/make-operator.ts your@email` → log in (see "Operator admin" in sidebar) → `/admin` provision a customer → grab the set-password link from the backend console → open in incognito → set password → log in as the customer (dashboard has **no add-site**, empty state says "contact Sparks") → back as operator, `/admin` → add a site to their org → customer sees it.
- **Slice 4 (site-scoped invites) ✅ (done + verified 2026-07-06):** org-owner invites by email to a specific site → invitee accepts → becomes an org `member` (non-owner) + gets a `site_access` grant. **New `site_invitations` table** (`packages/db/src/schema.ts` + migration `0003_site_invitations.sql`, applied to local `sparks_test`; **apply to Neon before using the dev `backend` config**). **Procedures** (`routers.ts`, `siteInvites.*`): `create` (site-owner/org-owner guarded, tokenized, 7-day expiry, emails an accept link + logs it in dev), `list`, `cancel`, `accept` (session-guarded; email must match the invite; idempotent membership + site_access upsert). Registered under `siteInvites` in `router.orpc.ts`. `sessionMe` now returns `orgRole` (+ `useOrganization().isOrgOwner`). **Web:** `components/team-access.tsx` "Team & access" card on Site Settings (org-owner only) + `/invite/accept?token=…` page (`AuthShell`, bare route); `login`/`signup` honor a `?next=` redirect. **Email:** `sendEmail` now no-ops under `NODE_ENV=test` (was making real Resend calls in the suite); invite send is fire-and-forget with a `.catch`. **6 new tests** (create/accept→member+grant/email-mismatch denied/expired/non-owner denied/list+cancel); **164 tests pass**, both apps `tsc` clean. Resend still test-mode-restricted → the console `[invite] site-access link…` is the reliable dev path.
  - **Still TODO (minor):** gate/redirect `/auth/signup` now that `/admin` is the operator provisioning path (self-signup still creates a personal org).

**Product-owner notes / quick fixes done (2026-07-06, verified):**
- **Demand interval** widened to **15/30/45/60** min (`validators.ts` both unions; `settings` dropdown; `metric.tsx` tooltip). 146 tests still pass.
- **Fleet** nav item **removed** from the sidebar (`components/app-chrome/Sidebar.tsx`) — nav is now Overview + (operator) Operator admin + Alerts(Soon).
- **Content centered:** `AppChrome` wraps children in `maxWidth 1160 + marginInline auto`; removed per-page `maxWidth`. Verified equal gaps at 1440px.
- **Site dashboard live polling:** `readings.latest`/`monthToDate`/`demand.listIntervals` refetch every **30s** via a `tick` dep (`app/sites/[siteId]/page.tsx`).

**Invoice/reconciliation "working" — DIRECTION (product owner): finish the migration correctly first, then deeper features as focused follow-ups.**
- **Done + verified:** invoices **LIST** (`app/sites/[siteId]/invoices/page.tsx`) + reconciliation **LIST** (`.../reconciliation/page.tsx`) migrated to Astryx (`Card`/`Table`/`Selector`/`Badge`/`Banner`); both render, no console errors, `tsc` clean.
- **★ ASTRYX MIGRATION COMPLETE (2026-07-06, verified end-to-end):** the last four screens are now Astryx — invoices **detail** (`invoices/[invoiceId]/page.tsx`), reconciliation **detail** (`reconciliation/[reconId]/page.tsx`), **settings** (`settings/page.tsx`), **sites/new** (`sites/new/page.tsx`). Patterns used: `Card padding={5}` + `Stack`/`Grid`/`Table`/`Selector`/`NumberInput`/`TextInput`/`Banner`/`Divider`/`Badge`; back-link header = `Link`+`Heading` (same as the list pages, no more `PageHeader`). Gotchas hit: Astryx `Table` needs `data: Record<string,unknown>[]` → row row-types must be **`type` aliases, not `interface`** (interfaces lack the implicit index signature); NumberInput integer prop is **`isIntegerOnly`** (not `isInteger`); `Banner` supports a `description` prop for the secondary line.
- **★ TAILWIND + SHADCN REMOVED (2026-07-06):** deleted `components/ui/*`, `components/PageHeader.tsx`, `lib/utils.ts` (the `cn` helper), `tailwind.config.ts`, `postcss.config.mjs`; stripped the `@tailwind` directives + shadcn token `:root` block from `globals.css` (kept the 3 Astryx CSS imports, a minimal `body` background/font rule, and the Recharts tooltip overrides with literal hex/hsl values); dropped the transitional `TooltipProvider` from `AppChrome` (no shadcn Tooltip left); migrated the last two `className` users (`app/page.tsx` loading screen + `app/layout.tsx` body) to inline styles. Removed now-unused deps from `apps/web/package.json`: `tailwindcss`, `tailwindcss-animate`, `autoprefixer`, `postcss`, `class-variance-authority`, `clsx`, `tailwind-merge`, and all 5 `@radix-ui/*` packages (kept `@stylexjs/stylex` — Astryx-adjacent). **The whole UI is now on one design system (Astryx).** Verified: `bun install` clean, both apps `tsc --noEmit` clean, **146 tests pass**, dev server compiles every page, and in-browser (operator-seeded user+org+site) settings/sites/new render fully with real data + bordered inputs, invoice-detail & recon-detail modules render (not-found branch), **zero console errors** on every screen.
- **Deferred correctness follow-ups (flag numbers as untrustworthy until done):** (a) **real invoice file upload + wire `parseInvoiceWithClaude` ✅ (2026-07-06)** — new **`invoices.uploadAndParse`** procedure (site-access guarded) accepts the PDF (base64 from the web file input), stores it via `storage.ts`, runs `parseInvoiceWithClaude` + `persistParsedInvoice` → `parsed_pending_confirm`; web Invoices upload form now has a file picker. **Storage is R2-backed** (`storage.ts` auto-detects `R2_*` env; S3-compatible Cloudflare R2 for both invoice PDFs and sealed reports; falls back to filesystem when R2 env absent; tests forced to fs). Added `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`. Uses `ANTHROPIC_API_KEY` (parser) + `R2_*` (storage). Verify live with a real PDF + keys (tsc/tests green on the fs fallback; the R2/Claude calls only run against real creds). **Parser accuracy pass (2026-07-06):** default model → **`claude-sonnet-5`** (override `INVOICE_PARSE_MODEL`, e.g. `claude-opus-4-8`); `max_tokens` 2048→8192 (was truncating real multi-line bills → invalid JSON → 500); the model now returns amounts **in Rand exactly as printed** and the **Rand→cents conversion happens in code** (deterministic `Math.round(rand*100)`) instead of asking the LLM to output cents — that silent unit conversion was the main source of wrong numbers; prompt reworked (verbatim extraction, no forced balancing, SA number formats + credits, read the amount column, pick the current-charges total). Verified live: exact cents on a known invoice. **Canonical grouping (2026-07-06):** the parser now emits a per-line canonical schema — `utility` (electricity/water/sanitation/vat/…), `supplyGroup` (tenant/common/central_aircon), `unit`, `quantity`, `rate` (stated or derived = amount÷qty), and a `component` **derived deterministically from the physical unit** (kWh→active_energy, kVA→demand, kVArh→reactive, Gen kWh→generation, kl→volume, basic→service_fixed) so grouping survives ANY landlord's format (verified identical grouping on two structurally-different real bills: PEC/Waterfall and Metronomic/Mall-of-the-South — group subtotals matched each bill exactly, e.g. electricity/tenant = R65,200.26). New columns on `invoice_line_items` (migration `0004_line_item_grouping.sql`, applied local+Neon). New web `components/invoice-review.tsx` renders the grouped review: the **electricity-tenant slice is the reconcilable base** (priced), everything else (water/sanitation/other supply groups) shown-but-excluded with reasons, VAT separate; confirm sets `confirmedTotalCents` = the electricity-tenant subtotal (correct reconciliation base). Helpers `normalizeComponent`/`deriveLineCategory` are pure + unit-tested (167 tests). **★ BUG FIXED:** Sonnet 5 returns a `thinking` block first, so `response.content[0]` was the thinking block → the parser threw "Unexpected response type"; now finds the text block. **Text-layer extraction (2026-07-06):** `parseInvoiceWithClaude` now runs **poppler `pdftotext -layout`** first and sends the exact embedded text (no visual misreads, cheaper) — falling back automatically to PDF-vision when there's no text layer (a scan) or poppler is absent (graceful null, verified). Needs `brew install poppler` locally / `poppler-utils` on a deploy host; logs `[invoice-parse] source=text|pdf`. **Speed/model tuning (2026-07-06):** extended thinking **disabled** for the parse (it's transcription, not reasoning — thinking ate the token budget → truncated big bills into invalid JSON → 500, and was slow); `max_tokens` 8192→16000. **Adaptive model:** clean text layer → **Haiku 4.5** (verified exact reconcilable total, ~35% faster: 18s vs 27s on the 45-line Mall-of-the-South bill); vision fallback (scans) → **Sonnet 5** (stronger reader). `INVOICE_PARSE_MODEL` overrides both; (b) **R4 money-math ✅ + R5 wiring ✅ (2026-07-06)** — `priceUsage` prices TOU/seasonal/block correctly AND the reconciliation caller now feeds per-interval energy + timezone, so all tariff shapes price end-to-end (153 tests); (c) **R6 sealed PDF ✅ (2026-07-06)** — `reconciliation.generatePdf` + `report.getPdf` produce, persist, and serve a real signed sealed PDF (158 tests); prod must swap the filesystem store for S3/R2 (`STORAGE_BACKEND=s3`).

**★ INVOICE REVIEW & QA OVERHAUL — product-owner agreed 2026-07-06 (THE ACTIVE NEXT BUILD, do this first in the new chat).** Feedback after testing the grouped parse: the grouping is an LLM guess and gets things wrong, the flow has too many steps, and the numbers aren't transparent. Agreed direction, in priority order:
  1. **Editable grouping in review (biggest accuracy win).** Every parsed line must be re-assignable in review — **utility + supplyGroup + component + amount** — so a line the parser dropped into "water"/"central_aircon" (the gray, excluded rows) can be **pulled up into electricity/tenant**, and the **reconcilable base recomputes live** as lines move. The grouping is a suggestion; the user is the authority. (Today `invoice-review.tsx` only lets you change the coarse category, not the group.)
  2. **Collapse confirm → lock → reconcile into ONE action: "Confirm & reconcile."** It saves confirmed numbers, freezes them (lock = internal/invisible, NOT a user chore), generates the reconciliation, and lands on the report. Add an explicit **"Reopen"** to un-freeze + regenerate. **Keep the freeze point** (auto, invisible) — a legal doc needs "these were the numbers at reconciliation time" — just don't make the user do it.
  3. **Deterministic validation guards (LLM = draft only).** Surface real, computed checks — NOT LLM confidence:
     - arithmetic: parsed line items sum to the invoice's stated grand total (tolerance) → else "may have missed/duplicated a line";
     - line cross-check: `quantity × rate ≈ amount` on lines with all three → flags a mis-read number on that exact line;
     - total cross-check: parser's stated total vs summed lines → divergence = missed line;
     - unit-vs-classification: unit implies electricity (kWh/kVA) but tagged water/other → flag.
     These drive the "to review" flags. **★ DROP LLM-confidence-based gating/flagging entirely — product owner: "that's a fugazzi"** (uncalibrated, unreliable). Stop using `confidence` as a trust/gating signal; the deterministic checks replace it.
  4. **Human review — user button + background QA queue.** User-facing: a prominent banner + **"Send to Sparks for review"** button on the review screen. Internal: **every** invoice (esp. the first ones) auto-queued for Sparks QA. Model: Confirm → reconciliation generates immediately (user sees numbers right away) but marked **"provisional — under review"**; it lands in a Sparks QA queue (`/admin` review list); on operator sign-off → **"verified"** and the **sealed dispute PDF unlocks**. So the gate on the *legal* output is Sparks QA sign-off, not a user step. Needs an invoice/recon `review_status` (provisional|reviewed|flagged) + the admin queue + provisional→verified gating on `reconciliation.generatePdf`.
  5. **Transparency — "show the working."** No number-from-nowhere: reconcilable total = "sum of these N tenant-electricity lines"; each expected figure = "measured X kWh × tariff rate Y = Z"; discrepancy inputs visible. One expand away.
  Rationale for the whole thing: LLMs mis-parse PDFs, so trust comes from (a) letting the human fix the grouping freely, (b) deterministic cross-checks, and (c) a human QA backstop — never from the model's self-assessment.

**★★ INVOICE REVIEW & QA OVERHAUL — ✅ BUILT + VERIFIED 2026-07-06 (all 5 parts).** Migration `0005_invoice_review_qa.sql` (applied local + Neon): `invoice_line_items.confirmed_utility/supply_group/component`, `reconciliations.review_status`(provisional|reviewed|flagged)`/reviewed_by_user_id/reviewed_at/review_note`, `landlord_invoices.review_requested_at`. Schema mirrored in `packages/db/src/schema.ts` (text cols, no enum).
  1. **Editable grouping** — `components/invoice-review.tsx` fully rewritten: every parsed line re-assignable by **utility + supplyGroup + component + amount** (Astryx `Selector`s + inline amount input); the reconcilable base (electricity/tenant, bucketed active/demand/reactive/fixed) **recomputes live** via `useMemo`. Confidence-based UI **removed** (ReviewLine dropped `category`/`confidence`).
     - **↳ SIMPLIFIED 2026-07-06 (product-owner): the CUSTOMER review screen is now read-only + send-only.** No editable selectors/amounts, no "Confirm & reconcile" button. It shows just the blue **Reconcilable total** card with an **arrow/chevron dropdown** that expands the per-line + per-component working; an AI-mistakes **disclaimer** ("a Sparks professional will review your bill and get back to you"); an **optional note**; and one action: **"Send to Sparks for review"** (calls `confirmReconcile` with the parser's grouping as-is → provisional recon, then `requestReview`). The invoice-side deterministic guard banners were dropped from the customer view. Grouping correction now lives on the Sparks/admin side (the parser's grouping is the starting point Sparks verifies). `invoice-review.tsx` props are now `{lines, onSend, sendLoading}`.
  2. **One-click "Confirm & reconcile"** — new `invoices.confirmReconcile` (`routers.ts`) persists the confirmed grouping per line, derives the buckets, **locks the invoice (invisible freeze point) + generates the recon in one call**, returns `{reconId, version, reconcilableTotalCents}` and the web lands on the report. `runReconciliationForPeriod` extracted from `reconciliationGenerate` (shared core, computes next **version** so regen never overwrites). Explicit **`invoices.reopen`** un-freezes (status→parsed_pending_confirm) so a corrected grouping regenerates as v2.
  3. **Deterministic guards (LLM-confidence GONE)** — computed in `invoice-review.tsx`: line-sum vs the invoice's stated grand total (from `parsedRaw.totalCents`, R1 tolerance), per-line `quantity×rate≈amount`, and unit-vs-classification (kWh/kVA grouped as non-electricity). Surfaced as `Banner`s + per-row warning icons.
  4. **Send-to-Sparks + QA queue + provisional gating** — `invoices.requestReview` (records `review_requested_at` + note) wired to the review screen's "Send to Sparks" button. New operator procedures `admin.listReviewQueue` (provisional+flagged, customer-requested first) and `admin.reviewReconciliation(reconId, reviewed|flagged, note)` (`admin.ts`); **`/admin` gained a "Reconciliation QA queue"** card (verify/flag/open per row). **`reconciliation.generatePdf` now refuses unless `review_status==='reviewed'`** — the sealed dispute PDF only unlocks on Sparks sign-off. Recon detail page shows a provisional/flagged/verified banner + badge and **disables Download until verified**.
  5. **Show-the-working** — review screen's reconcilable base has a "Show the working — N tenant-electricity lines" expander (per-line + per-component breakdown); recon detail keeps the charge-by-charge comparison (measured × tariff = expected).
  - **Tests:** `src/__tests__/invoice-review-qa.test.ts` (+5: edited grouping drives base + locks + provisional; water stays excluded; PDF gated → operator sign-off unlocks + queue add/remove + non-operator denied; customer request prioritised; reopen→v2). `reports.test.ts` updated for the new gate (+1 "refuses provisional", sign-off before the two seal tests). **175 tests pass**, both apps `tsc --noEmit` clean. **NOTE for next session: re-running `apply-migrations.ts` recreates the partitioned `readings` table — re-run `CREATE TABLE IF NOT EXISTS readings_default PARTITION OF readings DEFAULT;` on `sparks_test` or the ingestion/aggregation tests fail with "no partition found".**

**★★ TIERED SITE ACCESS — ✅ BUILT + VERIFIED 2026-07-07.** Migration `0007_site_access_levels.sql` (local + Neon): `site_access.role` + `site_invitations.role` converted **enum→text**, legacy normalised (`owner`→`site_admin`, `site_manager`→`editor`). Per-site levels **viewer < editor < site_admin**; **org owner** (member.role=owner) sits above all, plural, and an org can never be left ownerless.
  - **Middleware** (`middleware.ts`): `normalizeSiteLevel`, `LEVEL_RANK`, `requireSiteAccess(minLevel?)` (returns the caller's effective `level`), `requireSiteEditor`, `requireSiteAdmin`. `SiteAccessContext.level` added.
  - **Enforcement:** every invoice/recon **mutation + the sealed-PDF download/`report.getPdf`** now `requireSiteEditor`; **site-access + invite management** (`siteAccessGrant/revoke`, `siteInvitesCreate/cancel/list`) `requireSiteAdmin`; reads stay viewer+. `sites.get` returns `myLevel` so the UI can gate controls.
  - **Owners:** `assertNotLastOwner` guard on `orgSetMemberRole` (demote) + new `org.removeMember` (removes membership + the org's site grants). Owners promote/demote/remove via the plugin.
  - **UI:** rebuilt `components/team-access.tsx` (invite at viewer/editor/site_admin + manage existing grants: change level / remove; visible to site_admin+ via `myLevel`); new `components/org-members.tsx` (org-owner: make owner / step down / remove, last owner protected); both on Site Settings. Act buttons **level-gated**: Upload (invoices list), Send-to-Sparks (invoice detail, `InvoiceReview canSend`), sealed-PDF Download (recon detail), Reopen — viewers see "View only". `siteAccessList` now returns emails.
  - **Tests:** `site-access-levels.test.ts` (+5: viewer read-only vs editor act, only site_admin manages, legacy normalization, no-access denied, last-owner guard); updated `routers.test.ts` + `site-invites.test.ts` for the new level literals. **182 tests pass**, both apps `tsc` clean, routes compile.
  - **Organization tab (2026-07-07):** new **owner-only `/organization`** sidebar item (`Building` icon, gated on `isOrgOwner`). Consolidates people management org-wide: invite (email + site + level), and per-person their org role (owner/member) + **per-site privileges** (site + level selector to change, remove, add-access). Backed by one read proc `org.accessOverview` (owner-guarded → `{members, sites, grants}`); mutations reuse `siteAccess.grant/revoke` + `org.setMemberRole/removeMember` (org owner passes all guards). `org-members.tsx` deleted (superseded); Site Settings keeps only the per-site `TeamAccess` card (for site admins).
  - **Org-role reconciliation (2026-07-07):** the non-owner org role was inconsistently `operator` (better-auth plugin config / demotion) vs `member` (raw site-invite inserts). Now **`member` everywhere** (`auth.ts` roles `{ owner, member }`, validators `owner|member`, `org-members.tsx` demote → member; migration `0008` normalises legacy `operator` rows). **Security fix:** the old `operator` role carried plugin `organization/member/invitation` write statements — an invited member could have hit the plugin's own `/api/auth/organization/*` endpoints to invite/change members, bypassing our owner guards. The new `member` role has **empty plugin statements** (`ac.newRole({})`); all privilege management flows only through our middleware-guarded procedures.

**★★ NOTIFICATIONS — bill-review email + customer Alerts inbox — ✅ BUILT + VERIFIED 2026-07-07.** Migration `0006_notifications_phone.sql` (local + Neon): `user.phone`, `alert_deliveries.read_at`; bill outcomes reuse the existing `alert_type='invoice_ready'` (severity carries verified vs flagged) to avoid an enum ALTER. Reuses the existing `alerts` + `alert_deliveries` tables (R8 pulled forward).
  - **A — review-request email → Sparks.** `invoices.requestReview` now fires `billReviewRequestEmail` (`email.ts`) to **`SPARKS_REVIEW_EMAIL`** (env; logs if unset): the AI breakdown table (every parsed line + reconcilable total + customer note) with the **original invoice PDF attached** (fetched via `getObject(fileStorageKey)`). `sendEmail` gained `attachments`.
  - **B — customer outcome (in-app + email + SMS).** New `notifications.ts` `dispatchBillOutcome`: resolves recipients (org owner members + site_access grantees), inserts one `alerts` row + per-recipient `alert_deliveries` (app/email/sms), sends the operator's write-up via email (with their optional attachment) and an SMS nudge (`sms.ts`, Twilio-compatible fetch, no-op in dev/test). `admin.reviewReconciliation` now takes **`subject` + `body` + optional `attachmentBase64/Name`** (the operator's "description document"), sets recon status, and dispatches; `reviewed` still unlocks the sealed PDF, `flagged` sends it back. **Admin `/admin` QA queue** rebuilt: "Review & respond" opens a compose panel (subject/body/file → Send as Verified / Flagged).
  - **Alerts inbox.** `alerts.list/unreadCount/acknowledge/markAllRead/attachmentUrl` (recipient-scoped via app-channel `alert_deliveries`, `read_at` state). New **`/alerts`** page (outcome cards: view recon, download attachment, mark read); the sidebar **Alerts** item is now live with an **unread badge** (`alerts.unreadCount`).
  - **Phone capture.** `user.phone` (better-auth additionalField + `profile.setPhone`); optional field on the **set-password** page (stashed in `localStorage` → persisted on first sign-in, since that page ends unauthenticated) and in **Settings → Notifications**. `sessionMe` returns `phone`.
  - **Env:** `SPARKS_REVIEW_EMAIL` (review inbox). **SMS is provider-aware** (`sms.ts`, updated 2026-07-07): `SMS_PROVIDER=clickatell` (configured) uses `SMS_API_KEY` via Clickatell One API (`Authorization: <key>`, POST platform.clickatell.com/messages); `twilio` uses `SMS_ACCOUNT_SID`/`SMS_AUTH_TOKEN`/`SMS_FROM`; `SMS_API_URL` overrides endpoint. All no-op+log without creds or under test. Clickatell path coded to their docs, **not yet live-verified**. **177 tests pass** (+2: outcome→inbox+read-state, profile phone set/clear), both apps `tsc` clean, all routes compile.

**★ LOGO — ✅ 2026-07-06.** The Sparks waveform mark is now a reusable SVG (`components/Logo.tsx`, `currentColor`, single-cycle pulse flat→trough→crest→flat) wired into the login + `AuthShell` header, the desktop sidebar (`SideNavHeading`), the browser tab (`app/icon.svg`), and the **sealed PDF report header** (`reports.ts` brand row). Verified the rendered shape matches the supplied reference.

**Billing period from the invoice ✅ (done + verified 2026-07-06):** the period is no longer a dropdown — it's **read from the invoice** by the parser (`periodStart`/`periodEnd`, extracted from "Reading Cycle"/"Period"/"Start–End"; verified exact on both real bills: Metronomic 23 Apr–22 May, PEC 30 Apr–27 May) and **editable in review** if wrong. `invoicesUploadAndParse` now parses first, then find-or-creates an `invoice_derived` billing period (half-open [start, end+1day)) and links the invoice — no `billingPeriodId` input. New `invoices.setPeriod` corrects it (inclusive dates in, half-open stored). `parseInvoiceWithClaude` refactored to take just the PDF buffer (no pre-existing invoice row). **Reconciliation is now generated from the locked invoice** (the invoice detail's locked state has a "Generate reconciliation" button → recon detail); the period dropdown + generate-form were removed from both the invoice-upload and reconciliation-list pages. 169 tests pass, both apps tsc clean.

**Component-by-component reconciliation ✅ (done + verified 2026-07-06):** the reconciliation now compares the invoice's confirmed per-component charges (active / demand / reactive / fixed) against the tariff-priced expected, not just totals. Pure `buildComponentComparison` (`reconciliation.ts`) → `{charged, expectedLandlord, expectedCeiling, discrepancy}` per component; persisted in the recon `breakdown.components` and also recomputed on read in `reconciliationGet` (so old recons work). Surfaced as a "Charge-by-charge comparison" table on the recon detail page (`reconciliation/[reconId]/page.tsx`) AND in the sealed PDF (`reports.ts`), with over/undercharge colouring. **169 tests pass** (+2 hand-computed comparison cases). Combined with the grouped parser, the dispute output now reads component-by-component from real bills. Remaining deeper feature (optional): the explicit **rate-vs-ceiling and billed-qty-vs-metered-qty** split per component (data is all captured — invoice line `quantity`/`rate` + measured intervals).

**➡️ NEXT (new chat starts here): build the "★ INVOICE REVIEW & QA OVERHAUL" (see that block above) — product-owner-agreed 2026-07-06, top priority. Start with (1) editable grouping in review, then (2) one-click "Confirm & reconcile", (3) deterministic validation guards (NOT confidence — that's dropped), (4) "Send to Sparks" + background QA queue, (5) show-the-working transparency.** Below is the prior status: the money/evidence CRITICAL PATH (R0–R6) is COMPLETE — device → readings → intervals → reconciliation → sealed PDF runs end-to-end and is dispute-trustworthy.** Remaining work is no longer on the critical path; pick by product priority:
  1. **Invoice-upload + parser wiring** (deferred follow-up (a)) — real file upload into object storage + wire `parseInvoiceWithClaude` from a procedure (today line items are inserted directly and `createUpload` only mints a key). Needs an Anthropic API key + the S3/R2 store. This is the last gap to trustworthy numbers from *real* uploaded invoices.
  2. **Slice 4 — site-scoped invites** (org-owner → Site Manager; scaffolding + email template already exist).
  3. **R7 fleet dashboard** → **R8 notifications** → **R9 mobile** (consumer features, each self-contained; see phase prompts below).
Both apps `tsc` clean; **158 tests pass**. Prod deploy needs `STORAGE_BACKEND=s3` + an S3/R2 client (filesystem store is dev/test-grade).
- **Automation note:** Astryx/controlled forms don't submit under preview automation (programmatic value-sets don't update React state → empty-field guards fire); verify procedures via direct `POST /rpc/...` calls instead — the forms work for a real user typing.

---

## Ground rules (the agent must obey these every phase, even though restated per phase)

1. **Stack is fixed:** Bun · Turborepo · Next.js (App Router) · Hono · **oRPC** · better-auth (+ organization plugin) · Postgres/Neon · Drizzle · Biome/Ultracite. Do **not** introduce new frameworks/ORMs/state libraries without explicit instruction.
2. **Sources of truth:** `docs/02_Technical_Architecture.md` for data model / API map / risks; **this file** for sequencing. The root-level `PHASE_*_SUMMARY.md` files are **unreliable** (the audit found several overstated completion) — do **not** treat them as truth; verify every claim against the actual code and a running system.
3. **Types & units:** Money = integer cents (ZAR). Time = `timestamptz` stored UTC; billing/demand alignment uses the site timezone. Energy/power = `numeric`. If reality contradicts `docs/02`, **STOP and report** — do not improvise a redesign.
4. **"Done" means demonstrated, not written.** A phase is complete ONLY when all of: `bun run check` passes · `bunx tsc --noEmit` passes · the phase's tests are actually **run and green** · the feature is shown working in a **runtime smoke** (a real request/response, not just compilation). If any of these is impossible, **STOP and report the blocker** — do not declare done.
5. **No stubs left on a live path.** No `501` / `"Not yet implemented"` / unconditional-throw placeholder may remain on any code path this phase owns. If you cannot finish a task, STOP and report — do not paper over it with a stub.
6. **Honest reporting.** In your summary, explicitly separate **"written"** from **"wired and verified."** List exact files touched. State the single exact next file to touch. If you deviated from `docs/02`, say so and update `docs/02` (or flag it) so the docs stay the source of truth.
7. **No scope creep.** Do not add tables/procedures/routes beyond `docs/02` §3/§4.1 without explicit instruction.

---

## R0 — Test harness & honest baseline (do this first; no product changes)

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: Make the checks and test suite reliably runnable, run them, and produce a truthful pass/fail baseline. NO product-behavior changes.
1. Tests import from "bun:test". Bun is installed (~/.bun/bin/bun). Add a `test` script to apps/server/package.json (`bun test`) and wire `turbo run test` at the root. Do NOT convert tests to another runner.
2. Provision a DISPOSABLE test database (separate DATABASE_URL — a Neon branch or local Postgres). Never run the DB-backed tests against the primary/production Neon URL. Document the env var and how to point tests at it.
3. Run, and capture real output for: `bun run check` (Biome), `bunx tsc --noEmit`, and `bun test` across the repo. Fix ONLY test-harness breakage (broken imports, missing setup/teardown, missing config) needed to get the suite executing — do NOT fix product logic in this phase.
4. Produce a baseline report: per test file → pass / fail / error / "did not run". Explicitly flag any test that asserts against a 501 or a stubbed path (i.e. a false green).

Constraints: no changes to product behavior; harness/config only. If a test only passes because it targets a stub, note it — do not "fix" it by changing product code here.

When complete, stop. Output: which checks pass, the per-file test baseline, roadblocks, and the exact next file to touch. Do not proceed until manually instructed.
```

---

## R1 ✅ — oRPC migration (build the real typed transport; foundational) — COMPLETE

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: replace the hand-rolled RPC transport with real oRPC per the fixed stack, end to end. This is a TRANSPORT + TYPE migration only — preserve every procedure's existing behavior exactly; do NOT fix auth semantics, pricing, ingestion, reconciliation, or PDF bugs here (later phases own those). If you spot such a bug, note it for its phase and move on.

Current reality to replace: apps/server/src/index.ts has a hand-rolled POST /rpc/call dispatcher that string-splits "method" and calls appRouter functions as handler(authContext, params), all typed `any`; packages/api exports an untyped RPCClient; apps/web calls it via raw fetch + lib/rpc.ts + lib/useRPC.

1. Stand up an oRPC server instance in apps/server. Port every procedure currently in appRouter (routers.ts + procedures.ts) into oRPC procedures, each using its EXISTING zod validator from validators.ts as the input schema and returning a typed output. Keep the same router shape/namespaces (session, org, sites, siteAccess, devices, meters, billing, tariffs, reconciliation, invoices, report, readings) so call sites map 1:1.
2. Build the oRPC context that produces the current AuthContext { userId, sessionId, organizationId }. PORT THE EXISTING auth behavior as-is (including how session + x-organization-id are read today) into oRPC context/middleware — do NOT change auth rules here; R2 fixes them. The goal is behavior-preserving so existing tests stay green.
3. Mount the oRPC handler in the Hono app (apps/server/src/index.ts), replacing the /rpc/call dispatcher. Leave /api/auth/** and the /ingest area exactly as they are (ingestion is device-facing HTTP, not oRPC).
4. Generate/export the typed oRPC client + inferred input/output types from packages/api. Rewrite apps/web to use the generated client (replace every raw fetch("/rpc/call"), lib/rpc.ts, and the transport inside lib/useRPC). A wrong param type or a wrong return-field access MUST fail `bunx tsc --noEmit`.
5. Delete the dead hand-rolled dispatcher and the untyped RPCClient once nothing references them.

Verify (Ground Rule 4): `bun run check` + `bunx tsc --noEmit` green; the existing test suite still green (behavior preserved); `next build` green; runtime smoke of one read (e.g. sites.list) and one mutation (e.g. sites.create) through the generated client. Prove type-safety by showing that introducing a bad field access fails tsc (then revert it).

When complete, stop. Report written-vs-verified, files touched, any bugs you deferred to later phases, and the exact next file. Do not proceed until manually instructed.
```

---

## R2 ✅ — Auth, org plugin & RBAC as oRPC middleware (repair the Phase-2 foundation) — COMPLETE

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: authentication/authorization only, now expressed as the layered oRPC middleware from docs/02 §4.1 (built on the R1 transport). Audit found: the better-auth organization plugin is NOT enabled (apps/server/src/auth.ts has only email/password); org membership is hand-rolled with raw Drizzle inserts (procedures.ts); org.* procedures throw "not yet implemented"; requirePlatformOperator (middleware.ts) throws unconditionally; and the old transport accepted spoofable x-user-id/x-session-id headers as auth (R1 preserved this behavior — remove it here).
1. Enable the better-auth organization plugin (org = Account) with roles owner, operator. Add the additionalField isPlatformOperator (boolean, default false) on user. Generate + apply any needed migration; do NOT hand-redefine better-auth tables.
2. Implement the middleware as layered oRPC middleware in the §4.1 order: requireSession → requireOrg → requireSiteAccess(role?) → requirePlatformOperator. requireSiteAccess must grant org owners access to all org sites AND users with an explicit site_access grant.
3. Implement requirePlatformOperator for real (read isPlatformOperator from the user row).
4. Replace the hand-rolled org creation (procedures.ts + raw member/organization inserts) with the plugin's org APIs. Implement the org.* procedures that currently throw (create, get, listMembers, invite, setMemberRole) via the plugin; owner-guarded.
5. Remove the spoofable x-user-id/x-session-id fallback from any non-test path. If tests need an auth shim, gate it explicitly behind NODE_ENV==='test'.
6. Tests: a site_manager with a grant reads their site and is denied a sibling; an org owner reads all org sites; a non-operator is denied operator-only procedures and cannot pass requirePlatformOperator; cross-org access denied.

Verify: tests green AND a runtime smoke — sign up → org created via the plugin → membership row present → operator gate enforced.

When complete, stop and report written-vs-verified. Do not proceed until manually instructed.
```

---

## R3 ✅ — Ingestion pipeline: mount, HMAC auth, commission, worker trigger (repair Phase 4) — COMPLETE (verified 2026-07-05)

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: device-facing HTTP + the aggregation trigger per docs/02 §4.2 and risks R1/R2. (These are plain Hono routes, NOT oRPC — do not route them through the oRPC client.) Audit found: apps/server/src/ingestion.ts implements the routes but index.ts mounts /ingest/* as a 501 placeholder (never wired); device auth is a plain sha256(key)==hash bearer check, NOT HMAC as specified; POST /device/commission returns 501; and nothing triggers the aggregation/gap workers after ingest.
1. Mount createIngestionRouter + createDeviceRouter (from ingestion.ts) into index.ts, REPLACING the 501 /ingest/* placeholder. Live routes: POST /ingest/readings, POST /ingest/health, GET /device/config/:deviceId, POST /device/commission.
2. Replace the plain-hash device auth with HMAC per §4.2: the device signs the request body with its device key; the server recomputes and verifies the signature (constant-time compare); reject bad signatures. Keep the idempotent upsert on (meter_id, time) and the highest-accepted-seq return.
3. Implement POST /device/commission for real: one-time provisioning token → issue a device key, store ONLY its hash. No stub.
4. After accepted readings, trigger aggregateDemandIntervals + detectDataGaps for the affected meter(s) (inline call or a documented job) so demand_intervals + data_gaps populate.
5. Tests: golden-file interval alignment incl. a 23:45→00:00 boundary and a dropped mid-interval minute (interval energy stays correct); HMAC rejection of a bad signature; idempotent re-POST of the same batch; commission issues a usable key. NOTE (R0 caveat): the existing ingestion.test.ts is a FALSE GREEN — it calls the module functions directly while the live /ingest/* route is a 501 stub. Extend the tests to POST against the actually-mounted route, and add a test that FAILS if /ingest/* is not mounted (so this wiring can never silently regress).

Verify (mandatory end-to-end smoke): commission a device → POST readings with a valid HMAC signature → readings land → demand_intervals populate → the site dashboard's Current Load and Month-to-Date show NON-ZERO values. Ingestion is the entry point of the whole product; a green unit test is not enough — show data flowing.

When complete, stop and report written-vs-verified. Do not proceed until manually instructed.
```

---

## R4 ✅ — Pricing correctness: TOU, season, block (repair Phase 5) — COMPLETE (verified 2026-07-06)

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: apps/server/src/tariffs.ts priceUsage only — keep it PURE (no DB). Audit found priceUsage silently prices any rate whose season≠"all" or touPeriod≠"all" as R0, and blockThresholdKwh (tiered tariffs) is declared but unused. This makes the money math wrong for real Eskom/municipal TOU/seasonal/block tariffs — a plausible-but-wrong number in a legal document.
1. Fix priceUsage so ALL season (high/low/all) and touPeriod (peak/standard/offpeak/all) rates are applied. Use UsageData.intervalStarts + the profile's tou_schedule to attribute active energy to the correct TOU band and season, then price each band by its rate. Demand/reactive/fixed/ancillary as per §3.
2. Implement block/tiered pricing via blockThresholdKwh.
3. Integer cents throughout; Math.round only at the cents boundary; PURE (no DB, no clock — take time inputs as parameters).
4. Tests (hand-computed, assert exact cents): a TOU example splitting energy across peak/standard/offpeak; a seasonal (high/low) example; a block-threshold example. Include a case proving a non-"all" tariff no longer totals 0. NOTE (R0 caveat): the existing tariffs.test.ts is 19/0 green ONLY because it tests flat all/all tariffs — it does not exercise this bug. Do not treat that green as coverage; the new TOU/season/block cases are the real bar.

Verify: run the tariff tests green; show a known TOU tariff producing the hand-computed total.

When complete, stop and report. Do not build reconciliation/PDF here. Do not proceed until manually instructed.
```

---

## R5 ✅ — Reconciliation correctness: period-scoped gaps, effective-dated tariffs, locked guard (repair Phase 6) — COMPLETE (verified 2026-07-06)

> **R4 carry-over done here:** the reconciliation caller now builds `UsageData` with period-scoped `intervalStarts` + `intervalActiveKwh` (from `demand_intervals`) + the site `timezone` (via `priceRoleOverPeriod`), so the R4-fixed `priceUsage` applies TOU/seasonal bands end-to-end.

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: reconciliationGenerate orchestration in apps/server/src/routers.ts (+ reconciliation.ts). Reuse the R4-fixed priceUsage. Audit found: data_gaps are queried by siteId only (NOT scoped to the billing period, so every historical gap inflates this month's integrity flag); tariff assignments are chosen with findFirst and NO effective-date filter (Phase 6 required "profiles effective in the period" incl. a period crossing a tariff change); and there is no guard that the linked invoice is locked. The snapshotted period bounds + boundary_inclusivity + demand_interval_minutes ARE used correctly today — do NOT regress that.
1. Scope data_gaps to the billing-period window (gapStart within [period_start, period_end) honoring the snapshotted boundary_inclusivity). Fix gapCount/gapMinutesTotal accordingly.
2. Select the landlord AND legal_ceiling tariff profiles EFFECTIVE during the period (respect siteTariffAssignments effective dates). If the period crosses a change, price per docs/02 (split or the documented rule) — never an arbitrary findFirst.
3. Guard: refuse to generate/finalise unless the linked invoice is status=locked; read only confirmed+locked totals.
4. Keep reading the CONCRETE billing_periods row for authoritative period_start/period_end + snapshotted boundary_inclusivity + demand_interval_minutes (do not re-derive from any rule).
5. Tests: clean calendar month with a known overcharge; a gap INSIDE the period sets gaps_present with the correct count while an out-of-period gap is excluded; a 20th→20th period crossing a tariff effective-date change; inclusive vs half-open edge-interval difference.

Verify: run the reconciliation tests green.

When complete, stop and report. Do not generate PDF bytes here (R6). Do not proceed until manually instructed.
```

---

## R6 ✅ — PDF generation wiring (make the Phase-8 report reachable) — COMPLETE (verified 2026-07-06)

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: make the existing (good) report worker reachable per §4.2. Audit found: reports.ts renders a correct dispute-ready PDF and the attorney-seal guard is enforced in workers.ts (keep both), BUT generateReportPdf is never called from any procedure/route — it's only referenced in tests — so a PDF can never be produced through the app; report.getPdf just throws "Call generateReportPdf first."
1. Add a reconciliation.generatePdf(reconId) oRPC procedure (site-access guarded) that runs generateReportPdf off the request path: store pdf_storage_key + pdf_hash (sha256) + generated_at; bump version on regeneration (never overwrite prior versions); write an audit_log entry; keep the guard that refuses to seal when the legal_ceiling tariff has validated_by_attorney=false.
2. report.getPdf (or GET /reports/:reconId/pdf) returns a short-lived signed URL only when a PDF exists, guarded by site access. Wire apps/web's Download button to generate-then-download.
3. Confirm the object-store (R2/S3) upload actually works, or document the exact bucket/credentials env required and fail loudly if absent (no silent stub).
4. Tests: hash stability for identical inputs; version increments on regeneration; a gaps_present recon renders the flag; an attorney-unvalidated ceiling refuses to seal. NOTE (R0 caveat): the existing reports.test.ts is a FALSE GREEN — it calls generateReportPdf directly, which NO procedure invokes. Add a test that drives PDF creation through the new reconciliation.generatePdf procedure end-to-end (i.e. it FAILS if the worker is unreachable), not just the worker in isolation.

Verify (mandatory end-to-end smoke): locked invoice → generate reconciliation → generate PDF → download a REAL sealed PDF and confirm its sha256 matches the stored pdf_hash. After this phase the evidence spine conducts end-to-end (device → readings → intervals → reconciliation → sealed PDF).

When complete, stop and report. Do not change reconciliation math here. Do not proceed until manually instructed.
```

---

## R7 — Fleet/admin dashboard (original Phase 10; now unblocked by R2)

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: Operator-only fleet area, gated by the now-REAL requirePlatformOperator (fixed in R2). Consumes fleet.* (§4.1) via the generated oRPC client (R1). Audit note: no fleet.* router exists yet.
1. Add the fleet.* read procedures (nothing beyond §4.1): fleet.overview (counts online/offline/degraded), fleet.deviceHealth (per-device last_seen, connectivity, ups status, battery %, buffered backlog), fleet.simStatus, fleet.offlineDevices. Source data from devices + device_health_samples (populated by R3).
2. Web pages (apps/web, existing design system, generated oRPC client): fleet table with filters, per-device drilldown (recent device_health_samples), SIM status column.
3. Enforce that a non-operator cannot reach these routes or procedures — and TEST it.

Do NOT expose tenant billing data in fleet views beyond site/device identifiers.

Verify: tests green + runtime smoke as an operator and a denied non-operator. When complete, stop and report. Do not proceed until manually instructed.
```

---

## R8 — Notification service & alerts (original Phase 11)

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: alerts.* + delivery per §3/§4. Alert ROWS are created by the R3 workers (device_offline, data_gap, etc.); this phase adds delivery + preferences + UI.
1. Notification dispatcher: for each open alert, fan out to channels (app in-DB, email via Resend, SMS via the SA aggregator), writing alert_deliveries rows with status/provider_ref; handle POST /webhooks/sms delivery callbacks.
2. Ensure the required alert types are emitted somewhere: device_offline, sim_down, data_gap, ups_degraded, plus power_restored and invoice_ready.
3. alerts.list/acknowledge/resolve; alerts.getPreferences/setPreferences (per-user channel opt-in) — as oRPC procedures.
4. Web: alerts inbox + notification preferences (generated oRPC client, existing design system).
5. Tests: dispatch creates a delivery per enabled channel; a failed SMS is recorded as failed; ack/resolve transitions.

Do NOT redesign alert-creation logic; only deliver + manage. Verify with tests + a runtime dispatch smoke. When complete, stop and report. Do not proceed until manually instructed.
```

---

## R9 — Native mobile (original Phase 12; now unblocked by R1)

```
Read the current codebase state. Do not write any code outside the scope of this specific micro-phase.

SCOPE: apps/mobile (Expo/React Native) reusing the generated oRPC client + types from packages/api (built in R1) + better-auth. Parity with the core web journeys only.
1. Auth + org/site selection.
2. Site dashboard (near-real-time + month-to-date), alerts inbox, invoice upload → confirm → reconcile → view/download sealed PDF.
3. Push registration wired to the notification service (app channel).

Rules: share the oRPC client and types from packages/* — do NOT fork business logic into the app; no new backend procedures. One codebase for both platforms.

Verify: run on both an iOS and an Android simulator; smoke the auth → dashboard → invoice → PDF journey. When complete, stop and report. Do not proceed until manually instructed.
```

---

### Sequencing (critical path in bold)

**R0 → R1 → R2 → R3 → R4 → R5 → R6** rebuilds the foundation (real oRPC transport + real auth/RBAC) and the evidence-pipeline spine so it runs end-to-end. R7/R8/R9 are consumers layered on top. Keep phases isolated (one at a time); after each, verify the report against a running system before pasting the next — that verification step is what prevents the drift this roadmap exists to fix.

**As of 2026-07-06: R0–R6 DONE — the money/evidence critical path is fully rebuilt and verified end-to-end (Astryx UI migration + Tailwind removal also complete).** R7/R8/R9 (fleet, notifications, mobile) are consumer features layered on top, not critical path. Remaining product follow-ups: Slice 4 (site-scoped invites) and the invoice-upload/parser wiring. The dispute output (sealed PDF) is now trustworthy for flat/TOU/seasonal/block tariffs with effective-dated changes, period-scoped integrity flags, and a hash-sealed evidence trail.

**Note on R1:** the oRPC migration is behavior-preserving by design — it changes *how* calls are typed and transported, not *what* the procedures do. That is deliberate: doing it before the auth (R2) and spine (R3–R6) work means every later phase is built and type-checked against the real client, so the class of silent drift that produced this roadmap can't recur.

*End of 04_Remediation_Roadmap.md*
