import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  getDb,
  sites,
  siteAccess,
  billingPeriods,
  landlordInvoices,
  invoiceLineItems,
} from "@sparks/db";
import { eq } from "drizzle-orm";
import type { AuthContext } from "../middleware";
import {
  invoicesCreateUpload,
  invoicesGet,
  invoicesList,
  invoicesListLineItems,
  invoicesUpdateLineItem,
  invoicesConfirm,
  invoicesLock,
} from "../routers";
import { categorizeLineItem } from "../invoices";

const db = getDb();

describe("Invoice Management", () => {
  const orgId = "test-org-invoice";
  const siteOwnerUserId = "test-site-owner-invoice";
  let siteId: string;
  let billingPeriodId: string;

  const siteOwnerCtx: AuthContext = {
    userId: siteOwnerUserId,
    sessionId: "session-invoice-001",
    organizationId: orgId,
  };

  beforeEach(async () => {
    const siteResult = await db
      .insert(sites)
      .values({
        organizationId: orgId,
        name: "Test Invoice Site",
        timezone: "Africa/Johannesburg",
        demandIntervalMinutes: 30,
        status: "active",
      })
      .returning();

    siteId = siteResult[0].id;

    await db.insert(siteAccess).values({
      siteId,
      userId: siteOwnerUserId,
      role: "owner",
    });

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
  });

  afterEach(async () => {
    await db.delete(invoiceLineItems).where(true as never);
    await db.delete(landlordInvoices).where(true as never);
    await db.delete(billingPeriods).where(true as never);
    await db.delete(siteAccess).where(true as never);
    await db.delete(sites).where(true as never);
  });

  it("creates invoice upload and returns presigned URL", async () => {
    const result = await invoicesCreateUpload(siteOwnerCtx, {
      siteId,
      billingPeriodId,
    });

    expect(result.invoiceId).toBeDefined();
    expect(result.presignedUrl).toBeDefined();
    expect(result.fileHash).toBeDefined();

    const invoice = await db.query.landlordInvoices.findFirst({
      where: eq(landlordInvoices.id, result.invoiceId),
    });

    expect(invoice).toBeDefined();
    expect(invoice?.status).toBe("uploaded");
    expect(invoice?.billingPeriodId).toBe(billingPeriodId);
  });

  it("gets invoice by ID", async () => {
    const createResult = await invoicesCreateUpload(siteOwnerCtx, {
      siteId,
      billingPeriodId,
    });

    const getResult = await invoicesGet(siteOwnerCtx, {
      invoiceId: createResult.invoiceId,
    });

    expect(getResult.id).toBe(createResult.invoiceId);
    expect(getResult.status).toBe("uploaded");
  });

  it("lists invoices for a site", async () => {
    await invoicesCreateUpload(siteOwnerCtx, {
      siteId,
      billingPeriodId,
    });

    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 2, 0);

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

    await invoicesCreateUpload(siteOwnerCtx, {
      siteId,
      billingPeriodId: periodResult[0].id,
    });

    const listResult = await invoicesList(siteOwnerCtx, { siteId });

    expect(listResult.invoices.length).toBe(2);
    expect(listResult.total).toBe(2);
  });

  it("lists line items for an invoice after parsing", async () => {
    const createResult = await invoicesCreateUpload(siteOwnerCtx, {
      siteId,
      billingPeriodId,
    });

    const invoiceId = createResult.invoiceId;

    await db.update(landlordInvoices).set({
      status: "parsed_pending_confirm",
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
      {
        invoiceId,
        rawLabel: "Metering add-on",
        parsedCategory: "add_on_metering" as const,
        parsedValueCents: 50000,
        confidence: "0.88",
        isImpermissibleAddOn: true,
      },
    ]);

    const listResult = await invoicesListLineItems(siteOwnerCtx, {
      invoiceId,
    });

    expect(listResult.lineItems.length).toBe(3);
    expect(listResult.lineItems[0].rawLabel).toBe("Active Energy 1200 kWh @ R2.50");
    expect(listResult.lineItems[2].isImpermissibleAddOn).toBe(true);
  });

  it("surfaces low-confidence fields for user review", async () => {
    const createResult = await invoicesCreateUpload(siteOwnerCtx, {
      siteId,
      billingPeriodId,
    });

    const invoiceId = createResult.invoiceId;

    await db.update(landlordInvoices).set({
      status: "parsed_pending_confirm",
    });

    await db.insert(invoiceLineItems).values([
      {
        invoiceId,
        rawLabel: "Unclear charge",
        parsedCategory: "other" as const,
        parsedValueCents: 100000,
        confidence: "0.55",
        isImpermissibleAddOn: false,
      },
    ]);

    const listResult = await invoicesListLineItems(siteOwnerCtx, {
      invoiceId,
    });

    const lowConfidenceItem = listResult.lineItems[0];
    const confidence = lowConfidenceItem.confidence ? Number.parseFloat(lowConfidenceItem.confidence.toString()) : 0;
    expect(confidence).toBeLessThan(0.7);
  });

  it("updates line item with confirmed category and value", async () => {
    const createResult = await invoicesCreateUpload(siteOwnerCtx, {
      siteId,
      billingPeriodId,
    });

    const invoiceId = createResult.invoiceId;

    await db.update(landlordInvoices).set({
      status: "parsed_pending_confirm",
    });

    const lineItemResult = await db
      .insert(invoiceLineItems)
      .values({
        invoiceId,
        rawLabel: "Ambiguous charge",
        parsedCategory: "other" as const,
        parsedValueCents: 100000,
        confidence: "0.60",
        isImpermissibleAddOn: false,
      })
      .returning();

    const lineItemId = lineItemResult[0].id;

    const updateResult = await invoicesUpdateLineItem(siteOwnerCtx, {
      lineItemId,
      confirmedCategory: "fixed",
      confirmedValueCents: 120000,
    });

    expect(updateResult.lineItem.confirmedCategory).toBe("fixed");
    expect(updateResult.lineItem.confirmedValueCents).toBe(120000);
  });

  it("rejects line item update if invoice not in parsed_pending_confirm status", async () => {
    const createResult = await invoicesCreateUpload(siteOwnerCtx, {
      siteId,
      billingPeriodId,
    });

    const invoiceId = createResult.invoiceId;

    const lineItemResult = await db
      .insert(invoiceLineItems)
      .values({
        invoiceId,
        rawLabel: "Test charge",
        parsedCategory: "active" as const,
        parsedValueCents: 100000,
        confidence: "0.90",
        isImpermissibleAddOn: false,
      })
      .returning();

    const lineItemId = lineItemResult[0].id;

    try {
      await invoicesUpdateLineItem(siteOwnerCtx, {
        lineItemId,
        confirmedCategory: "fixed",
        confirmedValueCents: 120000,
      });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("parsed_pending_confirm");
    }
  });

  it("confirms invoice with totals", async () => {
    const createResult = await invoicesCreateUpload(siteOwnerCtx, {
      siteId,
      billingPeriodId,
    });

    const invoiceId = createResult.invoiceId;

    await db.update(landlordInvoices).set({
      status: "parsed_pending_confirm",
    });

    const confirmResult = await invoicesConfirm(siteOwnerCtx, {
      invoiceId,
      confirmedActiveCents: 300000,
      confirmedDemandCents: 550000,
      confirmedReactiveCents: null,
      confirmedFixedCents: 50000,
      confirmedTotalCents: 900000,
    });

    expect(confirmResult.invoice.status).toBe("confirmed");
    expect(confirmResult.invoice.confirmedActiveCents).toBe(300000);
    expect(confirmResult.invoice.confirmedTotalCents).toBe(900000);
    expect(confirmResult.invoice.confirmedByUserId).toBe(siteOwnerUserId);
    expect(confirmResult.invoice.confirmedAt).toBeDefined();
  });

  it("rejects confirm if invoice not in parsed_pending_confirm status", async () => {
    const createResult = await invoicesCreateUpload(siteOwnerCtx, {
      siteId,
      billingPeriodId,
    });

    const invoiceId = createResult.invoiceId;

    try {
      await invoicesConfirm(siteOwnerCtx, {
        invoiceId,
        confirmedActiveCents: 300000,
        confirmedDemandCents: 550000,
        confirmedReactiveCents: null,
        confirmedFixedCents: 50000,
        confirmedTotalCents: 900000,
      });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("parsed_pending_confirm");
    }
  });

  it("locks invoice after confirmation", async () => {
    const createResult = await invoicesCreateUpload(siteOwnerCtx, {
      siteId,
      billingPeriodId,
    });

    const invoiceId = createResult.invoiceId;

    await db.update(landlordInvoices).set({
      status: "parsed_pending_confirm",
    });

    await invoicesConfirm(siteOwnerCtx, {
      invoiceId,
      confirmedActiveCents: 300000,
      confirmedDemandCents: 550000,
      confirmedReactiveCents: null,
      confirmedFixedCents: 50000,
      confirmedTotalCents: 900000,
    });

    const lockResult = await invoicesLock(siteOwnerCtx, {
      invoiceId,
    });

    expect(lockResult.invoice.status).toBe("locked");
    expect(lockResult.invoice.lockedAt).toBeDefined();
  });

  it("rejects lock before confirm", async () => {
    const createResult = await invoicesCreateUpload(siteOwnerCtx, {
      siteId,
      billingPeriodId,
    });

    const invoiceId = createResult.invoiceId;

    await db.update(landlordInvoices).set({
      status: "parsed_pending_confirm",
    });

    try {
      await invoicesLock(siteOwnerCtx, {
        invoiceId,
      });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("confirmed");
    }
  });

  it("enforces confirm→lock transition", async () => {
    const createResult = await invoicesCreateUpload(siteOwnerCtx, {
      siteId,
      billingPeriodId,
    });

    const invoiceId = createResult.invoiceId;

    await db.update(landlordInvoices).set({
      status: "parsed_pending_confirm",
    });

    await invoicesConfirm(siteOwnerCtx, {
      invoiceId,
      confirmedActiveCents: 300000,
      confirmedDemandCents: 550000,
      confirmedReactiveCents: null,
      confirmedFixedCents: 50000,
      confirmedTotalCents: 900000,
    });

    const beforeLock = await invoicesGet(siteOwnerCtx, { invoiceId });
    expect(beforeLock.status).toBe("confirmed");

    await invoicesLock(siteOwnerCtx, { invoiceId });

    const afterLock = await invoicesGet(siteOwnerCtx, { invoiceId });
    expect(afterLock.status).toBe("locked");
  });
});

