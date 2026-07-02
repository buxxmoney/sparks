# Handover Pack: Electricity Reconciliation & Dispute Platform (Working name: **Sparks**)

## 1. Product Vision & Scope
A SaaS platform that installs a certified sub-meter at a commercial tenant's DB board and streams their real electricity usage (active energy, network demand, and reactive energy) into a web and mobile app. It reconciles that usage against the landlord's stated tariff **and** the legally permitted NERSA/municipal maximum, then generates a downloadable, timestamped, dispute-ready PDF proving whether the tenant is being overcharged.

## 2. Core User Personas

| Persona | Role | Needs |
|---|---|---|
| **The Tenant Owner** (beachhead: restaurant owners in shopping centres) | Primary paying customer. Runs one or more sites. Lives on their phone. | See real-time and monthly usage per site; know if they're being overcharged; get a dispute report they can put in front of centre management. |
| **The Site Manager** | Manages a single site; delegated by the Owner. | View that one site's usage and alerts; upload the monthly landlord invoice. |
| **The Internal Operator (us)** | Sebastian/brother — platform & fleet admin. | Monitor device/SIM/connectivity health across all installs; onboard new tenants (concierge setup); maintain the tariff library. |
| **The Licensed Electrician** (Dad / contractors) | Installs the meter + device at the DB board. | Clear install spec; wiring done to code; device commissioned and phoning home before leaving site. |

## 3. MoSCoW Requirements

### Must Have
- Certified sub-meter (Eastron SDM630MCT, MID-certified variant) reading **active energy (kWh), network/max demand (kVA/kW), and reactive energy (kVArh)**.
- Raspberry Pi gateway, **mains-powered via DIN-rail AC/DC PSU with a self-recharging Li-ion UPS backup** (no swappable batteries).
- **Fine-grained logging (1-minute resolution)** with **server-side aggregation into clock-aligned, configurable demand intervals (15/30 min)** to match the landlord's billing window.
- **Local buffering on the device** during connectivity loss + sync-on-reconnect; **fast, clean reboot** to capture power-restoration demand spikes; **backfill from the SDM630's onboard registers** where possible.
- **Data-gap detection**, flagged visibly as a dispute-integrity event.
- **Tariff library** mirroring official Eskom + major municipal tariff schedules, including the **legally permitted maximum resale tariff** per supply zone as a first-class field; plus **custom tariff entry** (for shopping-centre sub-meter schedules).
- **Reconciliation engine** computing expected charges for active/demand/reactive against (a) the landlord's stated tariff and (b) the legal ceiling.
- **Invoice upload:** tenant uploads landlord invoice PDF → **LLM auto-parse pre-fills the three charge totals → tenant confirms/corrects → report locks.**
- **Dispute-ready PDF report** (downloadable, timestamped) — see §4/§5 for contents.
- **Web app + native mobile apps (iOS + Android)** — required before commercial launch.
- **Multi-site accounts** under one login, with **Owner** and **Site Manager** roles (one person may hold both).
- **SIM (4G/LTE) as default connectivity, Wi-Fi as fallback.**
- **Internal fleet/admin dashboard** showing device, SIM, and connectivity health per install.
- **Multichannel alerts (app + email + SMS)** for device offline, SIM/connectivity down, data-gap detected, and backup-battery degraded.
- Authentication, per-site access control.

### Should Have
- **Rest-of-month usage & cost forecast** (simple projection from month-to-date).
- **Power-factor insight** flagging when reactive charges indicate the tenant would benefit from power-factor correction.
- **"Illegal add-on" detection** — flag separate metering/billing/vending/admin line items on the landlord invoice as impermissible under NERSA rules.
- **NERSA recourse path** printed on the report (tenant → reseller → licensed distributor → NERSA).
- **Deliverable-based guarantee** ("a certified dispute-ready report every month or your money back") — *not* an outcome/savings guarantee.

