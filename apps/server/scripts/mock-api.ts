/**
 * Mock Sparks API for local visual work on the dashboard.
 * Serves better-auth's get-session endpoint plus the handful of oRPC
 * procedures the dashboard chrome + page call, using the real RPCHandler
 * so the wire format matches the typed client exactly.
 */
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
// The REAL pricing engine — the mock prices its synthetic load curve with the same
// pure function the server uses, so the figure on screen is genuinely what this
// usage costs under this tariff.
import { billLines, priceUsage, rateDisplayFor } from "../src/tariffs";
import { type CojSchedule, convertTariff } from "../src/tariff-import";

const ORG_ID = "org_mock_1";

const user = {
  id: "user_mock_1",
  email: "buxmanm9@gmail.com",
  name: "Matteo Buxman",
};

const sites = [
  {
    id: "site_1",
    name: "Greenstone Mall",
    addressLine1: "12 Modderfontein Rd",
    city: "Edenvale",
    province: "Gauteng",
    status: "active",
  },
  {
    id: "site_2",
    name: "Rosebank Office Park",
    addressLine1: "191 Jan Smuts Ave",
    city: "Johannesburg",
    province: "Gauteng",
    status: "active",
  },
  {
    id: "site_3",
    name: "Century City Retail",
    addressLine1: "4 Bridgeways Precinct",
    city: "Cape Town",
    province: "Western Cape",
    status: "active",
  },
  {
    id: "site_4",
    name: "Umhlanga Ridge Towers",
    addressLine1: "2 Ncondo Pl",
    city: "Durban",
    province: "KwaZulu-Natal",
    status: "active",
  },
  {
    id: "site_5",
    name: "Menlyn Corporate Park",
    addressLine1: "175 Corobay Ave",
    city: "Pretoria",
    province: "Gauteng",
    status: "active",
  },
];

// Load-curve scale. The mock site is on COJ "Business Conventional", which caps
// at 100 kVA (above that a customer is moved to Large Consumers), so the curve is
// sized to peak just under that ceiling — otherwise the dashboard would show a
// site that could not legally hold the tariff it is being priced on.
const LOAD_BASE_KW = 26;
const LOAD_RAMP_KW = 19;
const LOAD_PEAK_KW = 83;

// ── Per-site dashboard data ─────────────────────────────────────────
// 24h of 30-min demand intervals following a plausible commercial load
// curve (low overnight, morning ramp, midday plateau, evening falloff).
function makeIntervals() {
  const out: Array<{
    intervalStart: string;
    activeEnergyKwh: string;
    reactiveEnergyKvarh: string;
    avgDemandKw: string;
    avgDemandKva: string;
  }> = [];
  const now = Date.now();
  for (let i = 47; i >= 0; i--) {
    const t = new Date(now - i * 30 * 60_000);
    const hour = t.getHours() + t.getMinutes() / 60;
    // Load curve: base 140 kW, ramps 07:00→10:00, plateau to 17:00, falls to 21:00.
    let kw = LOAD_BASE_KW;
    if (hour >= 7 && hour < 10) kw = LOAD_BASE_KW + (hour - 7) * LOAD_RAMP_KW;
    else if (hour >= 10 && hour < 17) kw = LOAD_PEAK_KW + Math.sin(hour) * 4;
    else if (hour >= 17 && hour < 21) kw = LOAD_PEAK_KW - (hour - 17) * 14;
    kw += (Math.sin(t.getTime() / 7e6) + Math.cos(t.getTime() / 3e6)) * 3;
    const pf = 0.91 + Math.sin(hour) * 0.02;
    const kva = kw / pf;
    out.push({
      intervalStart: t.toISOString(),
      activeEnergyKwh: (kw / 2).toFixed(2),
      reactiveEnergyKvarh: ((kva - kw) / 2).toFixed(2),
      avgDemandKw: kw.toFixed(2),
      avgDemandKva: kva.toFixed(2),
    });
  }
  return out;
}