describe("Line Category Categorization", () => {
  it("categorizes standard charge types", () => {
    const testCases = [
      { label: "Active Energy", category: "active", expected: "active", impermissible: false },
      { label: "Demand Charge", category: "demand", expected: "demand", impermissible: false },
      { label: "VAT", category: "vat", expected: "vat", impermissible: false },
      { label: "Monthly Fixed", category: "fixed", expected: "fixed", impermissible: false },
    ];

    for (const testCase of testCases) {
      const { category, isImpermissible } = categorizeLineItem(testCase.label, testCase.category);
      expect(category).toBe(testCase.expected);
      expect(isImpermissible).toBe(testCase.impermissible);
    }
  });

  it("flags impermissible add-ons", () => {
    const testCases = [
      { label: "Metering fee", category: "metering", impermissible: true },
      { label: "Admin charge", category: "admin", impermissible: true },
      { label: "Vending fee", category: "vending", impermissible: true },
      { label: "Reading surcharge", category: "metering", impermissible: true },
      { label: "Nett metering adjustment", category: "metering", impermissible: true },
    ];

    for (const testCase of testCases) {
      const { isImpermissible } = categorizeLineItem(testCase.label, testCase.category);
      expect(isImpermissible).toBe(testCase.impermissible);
    }
  });

  it("handles unknown categories gracefully", () => {
    const { category, isImpermissible } = categorizeLineItem(
      "Unknown item",
      "unknown_type",
    );
    expect(category).toBeDefined();
    expect(typeof isImpermissible).toBe("boolean");
  });
});
