import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  billingPeriods,
  demandIntervals,
  devices,
  getDb,
  invoiceLineItems,
  landlordInvoices,
  meters,
  reconciliations,
  siteAccess,
  siteTariffAssignments,
  sites,
  tariffProfiles,
  tariffRates,
} from "@sparks/db";
import type { AuthContext } from "../middleware";
import {
  invoicesConfirm,
  invoicesCreateUpload,
  invoicesGet,
  invoicesListLineItems,
  invoicesLock,
  invoicesUpdateLineItem,
  reconciliationGenerate,
  reconciliationGet,
} from "../routers";

const db = getDb();

describe("Invoice End-to-End Workflow", () => {
  const orgId = "test-org-e2e";
  const siteOwnerUserId = "test-owner-e2e";
  let siteId: string;
  let billingPeriodId: string;
  let landlordTariffId: string;

  const siteOwnerCtx: AuthContext = {
    userId: siteOwnerUserId,
    sessionId: "session-e2e-001",
    organizationId: orgId,
  };

  beforeEach(async () => {
    // Setup site
    const siteResult = await db
      .insert(sites)
      .values({
        organizationId: orgId,
        name: "E2E Test Site",
        timezone: "Africa/Johannesburg",
        demandIntervalMinutes: 30,
        status: "active",
      })
      .returning();

    siteId = siteResult[0].id;

    // Grant access
    await db.insert(siteAccess).values({
      siteId,
      userId: siteOwnerUserId,
      role: "owner",
    });

    // Create device & meter for demand data
    const deviceResult = await db
      .insert(devices)
      .values({
        siteId,
        serialNumber: `e2e-device-${Date.now()}`,
        hardwareModel: "rpi",
        apiKeyHash: "test-hash",
        status: "online",
      })
      .returning();

    const deviceId = deviceResult[0].id;

    const meterResult = await db
      .insert(meters)
      .values({
        deviceId,
        siteId,
        serialNumber: `e2e-meter-${Date.now()}`,
        model: "SDM630MCT",
      })
      .returning();

    const meterId = meterResult[0].id;

    // Create billing period
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const periodResult = await db
      .insert(billingPeriods)
      .values({
        siteId,
        periodStart: start,
        periodEnd: end,
        boundaryInclusivity: "half_open",
        demandIntervalMinutes: 30,
        source: "generated",
      })
      .returning();

    billingPeriodId = periodResult[0].id;

    // Create landlord tariff
    const tariffResult = await db
      .insert(tariffProfiles)
      .values({
        organizationId: orgId,
        name: "E2E Test Tariff",
        type: "landlord_stated",
        source: "custom",
        currency: "ZAR",
        effectiveFrom: new Date(2026, 0, 1),
      })
      .returning();

    landlordTariffId = tariffResult[0].id;

    // Add rates
    await db.insert(tariffRates).values([
      {
        tariffProfileId: landlordTariffId,
        chargeType: "active_energy",
        unit: "c_per_kwh",
        rateValue: "2.50",
        season: "all",
        touPeriod: "all",
      },
      {
        tariffProfileId: landlordTariffId,
        chargeType: "demand",
        unit: "r_per_kva",
        rateValue: "100.00",
        season: "all",
        touPeriod: "all",
      },
    ]);

    // Assign tariff to site
    await db.insert(siteTariffAssignments).values({
      siteId,
      tariffProfileId: landlordTariffId,
      role: "landlord",
      effectiveFrom: new Date(2026, 0, 1),
    });

    // Create demand intervals for reconciliation to measure against
    await db.insert(demandIntervals).values({
      meterId,
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
  });

  afterEach(async () => {
    // Delete in correct order to respect foreign key constraints
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
  });

  it("completes full workflow: upload → parse → confirm → lock → reconcile", async () => {
    // Step 1: Create invoice upload
    console.log("📤 Step 1: Upload invoice");
    const uploadResult = await invoicesCreateUpload(siteOwnerCtx, {
      siteId,
      billingPeriodId,
    });

    expect(uploadResult.invoiceId).toBeDefined();
    expect(uploadResult.presignedUrl).toBeDefined();
    expect(uploadResult.fileHash).toBeDefined();

    const invoiceId = uploadResult.invoiceId;

    // Verify invoice created in uploaded status
    const uploadedInvoice = await invoicesGet(siteOwnerCtx, { invoiceId });
    expect(uploadedInvoice.status).toBe("uploaded");
    expect(uploadedInvoice.billingPeriodId).toBe(billingPeriodId);
    console.log("✅ Invoice created with status=uploaded");

    // Step 2: Simulate parsing (manually add line items as Claude would)
    console.log("📝 Step 2: Parse invoice (simulated)");
    await db.update(landlordInvoices).set({
      status: "parsed_pending_confirm",
      parsedRaw: JSON.stringify({
        lineItems: [
          {
            rawLabel: "Active Energy 1200 kWh @ R2.50",
            category: "active",
            valueCents: 300000,
            confidence: 0.95,
          },
          {
            rawLabel: "Demand 55 kVA @ R100",
            category: "demand",
            valueCents: 550000,
            confidence: 0.92,
          },
        ],
        totalCents: 850000,
      }),
      parseModel: "claude-haiku-4-5-20251001",
    });

    await db.insert(invoiceLineItems).values([
      {
        invoiceId,
        rawLabel: "Active Energy 1200 kWh @ R2.50",
        parsedCategory: "active" as const,
        parsedValueCents: 300000,
        confidence: "0.95",
        isImpermissibleAddOn: false,
      },
      {
        invoiceId,
        rawLabel: "Demand 55 kVA @ R100",
        parsedCategory: "demand" as const,
        parsedValueCents: 550000,
        confidence: "0.92",
        isImpermissibleAddOn: false,
      },
    ]);

    // Verify parsed status
    const parsedInvoice = await invoicesGet(siteOwnerCtx, { invoiceId });
    expect(parsedInvoice.status).toBe("parsed_pending_confirm");
    expect(parsedInvoice.parseModel).toBe("claude-haiku-4-5-20251001");
    console.log("✅ Invoice parsed and line items created");

    // Step 3: List and verify line items
    console.log("🔍 Step 3: Review line items");
    const lineItemsResult = await invoicesListLineItems(siteOwnerCtx, {
      invoiceId,
    });

    expect(lineItemsResult.lineItems.length).toBe(2);
    expect(lineItemsResult.lineItems[0].rawLabel).toBe("Active Energy 1200 kWh @ R2.50");
    expect(lineItemsResult.lineItems[0].parsedValueCents).toBe(300000);
    expect(lineItemsResult.lineItems[1].parsedCategory).toBe("demand");
    console.log("✅ Line items verified");

    // Step 4: Update one line item (user correction)
    console.log("✏️ Step 4: User corrects line item");
    const lineItemId = lineItemsResult.lineItems[0].id;
    const updateResult = await invoicesUpdateLineItem(siteOwnerCtx, {
      lineItemId,
      confirmedCategory: "active",
      confirmedValueCents: 300000, // user confirmed same value
    });

    expect(updateResult.lineItem.confirmedCategory).toBe("active");
    expect(updateResult.lineItem.confirmedValueCents).toBe(300000);
    console.log("✅ Line item updated with user confirmation");

    // Step 5: Confirm invoice totals
    console.log("✔️ Step 5: Confirm invoice");
    const confirmResult = await invoicesConfirm(siteOwnerCtx, {
      invoiceId,
      confirmedActiveCents: 300000,
      confirmedDemandCents: 550000,
      confirmedReactiveCents: null,
      confirmedFixedCents: null,
      confirmedTotalCents: 850000,
    });

    expect(confirmResult.invoice.status).toBe("confirmed");
    expect(confirmResult.invoice.confirmedActiveCents).toBe(300000);
    expect(confirmResult.invoice.confirmedDemandCents).toBe(550000);
    expect(confirmResult.invoice.confirmedTotalCents).toBe(850000);
    expect(confirmResult.invoice.confirmedByUserId).toBe(siteOwnerUserId);
    expect(confirmResult.invoice.confirmedAt).toBeDefined();
    console.log("✅ Invoice confirmed by user");

    // Step 6: Lock invoice
    console.log("🔒 Step 6: Lock invoice");
    const lockResult = await invoicesLock(siteOwnerCtx, { invoiceId });

    expect(lockResult.invoice.status).toBe("locked");
    expect(lockResult.invoice.lockedAt).toBeDefined();
    console.log("✅ Invoice locked and ready for reconciliation");

    // Step 7: Generate reconciliation (only works with locked invoice)
    console.log("📊 Step 7: Generate reconciliation");
    const reconResult = await reconciliationGenerate(siteOwnerCtx, {
      billingPeriodId,
    });

    expect(reconResult.reconId).toBeDefined();
    expect(reconResult.status).toBe("draft");
    console.log("✅ Reconciliation generated successfully");

    // Step 8: Verify reconciliation has correct data
    console.log("🔎 Step 8: Verify reconciliation");
    const recon = await reconciliationGet(siteOwnerCtx, {
      reconId: reconResult.reconId,
    });

    expect(recon.invoiceId).toBe(invoiceId);
    expect(recon.billingPeriodId).toBe(billingPeriodId);
    expect(recon.chargedTotalCents).toBe(850000);
    expect(recon.measuredActiveKwh).toBe("1200.000");
    expect(recon.measuredMaxDemandKva).toBe("55.000");
    expect(recon.expectedLandlordCents).toBeDefined();
    console.log("✅ Reconciliation verified with measured data");

    console.log("\n✨ END-TO-END WORKFLOW COMPLETE: upload → parse → confirm → lock → reconcile");
  });

  it("rejects reconciliation without locked invoice", async () => {
    // Create an invoice but leave it unlocked (still parsed_pending_confirm).
    await invoicesCreateUpload(siteOwnerCtx, {
      siteId,
      billingPeriodId,
    });

    // R5 guard: reconciliation must not be generated against an unlocked invoice —
    // only a locked invoice's confirmed totals are dispute-grade.
    try {
      await reconciliationGenerate(siteOwnerCtx, { billingPeriodId });
      expect.unreachable("Should have thrown because the invoice is not locked");
    } catch (e) {
      expect((e as Error).message).toContain("locked");
    }
  });

  it("prevents state transitions in wrong order", async () => {
    const uploadResult = await invoicesCreateUpload(siteOwnerCtx, {
      siteId,
      billingPeriodId,
    });

    const invoiceId = uploadResult.invoiceId;

    // Try to confirm without parsing first
    try {
      await invoicesConfirm(siteOwnerCtx, {
        invoiceId,
        confirmedActiveCents: 100000,
        confirmedDemandCents: 100000,
        confirmedReactiveCents: null,
        confirmedFixedCents: null,
        confirmedTotalCents: 200000,
      });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("parsed_pending_confirm");
    }

    // Try to lock without confirming
    await db.update(landlordInvoices).set({
      status: "parsed_pending_confirm",
    });

    try {
      await invoicesLock(siteOwnerCtx, { invoiceId });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("confirmed");
    }
  });

  it("tracks user actions and timestamps", async () => {
    const uploadResult = await invoicesCreateUpload(siteOwnerCtx, {
      siteId,
      billingPeriodId,
    });

    const invoiceId = uploadResult.invoiceId;

    // Check upload
    const uploadedInvoice = await invoicesGet(siteOwnerCtx, { invoiceId });
    expect(uploadedInvoice.uploadedByUserId).toBe(siteOwnerUserId);
    expect(uploadedInvoice.createdAt).toBeDefined();

    // Simulate parsing
    await db.update(landlordInvoices).set({
      status: "parsed_pending_confirm",
    });

    // Confirm
    await db.update(landlordInvoices).set({
      status: "confirmed",
      confirmedActiveCents: 100000,
      confirmedDemandCents: 100000,
      confirmedReactiveCents: null,
      confirmedFixedCents: null,
      confirmedTotalCents: 200000,
      confirmedByUserId: siteOwnerUserId,
      confirmedAt: new Date(),
    });

    const confirmedInvoice = await invoicesGet(siteOwnerCtx, { invoiceId });
    expect(confirmedInvoice.confirmedByUserId).toBe(siteOwnerUserId);
    expect(confirmedInvoice.confirmedAt).toBeDefined();

    // Lock
    const lockResult = await invoicesLock(siteOwnerCtx, { invoiceId });
    expect(lockResult.invoice.lockedAt).toBeDefined();
  });
});