const MONTHS = ["Aug 25", "Sep 25", "Oct 25", "Nov 25", "Dec 25", "Jan 26", "Feb 26", "Mar 26", "Apr 26", "May 26", "Jun 26", "Jul 26"];
const energyPeriods = MONTHS.map((label, i) => ({
  label,
  periodStart: new Date(2025, 7 + i, 1).toISOString(),
  periodEnd: new Date(2025, 8 + i, 1).toISOString(),
  activeEnergyKwh: (37_500 + Math.sin(i * 1.1) * 5_600 + i * 260).toFixed(0),
  reactiveEnergyKvarh: (11_900 + Math.cos(i * 0.9) * 1_570).toFixed(0),
}));

// The dashboard branches on `myLevel === "operator"` to render the operator view
// (read-only banner, inline billing-cycle panel). Run with MOCK_LEVEL=operator to
// work on that view; unset it and the mock behaves as the customer, as before.
const MOCK_LEVEL = process.env.MOCK_LEVEL ?? "org_owner";

const siteDetail = {
  ...sites[0],
  timezone: "Africa/Johannesburg",
  supplyZone: "City Power JHB",
  demandIntervalMinutes: 30,
  myLevel: MOCK_LEVEL,
};

// The site's billing cycle, mutated by the settings panel so the whole loop —
// save → periodStart moves → energy-to-date recomputes — is exercisable offline.
const mockPolicy: { recurrence: "calendar_month" | "day_of_month"; anchorDay: number | null } = {
  recurrence: "calendar_month",
  anchorDay: null,
};

// Start of the current period under `mockPolicy`: the 1st, or the most recent
// occurrence of the anchor day (previous month when today is before it).
function mockPeriodStart(now = new Date()): Date {
  if (mockPolicy.recurrence === "day_of_month" && mockPolicy.anchorDay) {
    const day = mockPolicy.anchorDay;
    const monthOffset = now.getDate() >= day ? 0 : -1;
    // Day 0 of the next month = last day of this one, so an anchor past a short
    // month's end clamps instead of rolling over.
    const lastDay = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 0).getDate();
    return new Date(now.getFullYear(), now.getMonth() + monthOffset, Math.min(day, lastDay));
  }
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

// Mirrors the server's meter-cadence.ts. Gateways batch their 60s samples and upload
// every 30 min, so "last seen 22 minutes ago" is a perfectly healthy meter — the mock
// derives status from staleness (rather than hardcoding it) so the dashboard shows what
// the real fleet shows.
const REPORT_INTERVAL_MIN = 30;
const meterStatus = (minutesAgo: number) =>
  minutesAgo <= REPORT_INTERVAL_MIN + 5
    ? "online"
    : minutesAgo <= 2 * REPORT_INTERVAL_MIN + 5
      ? "degraded"
      : "offline";

const devices = [
  // Mid-cycle: sampled a minute ago, but the batch carrying it hasn't uploaded yet.
  { id: "dev_1", serialNumber: "SPK-4411-0092", connectivityMode: "lte", minutesAgo: 22 },
  // Just after an upload landed.
  { id: "dev_2", serialNumber: "SPK-4411-0117", connectivityMode: "ethernet", minutesAgo: 2 },
  // Missed a whole upload window — genuinely degraded.
  { id: "dev_3", serialNumber: "SPK-3302-0061", connectivityMode: "lte", minutesAgo: 51 },
].map(({ minutesAgo, ...d }) => ({
  ...d,
  status: meterStatus(minutesAgo),
  lastSeenAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
}));

