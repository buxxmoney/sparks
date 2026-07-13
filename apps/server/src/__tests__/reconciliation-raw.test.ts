import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  billingPeriods,
  demandIntervals,
  getDb,
  landlordInvoices,
  meters,
  reconciliations,
  siteAccess,
  sites,
} from "@sparks/db";
import { eq, sql } from "drizzle-orm";
import type { AuthContext } from "../middleware";
import { reconciliationGenerate } from "../routers";

// End-to-end proof that reconciliation now sources its MEASURED side from the raw `readings`
// table the Pi writes to (via materializeDemandIntervalsFromRaw → deriveMeterIntervals), not
// the previously-empty demand_intervals table. We seed raw rows and assert the stored recon.
//
// Locally, `readings` carries BOTH the app's old shape and the raw columns (superset), and
// `time` is a NOT-NULL PK column — so the seed sets `time = measured_at`. Prod's `readings`
// is raw-only; the Pi never sets `time`.

const db = getDb();

const orgId = "recon-raw-org";
const ownerUserId = "recon-raw-owner";
const ctx: AuthContext = { userId: ownerUserId, sessionId: "recon-raw-sess", organizationId: orgId };

let siteId: string;
let meterId: string;
let billingPeriodId: string;

async function seedRaw(
  iso: string,
  fields: { kwh?: number; kvarh?: number; kvah?: number; powerW?: number; vaTotal?: number },
) {
  await db.execute(sql`
    INSERT INTO readings (meter_id, "time", measured_at, energy_import_kwh, energy_import_kvarh, energy_kvah, power_total, va_total)
    VALUES (${meterId}, ${iso}, ${iso}, ${fields.kwh ?? null}, ${fields.kvarh ?? null}, ${fields.kvah ?? null}, ${fields.powerW ?? null}, ${fields.vaTotal ?? null})
  `);
}

beforeEach(async () => {
  const [site] = await db
    .insert(sites)
    .values({
      organizationId: orgId,
      name: "Recon Raw Site",
      timezone: "Africa/Johannesburg",
      demandIntervalMinutes: 30,
      status: "active",
    })
    .returning();
  siteId = site.id;

  await db.insert(siteAccess).values({ siteId, userId: ownerUserId, role: "owner" });

  const [meter] = await db
    .insert(meters)
    .values({ siteId, serialNumber: `recon-raw-${Date.now()}`, model: "SDM630" })
    .returning();
  meterId = meter.id;

  const [period] = await db
    .insert(billingPeriods)
    .values({
      siteId,
      periodStart: new Date("2026-08-01T00:00:00Z"),
      periodEnd: new Date("2026-09-01T00:00:00Z"),
      boundaryInclusivity: "half_open",
      demandIntervalMinutes: 30,
      label: "Aug 2026",
      status: "open",
    })
    .returning();
  billingPeriodId = period.id;

  // A locked invoice is required to generate a reconciliation.
  await db.insert(landlordInvoices).values({
    siteId,
    billingPeriodId,
    billingPeriodStart: new Date("2026-08-01T00:00:00Z"),
    billingPeriodEnd: new Date("2026-09-01T00:00:00Z"),
    fileStorageKey: "recon-raw.pdf",
    fileHash: "recon-raw-hash",
    status: "locked",
    confirmedActiveCents: 10000,
    confirmedDemandCents: 5000,
    confirmedTotalCents: 15000,
    confirmedByUserId: ownerUserId,
    confirmedAt: new Date(),
    lockedAt: new Date(),
  });
});

afterEach(async () => {
  await db.delete(reconciliations).where(eq(reconciliations.siteId, siteId));
  await db.delete(demandIntervals).where(eq(demandIntervals.siteId, siteId));
  await db.execute(sql`DELETE FROM readings WHERE meter_id = ${meterId}`);
  await db.delete(landlordInvoices).where(eq(landlordInvoices.siteId, siteId));
  await db.delete(billingPeriods).where(eq(billingPeriods.siteId, siteId));
  await db.delete(meters).where(eq(meters.id, meterId));
  await db.delete(siteAccess).where(eq(siteAccess.siteId, siteId));
  await db.delete(sites).where(eq(sites.id, siteId));
});

describe("reconciliation measured side from raw readings", () => {
  it("derives measured active energy + peak demand from the raw `readings` table", async () => {
    // Cumulative registers over two 30-min intervals inside the period.
    // active kWh: 1000 → 1005 → 1009  (interval deltas 5, 4 → total 9)
    // apparent kVAh: 1000 → 1006 → 1011 (deltas 6, 5 → demand 12, 10 kVA at /0.5h)
    await seedRaw("2026-08-10T00:00:00Z", { kwh: 1000, kvah: 1000 });
    await seedRaw("2026-08-10T00:30:00Z", { kwh: 1005, kvah: 1006 });
    await seedRaw("2026-08-10T01:00:00Z", { kwh: 1009, kvah: 1011 });

    const result = await reconciliationGenerate(ctx, { billingPeriodId });

    const recon = await db.query.reconciliations.findFirst({
      where: eq(reconciliations.id, result.reconId),
    });
    expect(recon).toBeTruthy();
    // Σ interval energy telescopes to the register delta (1009 − 1000 = 9 kWh).
    expect(Number(recon?.measuredActiveKwh)).toBeCloseTo(9, 3);
    // Peak interval-average demand = 6 kVAh / 0.5h = 12 kVA (the first interval).
    expect(Number(recon?.measuredMaxDemandKva)).toBeCloseTo(12, 3);
    // demand_intervals were materialized from the raw rows.
    const di = await db.select().from(demandIntervals).where(eq(demandIntervals.siteId, siteId));
    expect(di.length).toBeGreaterThanOrEqual(2);
  });

  it("produces a zero measured side when the site has no raw readings", async () => {
    const result = await reconciliationGenerate(ctx, { billingPeriodId });
    const recon = await db.query.reconciliations.findFirst({
      where: eq(reconciliations.id, result.reconId),
    });
    expect(Number(recon?.measuredActiveKwh)).toBe(0);
  });
});