### Could Have
- PDF auto-parsing improvements beyond confirm/correct.
- Historical trend analytics and cross-site benchmarking for chain owners.
- Alerting on abnormal demand spikes in near-real-time.
- Automated regulatory-change ingestion for tariff updates.

### Won't Have (v1 — explicitly out of scope)
- Building/manufacturing our own meter from scratch.
- Any **outcome/savings-based guarantee**.
- Fully automated self-service onboarding (v1 onboarding is **concierge / operator-assisted**).
- Direct integration with landlord/Eskom/municipal billing systems.
- Automatic legal filing or acting as legal representative — we produce the evidence; the tenant/their attorney disputes.
- Controlling or switching loads (monitoring only, not control).

## 4. Core User Journeys

**A. Onboarding & Installation (concierge)**
1. Operator creates the tenant account and captures the site's supply zone, landlord tariff, and applicable legal-ceiling tariff into a structured profile.
2. Licensed electrician installs the SDM630MCT + CTs on the correct phases and the mains-powered Pi gateway (AC/DC PSU + UPS) in the DB enclosure.
3. Device commissions: connects via SIM, streams first readings, confirms health on the fleet dashboard before the electrician leaves.
4. Owner receives login credentials; sets up any Site Managers.

**B. Daily Monitoring (Owner/Site Manager)**
1. User opens mobile/web app → sees near-real-time load and month-to-date active/demand/reactive usage per site.
2. App shows rest-of-month cost forecast and power-factor insight.
3. Device-health and dispute-integrity alerts arrive via app/email/SMS as events occur.

**C. Monthly Reconciliation & Dispute**
1. Landlord invoice arrives; user uploads the PDF.
2. System LLM-parses the invoice → pre-fills active/demand/reactive charged totals → user confirms/corrects.
3. Reconciliation engine computes expected charges vs. landlord's tariff vs. legal ceiling → shows discrepancy.
4. User downloads the **timestamped dispute-ready PDF** and presents it to the landlord/centre management; report includes the NERSA recourse path.

**D. Internal Fleet Operations**
1. Operator monitors the admin dashboard for offline devices, dead SIMs, or data gaps.
2. Operator resolves connectivity/hardware issues proactively before customer impact.
3. Operator maintains the tariff library against Eskom (~1 April), municipal (~1 July), and NERSA regulatory changes.

## 5. Data Entities (High-Level)
- **Account / Organisation** — the customer business; billing owner of the SaaS subscription.
- **User** — login identity; belongs to an Account; carries role(s).
- **Role** — Owner, Site Manager, Internal Operator.
- **Site** — a physical location (e.g., one restaurant); belongs to an Account.
- **Device** — the Raspberry Pi gateway; health/SIM/connectivity status; assigned to a Site.
- **Meter** — the SDM630MCT; serial number + MID certification reference; assigned to a Device/Site.
- **Reading** — 1-minute time-series record (active, demand, reactive, power factor, timestamp).
- **Demand Interval** — aggregated clock-aligned interval (15/30 min) derived from Readings.
- **Tariff Profile** — structured rates (active/demand/reactive + fixed charges, TOU/seasonal where applicable); typed as landlord-stated **or** legal-ceiling; sourced from library or custom.
- **Landlord Invoice** — uploaded PDF + parsed/confirmed charge totals for a billing period.
- **Reconciliation / Report** — computed expected vs. legal-ceiling vs. charged; the generated dispute PDF; timestamped and versioned.
- **Alert / Event** — device-health and dispute-integrity notifications and their delivery channels.
- **Billing Cycle** — per-site billing window definition (e.g., calendar month vs. 20th-to-20th) and demand-interval length.

