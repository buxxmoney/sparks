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
import { eq } from "drizzle-orm";
import { adminListReviewQueue, adminReviewReconciliation } from "../admin";
import type { AuthContext } from "../middleware";
import {
  alertsAcknowledge,
  alertsList,
  alertsUnreadCount,
  invoicesConfirmReconcile,
  invoicesReopen,
  invoicesRequestReview,
  profileSetPhone,
  reconciliationGeneratePdf,
  reconciliationGet,
} from "../routers";

const db = getDb();

// confirmReconcile now returns reconId: string | null (null when reconciliation is
// deferred to Sparks, e.g. no landlord tariff). These tests set up a tariff, so a
// reconId is expected — assert it and narrow the type for the rest of the test.
async function confirmReconcileOk(
  ctx: AuthContext,
  input: Parameters<typeof invoicesConfirmReconcile>[1],
) {
  const r = await invoicesConfirmReconcile(ctx, input);
  if (r.reconId == null) throw new Error("test expected a reconId (scenario has a tariff)");
  return { ...r, reconId: r.reconId };
}

// The Invoice Review & QA overhaul: editable grouping → one-click confirm &
// reconcile → provisional recon → Sparks QA sign-off unlocks the sealed PDF.
describe("Invoice review & QA overhaul", () => {
  const orgId = "qa-org";
  const ownerUserId = "qa-owner";
  const operatorUserId = "qa-operator";
  let siteId: string;
  let billingPeriodId: string;
  let invoiceId: string;
  let activeLineId: string;
  let demandLineId: string;
  let waterLineId: string;

  const ownerCtx: AuthContext = { userId: ownerUserId, sessionId: "s-qa", organizationId: orgId };
  const operatorCtx: AuthContext = {
    userId: operatorUserId,
    sessionId: "s-op",
    organizationId: orgId,
  };

  beforeEach(async () => {
    await db.insert(user).values([
      { id: ownerUserId, email: "qa-owner@example.com", isPlatformOperator: false },
      { id: operatorUserId, email: "qa-op@example.com", isPlatformOperator: true },
    ]);
    await db.insert(organization).values({ id: orgId, name: "QA Org", slug: `qa-${Date.now()}`, createdAt: new Date() });

    const [site] = await db
      .insert(sites)
      .values({
        organizationId: orgId,
        name: "QA Site",
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
        serialNumber: `qa-dev-${Date.now()}`,
        hardwareModel: "rpi",
        apiKeyHash: "h",
        status: "online",
      })
      .returning();
    const [meter] = await db
      .insert(meters)
      .values({ deviceId: device.id, siteId, serialNumber: `qa-m-${Date.now()}`, model: "SDM630MCT" })
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

    const [tariff] = await db
      .insert(tariffProfiles)
      .values({
        organizationId: orgId,
        name: "QA Tariff",
        type: "landlord_stated",
        source: "custom",
        currency: "ZAR",
        effectiveFrom: new Date(2026, 0, 1),
      })
      .returning();
    await db.insert(tariffRates).values([
      {
        tariffProfileId: tariff.id,
        chargeType: "active_energy",
        unit: "c_per_kwh",
        rateValue: "2.50",
        season: "all",
        touPeriod: "all",
      },
    ]);
    await db.insert(siteTariffAssignments).values({
      siteId,
      tariffProfileId: tariff.id,
      role: "landlord",
      effectiveFrom: new Date(2026, 0, 1),
    });
    await db.insert(demandIntervals).values({
      meterId: meter.id,
      siteId,
      intervalStart: start,
      intervalMinutes: 30,
      activeEnergyKwh: "1200.000",
      reactiveEnergyKvarh: "0.000",
      avgDemandKw: "40.000",
      avgDemandKva: "55.000",
      avgPowerFactor: "0.7270",
      sampleCount: 30,
      expectedSamples: 30,
      isComplete: true,
      source: "live",
    });

    // Parsed invoice with three lines, one MIS-grouped as water (the parser's guess).
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
        parsedRaw: JSON.stringify({ totalCents: 900000 }),
        uploadedByUserId: ownerUserId,
      })
      .returning();
    invoiceId = invoice.id;

    const linesInserted = await db
      .insert(invoiceLineItems)
      .values([
        {
          invoiceId,
          rawLabel: "Active Energy 1200 kWh",
          parsedCategory: "active" as const,
          parsedValueCents: 300000,
          utility: "electricity",
          supplyGroup: "tenant",
          component: "active_energy",
          isImpermissibleAddOn: false,
        },
        {
          invoiceId,
          rawLabel: "Demand 55 kVA",
          parsedCategory: "demand" as const,
          parsedValueCents: 550000,
          utility: "electricity",
          supplyGroup: "tenant",
          component: "demand",
          isImpermissibleAddOn: false,
        },
        {
          // Parser mis-grouped this tenant-electricity line as water.
          invoiceId,
          rawLabel: "Network charge",
          parsedCategory: "other" as const,
          parsedValueCents: 50000,
          utility: "water",
          supplyGroup: "unknown",
          component: "volume",
          isImpermissibleAddOn: false,
        },
      ])
      .returning();
    activeLineId = linesInserted[0].id;
    demandLineId = linesInserted[1].id;
    waterLineId = linesInserted[2].id;
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

  it("confirm & reconcile: edited grouping drives the reconcilable base, locks, and lands provisional", async () => {
    // The user pulls the mis-grouped "Network charge" up into tenant electricity.
    const result = await confirmReconcileOk(ownerCtx, {
      invoiceId,
      lines: [
        { lineItemId: activeLineId, utility: "electricity", supplyGroup: "tenant", component: "active_energy", valueCents: 300000 },
        { lineItemId: demandLineId, utility: "electricity", supplyGroup: "tenant", component: "demand", valueCents: 550000 },
        { lineItemId: waterLineId, utility: "electricity", supplyGroup: "tenant", component: "service_fixed", valueCents: 50000 },
      ],
    });

    // Reconcilable base = all three tenant-electricity lines (900000), and the
    // per-component buckets follow the human-confirmed grouping.
    expect(result.reconcilableTotalCents).toBe(900000);
    expect(result.reviewStatus).toBe("provisional");

    const invoice = await db.query.landlordInvoices.findFirst({ where: eq(landlordInvoices.id, invoiceId) });
    expect(invoice?.status).toBe("locked");
    expect(invoice?.confirmedActiveCents).toBe(300000);
    expect(invoice?.confirmedDemandCents).toBe(550000);
    expect(invoice?.confirmedFixedCents).toBe(50000);
    expect(invoice?.confirmedTotalCents).toBe(900000);

    // The confirmed grouping is persisted on the line (the water line was pulled up).
    const water = await db.query.invoiceLineItems.findFirst({ where: eq(invoiceLineItems.id, waterLineId) });
    expect(water?.confirmedUtility).toBe("electricity");
    expect(water?.confirmedComponent).toBe("service_fixed");

    const recon = await reconciliationGet(ownerCtx, { reconId: result.reconId });
    expect(recon.reviewStatus).toBe("provisional");
    expect(recon.chargedTotalCents).toBe(900000);
  });

  it("keeps water out of the reconcilable base when left grouped as water", async () => {
    const result = await confirmReconcileOk(ownerCtx, {
      invoiceId,
      lines: [
        { lineItemId: activeLineId, utility: "electricity", supplyGroup: "tenant", component: "active_energy", valueCents: 300000 },
        { lineItemId: demandLineId, utility: "electricity", supplyGroup: "tenant", component: "demand", valueCents: 550000 },
        { lineItemId: waterLineId, utility: "water", supplyGroup: "unknown", component: "volume", valueCents: 50000 },
      ],
    });
    // Only the two electricity lines count → 850000, not 900000.
    expect(result.reconcilableTotalCents).toBe(850000);
  });

  it("gates the sealed PDF until Sparks signs off, and the queue surfaces the recon", async () => {
    const { reconId } = await confirmReconcileOk(ownerCtx, {
      invoiceId,
      lines: [
        { lineItemId: activeLineId, utility: "electricity", supplyGroup: "tenant", component: "active_energy", valueCents: 300000 },
        { lineItemId: demandLineId, utility: "electricity", supplyGroup: "tenant", component: "demand", valueCents: 550000 },
        { lineItemId: waterLineId, utility: "water", supplyGroup: "unknown", component: "volume", valueCents: 50000 },
      ],
    });

    // Provisional → the sealed PDF is refused.
    try {
      await reconciliationGeneratePdf(ownerCtx, { reconId });
      expect.unreachable("Should refuse to seal a provisional reconciliation");
    } catch (e) {
      expect((e as Error).message).toContain("under Sparks review");
    }

    // The operator QA queue lists it.
    const before = await adminListReviewQueue(operatorCtx);
    expect(before.queue.some((q) => q.reconId === reconId)).toBe(true);

    // A non-operator cannot see the queue.
    await expect(adminListReviewQueue(ownerCtx)).rejects.toThrow();

    // Operator signs it off → reviewed; it leaves the queue.
    const reviewed = await adminReviewReconciliation(operatorCtx, {
      reconId,
      status: "reviewed",
      subject: "Your bill review is complete",
      body: "We checked your charges against your meter — everything holds up.",
    });
    expect(reviewed.reconciliation.reviewStatus).toBe("reviewed");
    expect(reviewed.reconciliation.reviewedByUserId).toBe(operatorUserId);
    // The outcome was delivered to the customer (site owner via site_access grant).
    expect(reviewed.delivery?.recipientCount).toBeGreaterThanOrEqual(1);

    const after = await adminListReviewQueue(operatorCtx);
    expect(after.queue.some((q) => q.reconId === reconId)).toBe(false);

    const recon = await db.query.reconciliations.findFirst({ where: eq(reconciliations.id, reconId) });
    expect(recon?.reviewStatus).toBe("reviewed");
  });

  it("records a customer 'Send to Sparks' request and prioritises it in the queue", async () => {
    const { reconId } = await confirmReconcileOk(ownerCtx, {
      invoiceId,
      lines: [
        { lineItemId: activeLineId, utility: "electricity", supplyGroup: "tenant", component: "active_energy", valueCents: 300000 },
        { lineItemId: demandLineId, utility: "electricity", supplyGroup: "tenant", component: "demand", valueCents: 550000 },
        { lineItemId: waterLineId, utility: "water", supplyGroup: "unknown", component: "volume", valueCents: 50000 },
      ],
    });

    await invoicesRequestReview(ownerCtx, { invoiceId, note: "Please double-check the demand." });
    const invoice = await db.query.landlordInvoices.findFirst({ where: eq(landlordInvoices.id, invoiceId) });
    expect(invoice?.reviewRequestedAt).toBeTruthy();

    const queue = await adminListReviewQueue(operatorCtx);
    const entry = queue.queue.find((q) => q.reconId === reconId);
    expect(entry?.reviewRequestedAt).toBeTruthy();
    expect(entry?.reviewNote).toBe("Please double-check the demand.");
  });

  it("delivers the outcome to the customer's Alerts inbox and tracks read state", async () => {
    const { reconId } = await confirmReconcileOk(ownerCtx, {
      invoiceId,
      lines: [
        { lineItemId: activeLineId, utility: "electricity", supplyGroup: "tenant", component: "active_energy", valueCents: 300000 },
        { lineItemId: demandLineId, utility: "electricity", supplyGroup: "tenant", component: "demand", valueCents: 550000 },
        { lineItemId: waterLineId, utility: "water", supplyGroup: "unknown", component: "volume", valueCents: 50000 },
      ],
    });

    // Before any outcome, the inbox is empty.
    expect((await alertsUnreadCount(ownerCtx)).count).toBe(0);

    await adminReviewReconciliation(operatorCtx, {
      reconId,
      status: "reviewed",
      subject: "Bill review complete",
      body: "All good — verified.",
    });

    // The customer now has one unread inbox item linking back to the recon.
    expect((await alertsUnreadCount(ownerCtx)).count).toBe(1);
    const inbox = await alertsList(ownerCtx);
    expect(inbox.alerts.length).toBe(1);
    expect(inbox.alerts[0].title).toBe("Bill review complete");
    expect((inbox.alerts[0].payload as { reconId?: string }).reconId).toBe(reconId);
    expect(inbox.alerts[0].siteId).toBe(siteId);

    // Acknowledge → unread clears.
    await alertsAcknowledge(ownerCtx, { deliveryId: inbox.alerts[0].deliveryId });
    expect((await alertsUnreadCount(ownerCtx)).count).toBe(0);
  });

  it("saves and clears the profile phone number", async () => {
    const set = await profileSetPhone(ownerCtx, { phone: " +27 82 123 4567 " });
    expect(set.phone).toBe("+27 82 123 4567");
    const cleared = await profileSetPhone(ownerCtx, { phone: "" });
    expect(cleared.phone).toBeNull();
  });

  it("reopen unlocks the invoice and a regenerate makes a new version", async () => {
    const first = await confirmReconcileOk(ownerCtx, {
      invoiceId,
      lines: [
        { lineItemId: activeLineId, utility: "electricity", supplyGroup: "tenant", component: "active_energy", valueCents: 300000 },
        { lineItemId: demandLineId, utility: "electricity", supplyGroup: "tenant", component: "demand", valueCents: 550000 },
        { lineItemId: waterLineId, utility: "water", supplyGroup: "unknown", component: "volume", valueCents: 50000 },
      ],
    });
    expect(first.version).toBe(1);

    const reopened = await invoicesReopen(ownerCtx, { invoiceId });
    expect(reopened.invoice.status).toBe("parsed_pending_confirm");
    expect(reopened.invoice.lockedAt).toBeNull();

    // Regenerate after correcting the grouping → version 2 (prior version kept).
    const second = await confirmReconcileOk(ownerCtx, {
      invoiceId,
      lines: [
        { lineItemId: activeLineId, utility: "electricity", supplyGroup: "tenant", component: "active_energy", valueCents: 300000 },
        { lineItemId: demandLineId, utility: "electricity", supplyGroup: "tenant", component: "demand", valueCents: 550000 },
        { lineItemId: waterLineId, utility: "electricity", supplyGroup: "tenant", component: "service_fixed", valueCents: 50000 },
      ],
    });
    expect(second.version).toBe(2);
    expect(second.reconId).not.toBe(first.reconId);
  });
});
