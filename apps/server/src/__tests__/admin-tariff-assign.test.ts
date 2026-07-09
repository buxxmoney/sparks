import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  billingPeriods,
  demandIntervals,
  devices,
  getDb,
  invoiceLineItems,
  landlordInvoices,
  meters,
  organization,
  reconciliations,
  siteAccess,
  siteTariffAssignments,
  sites,
  tariffProfiles,
  tariffRates,
  user,
} from "@sparks/db";
import { and, eq } from "drizzle-orm";
import {
  adminDeleteOrganization,
  adminListReviewQueue,
  adminListReviewedBills,
  adminReviewReconciliation,
} from "../admin";
import { ForbiddenError, type AuthContext } from "../middleware";
import {
  adminAssignSiteTariff,
  adminSiteTariffGet,
  invoicesConfirmReconcile,
} from "../routers";

const db = getDb();

// Operator assigns a landlord tariff in-app to fill a pending reconciliation's
// expected side (the "assign tariff" admin screen). Mirrors the seed-demo-data path.
describe("Operator assign-site-tariff", () => {
  const orgId = "assign-org";
  const ownerUserId = "assign-owner";
  const operatorUserId = "assign-operator";
  let siteId: string;
  let billingPeriodId: string;
  let invoiceId: string;
  let activeLineId: string;

  const ownerCtx: AuthContext = { userId: ownerUserId, sessionId: "s", organizationId: orgId };
  const operatorCtx: AuthContext = { userId: operatorUserId, sessionId: "s-op", organizationId: orgId };

  beforeEach(async () => {
    await db.insert(user).values([
      { id: ownerUserId, email: "assign-owner@example.com", isPlatformOperator: false },
      { id: operatorUserId, email: "assign-op@example.com", isPlatformOperator: true },
    ]);
    await db
      .insert(organization)
      .values({ id: orgId, name: "Assign Org", slug: `assign-${Date.now()}`, createdAt: new Date() });

    const [site] = await db
      .insert(sites)
      .values({
        organizationId: orgId,
        name: "Assign Site",
        timezone: "Africa/Johannesburg",
        demandIntervalMinutes: 30,
        status: "active",
      })
      .returning();
    siteId = site.id;
    await db.insert(siteAccess).values({ siteId, userId: ownerUserId, role: "owner" });

    const [device] = await db
      .insert(devices)
      .values({
        siteId,
        serialNumber: `assign-dev-${Date.now()}`,
        hardwareModel: "rpi",
        apiKeyHash: "h",
        status: "online",
      })
      .returning();
    const [meter] = await db
      .insert(meters)
      .values({ deviceId: device.id, siteId, serialNumber: `assign-m-${Date.now()}`, model: "SDM630MCT" })
      .returning();

    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const [period] = await db
      .insert(billingPeriods)
      .values({
        siteId,
        periodStart: start,
        periodEnd: end,
        boundaryInclusivity: "half_open",
        demandIntervalMinutes: 30,
        source: "invoice_derived",
      })
      .returning();
    billingPeriodId = period.id;

    await db.insert(demandIntervals).values({
      meterId: meter.id,
      siteId,
      intervalStart: start,
      intervalMinutes: 30,
      activeEnergyKwh: "1000.000",
      reactiveEnergyKvarh: "0.000",
      avgDemandKw: "40.000",
      avgDemandKva: "50.000",
      avgPowerFactor: "0.8000",
      sampleCount: 30,
      expectedSamples: 30,
      isComplete: true,
      source: "live",
    });

    // NOTE: no landlord tariff assignment is created — that's the whole point.
    const [invoice] = await db
      .insert(landlordInvoices)
      .values({
        siteId,
        billingPeriodId,
        billingPeriodStart: start,
        billingPeriodEnd: end,
        fileStorageKey: "k",
        fileHash: "fh",
        status: "parsed_pending_confirm",
        parsedRaw: JSON.stringify({ totalCents: 300000 }),
        uploadedByUserId: ownerUserId,
      })
      .returning();
    invoiceId = invoice.id;

    const [line] = await db
      .insert(invoiceLineItems)
      .values({
        invoiceId,
        rawLabel: "Active Energy 1000 kWh",
        parsedCategory: "active" as const,
        parsedValueCents: 300000,
        utility: "electricity",
        supplyGroup: "tenant",
        component: "active_energy",
        isImpermissibleAddOn: false,
      })
      .returning();
    activeLineId = line.id;
  });

  afterEach(async () => {
    await db.delete(reconciliations).where(true as never);
    await db.delete(demandIntervals).where(true as never);
    await db.delete(invoiceLineItems).where(true as never);
    await db.delete(landlordInvoices).where(true as never);
    await db.delete(meters).where(true as never);
    await db.delete(devices).where(true as never);
    await db.delete(siteTariffAssignments).where(true as never);
    await db.delete(tariffRates).where(true as never);
    await db.delete(tariffProfiles).where(true as never);
    await db.delete(billingPeriods).where(true as never);
    await db.delete(siteAccess).where(true as never);
    await db.delete(sites).where(true as never);
    await db.delete(organization).where(true as never);
    await db.delete(user).where(true as never);
  });

  it("turns a pending recon into a full one: assign tariff → expected side filled, queue deduped", async () => {
    // Customer sends the bill with no landlord tariff → provisional recon, expected pending.
    const confirmed = await invoicesConfirmReconcile(ownerCtx, {
      invoiceId,
      lines: [
        {
          lineItemId: activeLineId,
          utility: "electricity",
          supplyGroup: "tenant",
          component: "active_energy",
          valueCents: 300000,
        },
      ],
    });
    expect(confirmed.reconId).not.toBeNull();

    const pending = await db.query.reconciliations.findFirst({
      where: eq(reconciliations.billingPeriodId, billingPeriodId),
    });
    if (!pending) throw new Error("test expected a pending reconciliation");
    expect(pending.expectedLandlordCents).toBeNull();

    // Exactly one queue entry (the pending recon).
    const before = await adminListReviewQueue(operatorCtx);
    const beforeForPeriod = before.queue.filter((q) => q.billingPeriodId === billingPeriodId);
    expect(beforeForPeriod).toHaveLength(1);
    expect(beforeForPeriod[0].expectedLandlordCents).toBeNull();

    // Operator assigns a landlord tariff (R2.20/kWh) and recomputes.
    const res = await adminAssignSiteTariff(operatorCtx, {
      siteId,
      name: "Landlord tariff",
      effectiveFrom: pending.billingPeriodStart,
      rates: [{ chargeType: "active_energy", unit: "c_per_kwh", rateValue: "2.20" }],
      regenerateBillingPeriodId: billingPeriodId,
    });
    expect(res.regenerateError).toBeNull();
    expect(res.regenerated).not.toBeNull();

    // A new recon version now has the expected side filled: 1000 kWh × R2.20 = R2200 = 220000c.
    const versions = await db.query.reconciliations.findMany({
      where: eq(reconciliations.billingPeriodId, billingPeriodId),
    });
    expect(versions.length).toBe(2);
    const latest = versions.sort((a, b) => b.version - a.version)[0];
    expect(latest.expectedLandlordCents).toBe(220000);
    // Charged 300000 − expected 220000 = +80000 (overcharged).
    expect(latest.discrepancyVsLandlordCents).toBe(80000);

    // The queue is deduped to the latest version — still one entry, now with the expected side.
    const after = await adminListReviewQueue(operatorCtx);
    const afterForPeriod = after.queue.filter((q) => q.billingPeriodId === billingPeriodId);
    expect(afterForPeriod).toHaveLength(1);
    expect(afterForPeriod[0].expectedLandlordCents).toBe(220000);
    expect(afterForPeriod[0].version).toBe(latest.version);
  });

  it("responding moves a bill from the work queue to the searchable Reviewed history", async () => {
    await invoicesConfirmReconcile(ownerCtx, {
      invoiceId,
      lines: [
        {
          lineItemId: activeLineId,
          utility: "electricity",
          supplyGroup: "tenant",
          component: "active_energy",
          valueCents: 300000,
        },
      ],
    });
    await adminAssignSiteTariff(operatorCtx, {
      siteId,
      effectiveFrom: new Date(2020, 0, 1),
      rates: [{ chargeType: "active_energy", unit: "c_per_kwh", rateValue: "2.20" }],
      regenerateBillingPeriodId: billingPeriodId,
    });

    // In the work queue, and Reviewed history is empty.
    const work = await adminListReviewQueue(operatorCtx);
    const row = work.queue.find((q) => q.invoiceId === invoiceId);
    expect(row).toBeTruthy();
    expect(row?.reconId).toBeTruthy();
    expect((await adminListReviewedBills(operatorCtx, {})).total).toBe(0);

    // Operator verifies it → leaves the queue.
    await adminReviewReconciliation(operatorCtx, {
      reconId: row?.reconId as string,
      status: "reviewed",
      subject: "Done",
      body: "Everything checks out.",
    });
    const workAfter = await adminListReviewQueue(operatorCtx);
    expect(workAfter.queue.some((q) => q.invoiceId === invoiceId)).toBe(false);

    // …and appears in Reviewed history, searchable by site name.
    const reviewed = await adminListReviewedBills(operatorCtx, {});
    expect(reviewed.total).toBe(1);
    expect(reviewed.reviewed[0].reviewStatus).toBe("reviewed");
    expect(reviewed.reviewed[0].siteName).toBe("Assign Site");
    expect((await adminListReviewedBills(operatorCtx, { query: "Assign" })).total).toBe(1);
    expect((await adminListReviewedBills(operatorCtx, { query: "no-such-site" })).total).toBe(0);

    // Non-operators can't read the history.
    await expect(adminListReviewedBills(ownerCtx, {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("exposes the assigned tariff via siteTariffGet", async () => {
    const before = await adminSiteTariffGet(operatorCtx, { siteId });
    expect(before.assignment).toBeNull();
    expect(before.rates).toHaveLength(0);

    await adminAssignSiteTariff(operatorCtx, {
      siteId,
      name: "Landlord tariff",
      effectiveFrom: new Date(2020, 0, 1),
      rates: [
        { chargeType: "active_energy", unit: "c_per_kwh", rateValue: "2.20" },
        { chargeType: "demand", unit: "r_per_kva", rateValue: "95.00" },
      ],
    });

    const after = await adminSiteTariffGet(operatorCtx, { siteId });
    expect(after.assignment).not.toBeNull();
    expect(after.profile?.name).toBe("Landlord tariff");
    expect(after.rates).toHaveLength(2);
  });

  it("re-assigning supersedes the previous open landlord assignment", async () => {
    await adminAssignSiteTariff(operatorCtx, {
      siteId,
      effectiveFrom: new Date(2020, 0, 1),
      rates: [{ chargeType: "active_energy", unit: "c_per_kwh", rateValue: "2.00" }],
    });
    await adminAssignSiteTariff(operatorCtx, {
      siteId,
      effectiveFrom: new Date(2020, 0, 1),
      rates: [{ chargeType: "active_energy", unit: "c_per_kwh", rateValue: "3.00" }],
    });

    // Only one landlord assignment is still open.
    const open = await db.query.siteTariffAssignments.findMany({
      where: and(eq(siteTariffAssignments.siteId, siteId), eq(siteTariffAssignments.role, "landlord")),
    });
    expect(open.filter((a) => a.effectiveTo === null)).toHaveLength(1);
  });

  it("deletes an organization and cascades its sites + bills (ending a subscription)", async () => {
    // Produce a locked invoice + recon so there's site-scoped data to cascade.
    await invoicesConfirmReconcile(ownerCtx, {
      invoiceId,
      lines: [
        {
          lineItemId: activeLineId,
          utility: "electricity",
          supplyGroup: "tenant",
          component: "active_energy",
          valueCents: 300000,
        },
      ],
    });

    // Wrong confirmation name is refused.
    await expect(
      adminDeleteOrganization(operatorCtx, { organizationId: orgId, confirmName: "Wrong Name" }),
    ).rejects.toThrow();
    // Non-operators can't delete.
    await expect(
      adminDeleteOrganization(ownerCtx, { organizationId: orgId, confirmName: "Assign Org" }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const res = await adminDeleteOrganization(operatorCtx, {
      organizationId: orgId,
      confirmName: "Assign Org",
    });
    expect(res.siteCount).toBe(1);

    // Org, its site, its invoice and reconciliation are all gone.
    const orgLeft = await db.select().from(organization).where(eq(organization.id, orgId));
    expect(orgLeft).toHaveLength(0);
    expect(await db.query.sites.findFirst({ where: eq(sites.id, siteId) })).toBeFalsy();
    expect(
      await db.query.landlordInvoices.findFirst({ where: eq(landlordInvoices.id, invoiceId) }),
    ).toBeFalsy();
    expect(
      await db.query.reconciliations.findFirst({ where: eq(reconciliations.siteId, siteId) }),
    ).toBeFalsy();
  });

  it("requires platform-operator access", async () => {
    await expect(
      adminAssignSiteTariff(ownerCtx, {
        siteId,
        effectiveFrom: new Date(2020, 0, 1),
        rates: [{ chargeType: "active_energy", unit: "c_per_kwh", rateValue: "2.20" }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await expect(adminSiteTariffGet(ownerCtx, { siteId })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