// ── Live bill estimation ────────────────────────────────────────────────
// The mock site sits on the REAL City Power FY26/27 "Business Conventional/
// Prepaid" tariff, loaded from tariffs/2026/2027-COJ.json and converted by the
// same `convertTariff` the importer uses. So the figure on screen is what this
// usage genuinely costs under the published schedule — not an invented number.
//
// MOCK_TARIFF=<id> prices against a different tariff from the same schedule
// (e.g. industrial_lv_tou); MOCK_NO_TARIFF=1 simulates a site with none assigned.
const MOCK_NO_TARIFF = process.env.MOCK_NO_TARIFF === "1";
const MOCK_TARIFF_ID = process.env.MOCK_TARIFF ?? "business_conventional_prepaid";

const cojSchedule = (await Bun.file(
  new URL("../../../tariffs/2026/2027-COJ.json", import.meta.url),
).json()) as CojSchedule;
const mockTariff = convertTariff(cojSchedule, MOCK_TARIFF_ID);

// The schedule marks its rates VAT-exclusive but never states the rate itself,
// so the importer cannot source it. Stored profiles carry `vatFraction: 0.15`;
// the mock mirrors that so its total matches what the real server produces.
mockTariff.profile.vatFraction = 0.15;

if (mockTariff.unsupported.length > 0) {
  // Loud on startup: these are charges the published tariff defines that the
  // pricer does not yet apply, so the mock's total is knowingly incomplete.
  console.log(`\n[mock] tariff "${mockTariff.name}" — ${mockTariff.unsupported.length} unsupported rule(s):`);
  for (const u of mockTariff.unsupported) console.log(`  · ${u.rule}: ${u.effect}`);
  console.log("");
}

// Price the elapsed part of the current billing period with the REAL pricer, over
// the same 30-min intervals the load chart draws — so the mock's total is the
// number the real server would produce for this usage, not a hand-picked figure.
function mockBillToDate() {
  const start = mockPeriodStart();
  const now = new Date();
  const intervalMs = 30 * 60_000;

  const intervalStarts: Date[] = [];
  const intervalActiveKwh: number[] = [];
  let reactiveKvarh = 0;
  let maxDemandKva = 0;

  for (let t = start.getTime(); t + intervalMs <= now.getTime(); t += intervalMs) {
    const d = new Date(t);
    const hour = d.getHours() + d.getMinutes() / 60;
    // Same commercial load curve the 24h chart uses, so the money and the graph
    // tell one story.
    let kw = LOAD_BASE_KW;
    if (hour >= 7 && hour < 10) kw = LOAD_BASE_KW + (hour - 7) * LOAD_RAMP_KW;
    else if (hour >= 10 && hour < 17) kw = LOAD_PEAK_KW + Math.sin(hour) * 4;
    else if (hour >= 17 && hour < 21) kw = LOAD_PEAK_KW - (hour - 17) * 14;
    kw += (Math.sin(t / 7e6) + Math.cos(t / 3e6)) * 3;
    const pf = 0.91 + Math.sin(hour) * 0.02;
    const kva = kw / pf;

    intervalStarts.push(d);
    intervalActiveKwh.push(kw / 2);            // kW over a half-hour → kWh
    reactiveKvarh += (kva - kw) / 2;
    if (kva > maxDemandKva) maxDemandKva = kva;
  }

  const activeKwh = intervalActiveKwh.reduce((sum, k) => sum + k, 0);
  const pricing = priceUsage(
    {
      activeKwh,
      maxDemandKva,
      reactiveKvarh,
      intervalStarts,
      intervalActiveKwh,
      timezone: "Africa/Johannesburg",
    },
    mockTariff.profile,
  );

  return {
    status: "priced" as const,
    periodStart: start.toISOString(),
    periodEnd: new Date(start.getFullYear(), start.getMonth() + 1, start.getDate()).toISOString(),
    asOf: now.toISOString(),
    currency: mockTariff.currency,
    tariffName: mockTariff.name,
    totalCents: pricing.totalCents,
    vatCents: pricing.vatCents,
    totalInclVatCents: pricing.totalInclVatCents,
    breakdown: {
      activeEnergyCents: pricing.activeEnergyCents,
      demandCents: pricing.demandCents,
      reactiveEnergyCents: pricing.reactiveEnergyCents,
      fixedCents: pricing.fixedCents,
      ancillaryCents: pricing.ancillaryCents,
    },
    usage: {
      activeEnergyKwh: activeKwh.toFixed(3),
      reactiveEnergyKvarh: reactiveKvarh.toFixed(3),
      peakDemandKva: maxDemandKva.toFixed(3),
    },
    lines: billLines(pricing),
    // Charges the published schedule defines but the pricer does not apply. Shown
    // to the customer rather than hidden: a total that silently omits a known
    // charge is exactly the kind of unexplained figure this breakdown exists to
    // eliminate.
    notApplied: mockTariff.unsupported,
    intervalCount: intervalStarts.length,
  };
}

