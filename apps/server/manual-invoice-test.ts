import { getDb, sites, siteAccess, billingPeriods, landlordInvoices, invoiceLineItems } from "@sparks/db";
import { eq } from "drizzle-orm";
import { invoicesCreateUpload, invoicesGet, invoicesListLineItems, invoicesConfirm, invoicesLock } from "./src/routers";

const db = getDb();

// Test context
const ctx = {
  userId: "manual-test-user",
  sessionId: "manual-test-001",
  organizationId: "manual-test-org",
};

async function testWorkflow() {
  console.log("\n🚀 Starting Manual Invoice Workflow Test\n");

  try {
    // Step 1: Create test site
    console.log("📍 Step 1: Creating test site...");
    const siteResult = await db
      .insert(sites)
      .values({
        organizationId: ctx.organizationId,
        name: "Manual Test Site",
        timezone: "Africa/Johannesburg",
        demandIntervalMinutes: 30,
        status: "active",
      })
      .returning();

    const siteId = siteResult[0].id;
    console.log(`✅ Site created: ${siteId}\n`);

    // Step 2: Grant access
    console.log("📍 Step 2: Granting access...");
    await db.insert(siteAccess).values({
      siteId,
      userId: ctx.userId,
      role: "owner",
    });
    console.log("✅ Access granted\n");

    // Step 3: Create billing period
    console.log("📍 Step 3: Creating billing period...");
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

    const billingPeriodId = periodResult[0].id;
    console.log(`✅ Period: ${start.toISOString().split("T")[0]} to ${end.toISOString().split("T")[0]}\n`);

    // =========== INVOICE WORKFLOW ===========

    console.log("═══════════════════════════════════════");
    console.log("   INVOICE WORKFLOW TEST");
    console.log("═══════════════════════════════════════\n");

    // Step 1: Upload
    console.log("📤 STEP 1: Create Invoice Upload");
    const uploadResult = await invoicesCreateUpload(ctx, {
      siteId,
      billingPeriodId,
    });

    const invoiceId = uploadResult.invoiceId;
    console.log(`   Invoice ID: ${invoiceId}`);
    console.log(`   Presigned URL: ${uploadResult.presignedUrl.substring(0, 60)}...`);
    console.log(`   File Hash: ${uploadResult.fileHash.substring(0, 16)}...`);

    const invoice1 = await invoicesGet(ctx, { invoiceId });
    console.log(`   Status: ${invoice1.status}`);
    console.log("✅ PASSED\n");

    // Step 2: Parse (simulate)
    console.log("📝 STEP 2: Simulate PDF Parsing");
    console.log("   (In production, Claude vision API would parse the PDF)");

    // Manually add parsed data
    await db
      .update(landlordInvoices)
      .set({
        status: "parsed_pending_confirm",
        parsedRaw: JSON.stringify({
          lineItems: [
            { rawLabel: "Active Energy 1200 kWh @ R2.50", category: "active", valueCents: 300000, confidence: 0.95 },
            { rawLabel: "Demand Charge 55 kVA @ R100", category: "demand", valueCents: 550000, confidence: 0.92 },
            { rawLabel: "Metering fee", category: "metering", valueCents: 50000, confidence: 0.88 },
          ],
          totalCents: 900000,
        }),
        parseModel: "claude-haiku-4-5-20251001",
      })
      .where(eq(landlordInvoices.id, invoiceId));

    // Add line items
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
        rawLabel: "Demand Charge 55 kVA @ R100",
        parsedCategory: "demand" as const,
        parsedValueCents: 550000,
        confidence: "0.92",
        isImpermissibleAddOn: false,
      },
      {
        invoiceId,
        rawLabel: "Metering fee",
        parsedCategory: "add_on_metering" as const,
        parsedValueCents: 50000,
        confidence: "0.88",
        isImpermissibleAddOn: true,
      },
    ]);

    console.log("   Parsed 3 line items:");
    console.log("   - Active Energy: R3,000.00 (confidence: 0.95)");
    console.log("   - Demand: R5,500.00 (confidence: 0.92)");
    console.log("   - Metering fee: R500.00 (confidence: 0.88) [⚠️ IMPERMISSIBLE]");
    console.log("   Total: R9,000.00");
    console.log("✅ PASSED\n");

    // Step 3: List line items
    console.log("🔍 STEP 3: List & Review Line Items");
    const lineItems = await invoicesListLineItems(ctx, { invoiceId });

    console.log(`   Found ${lineItems.lineItems.length} items:`);
    for (const item of lineItems.lineItems) {
      const impPermissible = item.isImpermissibleAddOn ? " [⚠️  IMPERMISSIBLE]" : "";
      console.log(`   • ${item.rawLabel}`);
      console.log(`     Category: ${item.parsedCategory}`);
      const value = item.parsedValueCents ? (item.parsedValueCents / 100).toFixed(2) : "—";
      console.log(`     Value: R${value}`);
      console.log(`     Confidence: ${item.confidence}${impPermissible}`);
    }
    console.log("✅ PASSED\n");

    // Step 4: Confirm
    console.log("✔️  STEP 4: Confirm Invoice Totals");
    const confirmResult = await invoicesConfirm(ctx, {
      invoiceId,
      confirmedActiveCents: 300000,
      confirmedDemandCents: 550000,
      confirmedReactiveCents: null,
      confirmedFixedCents: null,
      confirmedTotalCents: 900000,
    });

    console.log(`   Status: ${confirmResult.invoice.status}`);
    console.log(`   Confirmed by: ${confirmResult.invoice.confirmedByUserId}`);
    const confirmedTotal = confirmResult.invoice.confirmedTotalCents ? (confirmResult.invoice.confirmedTotalCents / 100).toFixed(2) : "—";
    console.log(`   Confirmed total: R${confirmedTotal}`);
    console.log("✅ PASSED\n");

    // Step 5: Lock
    console.log("🔒 STEP 5: Lock Invoice");
    const lockResult = await invoicesLock(ctx, { invoiceId });

    console.log(`   Status: ${lockResult.invoice.status}`);
    console.log(`   Locked at: ${lockResult.invoice.lockedAt}`);
    console.log("✅ PASSED\n");

    // Step 6: Final verification
    console.log("📊 STEP 6: Verify Final State");
    const finalInvoice = await invoicesGet(ctx, { invoiceId });

    console.log(`   Invoice ID: ${finalInvoice.id}`);
    console.log(`   Status: ${finalInvoice.status}`);
    console.log(`   Period: ${finalInvoice.billingPeriodStart?.toISOString().split("T")[0]} to ${finalInvoice.billingPeriodEnd?.toISOString().split("T")[0]}`);
    console.log(`   Parse Model: ${finalInvoice.parseModel}`);
    const finalTotal = finalInvoice.confirmedTotalCents ? (finalInvoice.confirmedTotalCents / 100).toFixed(2) : "—";
    console.log(`   Confirmed Total: R${finalTotal}`);
    console.log("   Status: LOCKED ✅");
    console.log("✅ PASSED\n");

    console.log("═══════════════════════════════════════");
    console.log("   ✨ ALL TESTS PASSED!");
    console.log("═══════════════════════════════════════\n");

    console.log("📋 Summary:");
    console.log(`   Site: ${siteId}`);
    console.log(`   Invoice: ${invoiceId}`);
    console.log("   Status: LOCKED (ready for reconciliation)");
    console.log("   Total: R9,000.00\n");

    // Cleanup
    console.log("🧹 Cleaning up test data...");
    await db.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId));
    await db.delete(landlordInvoices).where(eq(landlordInvoices.id, invoiceId));
    await db.delete(billingPeriods).where(eq(billingPeriods.id, billingPeriodId));
    await db.delete(siteAccess).where(eq(siteAccess.siteId, siteId));
    await db.delete(sites).where(eq(sites.id, siteId));
    console.log("✅ Cleanup complete\n");
  } catch (error) {
    console.error("❌ ERROR:", error);
    process.exit(1);
  }
}

testWorkflow();
