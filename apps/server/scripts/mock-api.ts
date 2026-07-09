/**
 * Mock Sparks API for local visual work on the dashboard.
 * Serves better-auth's get-session endpoint plus the handful of oRPC
 * procedures the dashboard chrome + page call, using the real RPCHandler
 * so the wire format matches the typed client exactly.
 */
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";

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
    let kw = 140;
    if (hour >= 7 && hour < 10) kw = 140 + (hour - 7) * 110;
    else if (hour >= 10 && hour < 17) kw = 470 + Math.sin(hour) * 25;
    else if (hour >= 17 && hour < 21) kw = 470 - (hour - 17) * 80;
    kw += (Math.sin(t.getTime() / 7e6) + Math.cos(t.getTime() / 3e6)) * 18;
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
  activeEnergyKwh: (215_000 + Math.sin(i * 1.1) * 32_000 + i * 1_500).toFixed(0),
  reactiveEnergyKvarh: (68_000 + Math.cos(i * 0.9) * 9_000).toFixed(0),
}));

const siteDetail = {
  ...sites[0],
  timezone: "Africa/Johannesburg",
  supplyZone: "City Power JHB",
  demandIntervalMinutes: 30,
};

const devices = [
  {
    id: "dev_1",
    serialNumber: "SPK-4411-0092",
    status: "online",
    connectivityMode: "lte",
    lastSeenAt: new Date(Date.now() - 90_000).toISOString(),
  },
  {
    id: "dev_2",
    serialNumber: "SPK-4411-0117",
    status: "online",
    connectivityMode: "ethernet",
    lastSeenAt: new Date(Date.now() - 45_000).toISOString(),
  },
  {
    id: "dev_3",
    serialNumber: "SPK-3302-0061",
    status: "degraded",
    connectivityMode: "lte",
    lastSeenAt: new Date(Date.now() - 42 * 60_000).toISOString(),
  },
];

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
        totalPowerKw: "486.20",
        totalApparentKva: "531.75",
      },
    })),
    monthToDate: os.handler(async () => ({
      periodStart: new Date(2026, 6, 1).toISOString(),
      activeEnergyKwh: "61240.50",
      peakDemandKva: "612.40",
      reactiveEnergyKvarh: "18320.75",
    })),
    energyByPeriod: os.handler(async () => ({
      basis: "billing_period",
      periods: energyPeriods,
    })),
  },
  devices: {
    list: os.handler(async () => ({ devices })),
  },
  demand: {
    listIntervals: os.handler(async () => ({ intervals: makeIntervals() })),
  },
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