const router = {
  session: {
    me: os.handler(async () => ({
      organizationId: ORG_ID,
      isPlatformOperator: true,
      orgRole: "owner",
    })),
    listMemberships: os.handler(async () => [
      {
        organizationId: ORG_ID,
        organizationName: "Acme Property Group",
        role: "owner",
      },
    ]),
  },
  sites: {
    list: os.handler(async () => ({ sites, total: sites.length })),
    get: os.handler(async () => siteDetail),
  },
  alerts: {
    unreadCount: os.handler(async () => ({ count: 3 })),
  },
  readings: {
    latest: os.handler(async () => ({
      reading: {
        time: new Date(Date.now() - 30_000).toISOString(),
        totalPowerKw: "84.90",
        totalApparentKva: "92.85",
      },
    })),
    monthToDate: os.handler(async () => {
      // Scale the accumulating registers by how far into the period we are, so
      // changing the cycle visibly moves the numbers (peak demand doesn't
      // accumulate, so it only drops when a shorter window excludes the peak).
      const start = mockPeriodStart();
      const days = Math.max(1, (Date.now() - start.getTime()) / 86_400_000);
      return {
        periodStart: start.toISOString(),
        activeEnergyKwh: (days * 1_240).toFixed(2),
        peakDemandKva: (days < 3 ? 86.4 : 97.2).toFixed(2),
        reactiveEnergyKvarh: (days * 371).toFixed(2),
      };
    }),
    energyByPeriod: os.handler(async () => ({
      basis: "billing_period",
      periods: energyPeriods,
    })),
    // The full published rate card + a link to the approved schedule. The mock has
    // no object storage, so `document` points at the utility's public tariff page
    // rather than a signed PDF URL — enough to build the UI against.
    // Selectable billing periods, mirroring the real procedure's shape.
    billPeriods: os.handler(async () => {
      const now = new Date();
      const out: Array<{ periodStart: string; periodEnd: string; asOf: string; isCurrent: boolean; isClosed: boolean }> = [];
      for (let back = 0; back < 3; back++) {
        const ref = new Date(now.getFullYear(), now.getMonth() - back, 15);
        const start = mockPeriodStart(ref);
        const end = new Date(start.getFullYear(), start.getMonth() + 1, start.getDate());
        out.push({
          periodStart: start.toISOString(),
          periodEnd: end.toISOString(),
          asOf: new Date(Math.min(end.getTime() - 1, now.getTime())).toISOString(),
          isCurrent: start <= now && end > now,
          isClosed: end <= now,
        });
      }
      return { periods: out };
    }),
    tariffSheet: os.handler(async () =>
      MOCK_NO_TARIFF
        ? { status: "no_tariff" as const, tariffName: null, rates: [], document: null }
        : {
            status: "ok" as const,
            tariffName: mockTariff.name,
            rates: mockTariff.profile.rates.map((r) => ({
              chargeType: r.chargeType,
              label: r.label ?? r.chargeType,
              source: r.source ?? null,
              unit: r.unit,
              rateValue: r.rateValue,
              rateDisplay: rateDisplayFor(r.rateValue, r.unit),
              season: r.season,
              touPeriod: r.touPeriod,
              blockThresholdKwh: r.blockThresholdKwh ?? null,
            })),
            document: {
              name: cojSchedule.meta.title ?? "Schedule of Approved Tariffs",
              provider: cojSchedule.meta.issuer,
              effectiveFrom: new Date(2026, 6, 1).toISOString(),
              url: "http://localhost:3001/mock-docs/2027-COJ.pdf",
            },
          },
    ),
    billToDate: os.handler(async () =>
      MOCK_NO_TARIFF
        ? {
            status: "no_tariff" as const,
            periodStart: mockPeriodStart().toISOString(),
            periodEnd: null,
            asOf: new Date().toISOString(),
            currency: "ZAR",
            tariffName: null,
            totalCents: null,
            vatCents: null,
            totalInclVatCents: null,
            breakdown: null,
            usage: null,
            lines: [],
            notApplied: [],
            intervalCount: 0,
          }
        : mockBillToDate(),
    ),
  },
  devices: {
    list: os.handler(async () => ({ devices })),
  },
  billing: {
    policies: {
      get: os.handler(async () => ({
        recurrence: mockPolicy.recurrence,
        anchorDay: mockPolicy.anchorDay,
        effectiveTo: null,
      })),
    },
  },
  demand: {
    listIntervals: os.handler(async () => ({ intervals: makeIntervals() })),
  },
  admin: {
    setSiteBillingCycle: os.handler(async ({ input }) => {
      const { recurrence, anchorDay } = input as {
        recurrence: "calendar_month" | "day_of_month";
        anchorDay?: number;
      };
      mockPolicy.recurrence = recurrence;
      mockPolicy.anchorDay = recurrence === "day_of_month" ? (anchorDay ?? 1) : null;
      return { ...mockPolicy, version: 1, periodsCreated: 0 };
    }),
    listOrganizations: os.handler(async () => ({
      organizations: [
        {
          id: ORG_ID,
          name: "Acme Property Group",
          createdAt: new Date(2026, 0, 12).toISOString(),
          ownerEmail: "owner@acme.example",
          siteCount: sites.length,
        },
      ],
    })),
    listOrgSites: os.handler(async () => ({
      sites: sites.map((s) => ({ ...s, createdAt: new Date(2026, 1, 3).toISOString() })),
    })),
    listReviewQueue: os.handler(async () => ({ queue: [] })),
    listReviewedBills: os.handler(async () => ({ bills: [], total: 0 })),
    tariffSchedulesList: os.handler(async () => ({ schedules: [] })),
    // ── Meter registration flow (stateful so the whole flow can be exercised) ──
    listSiteHardware: os.handler(async ({ input }) => {
      const { siteId } = input as { siteId: string };
      return {
        devices: mockState.legacyDevices,
        meters: mockState.meters,
        ingestRoleName: `meter_site_${(siteId ?? "site_1").replace(/-/g, "")}`,
      };
    }),
    ensureSiteIngestRole: os.handler(async ({ input }) => {
      const { siteId } = input as { siteId: string };
      const created = !mockState.roleCreated;
      mockState.roleCreated = true;
      return {
        roleName: `meter_site_${(siteId ?? "site_1").replace(/-/g, "")}`,
        password: created ? "mOck-p4ssw0rd_shown-once_ABC123xy" : null,
        created,
        host: "ep-mock-pooler.eu-central-1.aws.neon.tech",
        database: "sparks",
      };
    }),
    rotateSiteIngestPassword: os.handler(async ({ input }) => {
      const { siteId } = input as { siteId: string };
      return {
        roleName: `meter_site_${(siteId ?? "site_1").replace(/-/g, "")}`,
        password: "r0tated-p4ssw0rd_shown-once_ZYx987",
        host: "ep-mock-pooler.eu-central-1.aws.neon.tech",
        database: "sparks",
      };
    }),
    provisionMeter: os.handler(async ({ input }) => {
      const { serialNumber, model } = input as { serialNumber: string; model?: string };
      const meter = {
        id: crypto.randomUUID(),
        serialNumber: serialNumber ?? "SDM630-MOCK",
        model: model ?? "SDM630MCT",
        installedAt: null,
        createdAt: new Date().toISOString(),
      };
      mockState.meters.unshift(meter);
      return { meterId: meter.id };
    }),
    deleteMeter: os.handler(async ({ input }) => {
      const { meterId } = input as { meterId: string };
      mockState.meters = mockState.meters.filter((m) => m.id !== meterId);
      return { deleted: meterId };
    }),
    deleteDevice: os.handler(async ({ input }) => {
      const { deviceId } = input as { deviceId: string };
      mockState.legacyDevices = mockState.legacyDevices.filter((d) => d.id !== deviceId);
      return { deleted: deviceId };
    }),
  },
};

