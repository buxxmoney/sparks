/**
 * Upload the published tariff documents as Reference Tariff Schedules (the
 * operator-admin section: R2 storage + text extraction), then backfill the City
 * Power library profiles with verbatim source citations pointing at them — the
 * quotes the customer-facing "how we calculated this" view shows.
 *
 * Idempotent: schedules are matched by name; profile sources are overwritten
 * with the canonical set below on every run.
 *
 * Usage (from apps/server):
 *   bun scripts/upload-reference-schedules.ts <operatorEmail> [cojPdfPath] [eskomPdfPath]
 */
import { readFileSync } from "node:fs";
import "dotenv/config";
import { getDb, tariffProfiles, tariffSchedules, user } from "@sparks/db";
import { eq, inArray } from "drizzle-orm";
import { adminTariffSchedulesCreate } from "../src/admin";

const db = getDb();

const operatorEmail = process.argv[2];
if (!operatorEmail) {
  console.error(
    "Usage: bun scripts/upload-reference-schedules.ts <operatorEmail> [cojPdf] [eskomPdf]",
  );
  process.exit(1);
}
const home = process.env.HOME ?? "";
const cojPath = process.argv[3] ?? `${home}/Downloads/2026.27 Tariffs charges.pdf`;
const eskomPath =
  process.argv[4] ??
  `${home}/Downloads/20260226-Schedule-of-standard-prices-for-01-April-2026-Public-1.pdf`;

const operator = await db.query.user.findFirst({ where: eq(user.email, operatorEmail) });
if (!operator) {
  console.error(`✗ No user ${operatorEmail}`);
  process.exit(1);
}
const ctx = { userId: operator.id, sessionId: "upload-script", organizationId: "" };

async function ensureSchedule(opts: {
  name: string;
  provider: string;
  effectiveFrom: string;
  path: string;
}): Promise<string> {
  const existing = await db.query.tariffSchedules.findFirst({
    where: eq(tariffSchedules.name, opts.name),
  });
  if (existing) {
    console.log(`= schedule exists: ${opts.name} (${existing.extractionStatus})`);
    return existing.id;
  }
  const pdf = readFileSync(opts.path);
  const res = await adminTariffSchedulesCreate(ctx, {
    name: opts.name,
    provider: opts.provider,
    effectiveFrom: new Date(opts.effectiveFrom),
    filename: opts.path.split("/").pop() ?? "schedule.pdf",
    contentBase64: pdf.toString("base64"),
  });
  console.log(`+ uploaded: ${opts.name} (${pdf.length} bytes, extraction ${res.engine})`);
  // Extraction runs in the background of THIS process — wait for it so exiting
  // the script doesn't kill it mid-parse.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    const row = await db.query.tariffSchedules.findFirst({
      where: eq(tariffSchedules.id, res.scheduleId),
    });
    if (row && row.extractionStatus !== "pending") {
      console.log(`  extraction: ${row.extractionStatus} (${row.extractionEngine})`);
      return res.scheduleId;
    }
  }
  console.log("  extraction still pending after 5min — continuing (retry from operator admin)");
  return res.scheduleId;
}

const cojId = await ensureSchedule({
  name: "City Power Schedule of Approved Tariffs FY26/27",
  provider: "City of Johannesburg",
  effectiveFrom: "2026-07-01T00:00:00Z",
  path: cojPath,
});
const eskomId = await ensureSchedule({
  name: "Eskom Schedule of Standard Prices Apr 2026",
  provider: "Eskom",
  effectiveFrom: "2026-04-01T00:00:00Z",
  path: eskomPath,
});

/* ── Backfill the City Power profile citations ─────────────────────────────── */

const MIN_DEMAND_QUOTE = {
  title: "City Power Schedule of Approved Tariffs FY26/27",
  page: "p7",
  quote:
    "The minimum demand charge payable monthly in terms of this tariff shall be calculated using the greater of the following: I. Demand of 70 kVA; II. The actual measured demand, or; III. Demand based on the 80% average of the three highest demands recorded over the rolling preceding 12 months.",
  appliesTo: ["demand"],
  tariffScheduleId: cojId,
};
const NETWORK_SURCH_QUOTE = {
  title: "City Power Schedule of Approved Tariffs FY26/27",
  page: "p7",
  quote:
    "All customers will in addition to the above charges be liable for a Network Surcharge of 6c/kWh.",
  appliesTo: ["ancillary"],
  tariffScheduleId: cojId,
};
const REACTIVE_QUOTE = {
  title: "Eskom Schedule of Standard Prices (1 Apr 2026), tariff definitions",
  page: "¶14",
  quote:
    "a c/kVArh reactive energy charge supplied in excess of 30% (0,96 power factor or less) of the kWh recorded — verified on the landlord bills: billed kVArh equals metered kVArh minus 30% of kWh, to the third decimal, in every month.",
  appliesTo: ["reactive_energy"],
  tariffScheduleId: eskomId,
};
const FY2627_RATES_QUOTE = {
  title: "City Power Schedule of Approved Tariffs FY26/27 — Industrial LV",
  page: "p5",
  quote:
    "Industrial LV: Summer Energy Charge 284,96 c/kWh; Winter Energy Charge 333,79 c/kWh; All season Demand Charge R461,22/kVA; All season 46,25 c/kVArh; Service Charge R1 527,71/month; Capacity Charge R2 332,96/month.",
  appliesTo: ["rates"],
  tariffScheduleId: cojId,
};
const FY2526_RATES_QUOTE = {
  title: "Landlord bills (Metronomic reading returns, MAR–MAY 26, unit F112)",
  quote:
    'Printed "JHB E LVD NON-TOU" lines: ACTIVE ENERGY R2.6141/kWh; NETWORK DEMAND 70.000 kVA @ R423.1000; REACTIVE ENERGY R0.4243/kVArh; NETWORK SURCH R0.0600/kWh; SERV R1,401.44; NETWORK R2,140.13 — each FY26/27 published rate equals these ×1.0901.',
  appliesTo: ["rates"],
};
const BUSINESS_SURCH_QUOTE = {
  title: "Landlord bills (Metronomic reading returns, MAR–MAY 26, unit F112)",
  quote:
    'Every bill carries "JHB E LVD NON-TOU BUSINESS SURCH Basic @ R0.0200" — 2c per Rand on the energy + demand + reactive + service + network lines (the 6c/kWh Network Surcharge is excluded from the base).',
  appliesTo: ["surcharge"],
};

const SOURCES_BY_NAME: Record<string, unknown[]> = {
  "City Power Industrial LV (Non-TOU) FY25/26": [
    FY2526_RATES_QUOTE,
    MIN_DEMAND_QUOTE,
    REACTIVE_QUOTE,
    NETWORK_SURCH_QUOTE,
    BUSINESS_SURCH_QUOTE,
  ],
  "City Power Industrial LV (Non-TOU) FY26/27": [
    FY2627_RATES_QUOTE,
    MIN_DEMAND_QUOTE,
    REACTIVE_QUOTE,
    NETWORK_SURCH_QUOTE,
    BUSINESS_SURCH_QUOTE,
  ],
};

for (const [name, sources] of Object.entries(SOURCES_BY_NAME)) {
  const res = await db
    .update(tariffProfiles)
    .set({ sources })
    .where(inArray(tariffProfiles.name, [name]))
    .returning({ id: tariffProfiles.id, type: tariffProfiles.type });
  console.log(`~ sources set on ${res.length} profile(s): ${name}`);
}
console.log("done.");
process.exit(0);