## 6. Business Constraints
- **Regulatory backbone:** Under the Electricity Regulation Act and NERSA rules, a reseller must charge a tariff **identical** to the approved distributor tariff for the supply area, with **no markup** and **no separate metering/billing/vending/admin add-ons**; overcharging exposes them to civil recovery + interest. Protections are strongest for residential resale — **commercial contractual freedom is broader, so the legal-ceiling claim must be validated by an attorney for the commercial context before being asserted in reports.**
- **Live regulatory dependency:** Tariff library must track NERSA changes (incl. the draft *Rules for Electricity Trading*, v01, 24 Oct 2025), Eskom increases (~1 April), and municipal increases (~1 July). Stale tariffs = invalid disputes.
- **Metrological credibility:** Only the MID-certified SDM630MCT variant, correctly installed (CT sizing, phase order), qualifies the readings as dispute-grade evidence.
- **Demand-window matching:** Peak-demand figures are only valid when computed over the *same interval and billing cycle* the landlord uses; both are per-site configurable.
- **Data integrity:** Any gap in the record is a dispute liability — must be detected, flagged, and, where possible, backfilled from the meter's onboard registers.
- **Installation:** Legal requirement — installation only by a licensed electrician; AC tap behind a rated MCB in a proper enclosure.
- **Power design:** Mains → DIN-rail AC/DC PSU (5V) → Li-ion UPS module → Pi + meter. No swappable batteries.
- **Connectivity:** LTE SIM default (adds recurring data cost to the R500/mo), Wi-Fi fallback.
- **Commercials:** SaaS at **~R500/month** + **~R4,000 installation**; **deliverable-based** money-back guarantee only.
- **Beachhead:** Restaurants in shopping centres — heavy refrigeration/HVAC/motor load, high demand + poor power factor, typically on centre-management sub-meters with custom tariff schedules (so custom tariff entry is the norm, not the exception).

---

## Phase 2 — Prompt for the Technical Analyst

> You are an expert Technical Analyst / Solutions Architect. Attached is an approved Business Handover Pack for **Sparks**, a South African SaaS platform that sub-meters commercial tenants' electricity (active energy, network demand, reactive energy), reconciles usage against the landlord's tariff and the legally permitted NERSA/municipal maximum, and produces a dispute-ready PDF. Your job is to turn this business specification into a concrete technical architecture and delivery plan — **do not re-litigate the business requirements**; treat them as fixed unless you find a genuine technical contradiction, which you must flag explicitly.
>
> Produce:
> 1. **System Architecture** — end-to-end: edge device (Raspberry Pi + SDM630MCT over Modbus RTU, DIN-rail AC/DC PSU + Li-ion UPS), local buffering/store-and-forward, connectivity (LTE-default/Wi-Fi-fallback), ingestion API, time-series storage, reconciliation service, notification service, web app, and native iOS/Android apps. Include a diagram description and the data flow for 1-minute readings → clock-aligned 15/30-min demand aggregation.
> 2. **Technology Stack Recommendation** — with justification and trade-offs, covering edge software, ingestion/backend, time-series database, LLM-based invoice parsing (with human confirm-before-lock), PDF report generation, auth/RBAC (Owner/Site Manager/Operator), and the internal fleet-health dashboard.
> 3. **Data Model** — expand the high-level entities in §5 into a normalised schema (tables, key fields, relationships, and the reading/demand-interval time-series design), including per-site configurable billing cycle and demand interval.
> 4. **Key Technical Risks & Mitigations** — prioritise: data-gap detection & meter-register backfill, demand-window alignment correctness, offline resilience and clean fast reboot to capture power-restoration peaks, LLM invoice-parse accuracy/verification, MID-certification/evidence traceability in the report, SIM fleet management, and security of tenant billing data.
> 5. **Phased Delivery Plan** — MVP scope vs. later phases, mapped to the MoSCoW list, with the critical path and rough effort sizing.
> 6. **Open Technical Questions** — anything you need decided before build, each with a recommended default.
>
> Be specific and decision-oriented: recommend, don't enumerate. Where the business spec is silent on a technical detail, choose a sensible industry-standard default and state it.