// Mutable state behind the admin meter-registration mock.
const mockState: {
  roleCreated: boolean;
  meters: Array<{
    id: string;
    serialNumber: string;
    model: string;
    installedAt: string | null;
    createdAt: string;
  }>;
  legacyDevices: Array<{
    id: string;
    serialNumber: string;
    hardwareModel: string;
    status: string;
    lastSeenAt: string | null;
    createdAt: string;
  }>;
} = {
  roleCreated: false,
  meters: [
    {
      id: "0b6f8f9e-52a1-4a08-9a51-6a2e0a3f7c11",
      serialNumber: "SDM630-0042",
      model: "SDM630MCT",
      installedAt: new Date(2026, 5, 2).toISOString(),
      createdAt: new Date(2026, 5, 1).toISOString(),
    },
  ],
  legacyDevices: [
    {
      id: "dev_legacy_1",
      serialNumber: "SPK-3302-0061",
      hardwareModel: "rpi",
      status: "online",
      lastSeenAt: new Date(Date.now() - 90_000).toISOString(),
      createdAt: new Date(2026, 2, 15).toISOString(),
    },
  ],
};

const rpcHandler = new RPCHandler(router);

function corsHeaders(req: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": req.headers.get("origin") ?? "http://localhost:3000",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "content-type, x-organization-id",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

Bun.serve({
  port: 3001,
  async fetch(req) {
    const url = new URL(req.url);
    const cors = corsHeaders(req);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/api/auth/get-session") {
      return Response.json(
        {
          user,
          session: {
            id: "sess_mock_1",
            expiresAt: new Date(Date.now() + 86400_000).toISOString(),
          },
        },
        { headers: cors },
      );
    }

    // The approved tariff schedule itself. In production this is an object-storage
    // key signed by `signObjectUrl`; the mock has no bucket, so it serves the same
    // PDF that lives beside its JSON transcription in tariffs/.
    if (url.pathname === "/mock-docs/2027-COJ.pdf") {
      const file = Bun.file(new URL("../../../tariffs/2026/2027-COJ.pdf", import.meta.url));
      if (!(await file.exists())) {
        return new Response("tariff schedule PDF not found", { status: 404, headers: cors });
      }
      return new Response(file, {
        headers: {
          ...cors,
          "content-type": "application/pdf",
          // `inline` so it opens in the browser's viewer rather than forcing a
          // save — a customer checking a rate wants to read it, not file it.
          "content-disposition": 'inline; filename="City-Power-Approved-Tariffs-FY26-27.pdf"',
        },
      });
    }

    if (url.pathname.startsWith("/rpc")) {
      const { matched, response } = await rpcHandler.handle(req, { prefix: "/rpc" });
      if (matched && response) {
        for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
        return response;
      }
    }

    return new Response("not found", { status: 404, headers: cors });
  },
});

console.log("Mock Sparks API listening on http://localhost:3001");
