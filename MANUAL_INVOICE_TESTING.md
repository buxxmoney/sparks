# Manual Invoice Testing Guide

This guide walks you through testing the complete invoice workflow manually using the oRPC procedures.

## Prerequisites

1. Dev server running: `npm exec bun -- run dev` (from `apps/server`)
2. Postman, Curl, or similar HTTP client (or use browser DevTools)
3. Understand the oRPC endpoint structure

## oRPC Endpoint Reference

All invoice procedures are under the `invoices` namespace:
```
POST http://localhost:3001/rpc
Content-Type: application/json

Body: {
  "method": "invoices.PROCEDURE_NAME",
  "params": { ... input ... }
}
```

For authenticated calls, you need a valid session cookie from `better-auth`.

## Option A: Test via Bun/Node Script

Create a test script to automate the workflow:

```bash
cat > /tmp/invoice-test.ts << 'EOF'
import { invoicesCreateUpload, invoicesGet, invoicesListLineItems, invoicesConfirm, invoicesLock } from "@sparks/server/src/routers";
import { getDb } from "@sparks/db";

const db = getDb();

// Setup test context
const ctx = {
  userId: "test-user-manual",
  sessionId: "manual-test-001",
  organizationId: "test-org-manual",
};

async function testWorkflow() {
  console.log("🚀 Starting manual invoice workflow test\n");

  // Step 1: Create a test site
  console.log("📍 Creating test site...");
  const siteResult = await db.insert(sites).values({
    organizationId: ctx.organizationId,
    name: "Manual Test Site",
    timezone: "Africa/Johannesburg",
    demandIntervalMinutes: 30,
  }).returning();

  const siteId = siteResult[0].id;
  console.log(`✅ Site created: ${siteId}\n`);

  // Step 2: Grant access
  await db.insert(siteAccess).values({
    siteId,
    userId: ctx.userId,
    role: "owner",
  });

  // Step 3: Create billing period
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  const periodResult = await db.insert(billingPeriods).values({
    siteId,
    periodStart: start,
    periodEnd: end,
    boundaryInclusivity: "half_open",
    demandIntervalMinutes: 30,
    source: "generated",
  }).returning();

  const billingPeriodId = periodResult[0].id;
  console.log(`📅 Billing period created: ${start.toISOString()} to ${end.toISOString()}\n`);

  // === INVOICE WORKFLOW STARTS HERE ===

  // Step 1: Upload Invoice
  console.log("=== STEP 1: Upload Invoice ===");
  const uploadResult = await invoicesCreateUpload(ctx, {
    siteId,
    billingPeriodId,
  });

  const invoiceId = uploadResult.invoiceId;
  console.log(`✅ Invoice created: ${invoiceId}`);
  console.log(`📤 Presigned URL: ${uploadResult.presignedUrl}`);
  console.log(`📋 File hash: ${uploadResult.fileHash}\n`);

  // Step 2: Get invoice details
  console.log("=== STEP 2: Get Invoice Details ===");
  const invoice1 = await invoicesGet(ctx, { invoiceId });
  console.log(`Status: ${invoice1.status}`);
  console.log(`Created: ${invoice1.createdAt}\n`);

  // Step 3: Simulate parsing (in real flow, Claude would do this)
  console.log("=== STEP 3: Simulate Parsing ===");
  console.log("(In production, Claude vision API parses the PDF)");
  console.log("(Manually adding line items for testing)...\n");

  // Manually add line items (simulating Claude parse result)
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
          rawLabel: "Demand Charge 55 kVA @ R100",
          category: "demand",
          valueCents: 550000,
          confidence: 0.92,
        },
        {
          rawLabel: "Metering fee",
          category: "metering",
          valueCents: 50000,
          confidence: 0.88,
        },
      ],
      totalCents: 900000,
    }),
    parseModel: "claude-haiku-4-5-20251001",
  }).where(eq(landlordInvoices.id, invoiceId));

  // Add line items
  await db.insert(invoiceLineItems).values([
    {
      invoiceId,
      rawLabel: "Active Energy 1200 kWh @ R2.50",
      parsedCategory: "active",
      parsedValueCents: 300000,
      confidence: "0.95",
      isImpermissibleAddOn: false,
    },
    {
      invoiceId,
      rawLabel: "Demand Charge 55 kVA @ R100",
      parsedCategory: "demand",
      parsedValueCents: 550000,
      confidence: "0.92",
      isImpermissibleAddOn: false,
    },
    {
      invoiceId,
      rawLabel: "Metering fee",
      parsedCategory: "add_on_metering",
      parsedValueCents: 50000,
      confidence: "0.88",
      isImpermissibleAddOn: true,  // ← Flagged as impermissible
    },
  ]);

  console.log("✅ Invoice parsed with 3 line items");
  console.log("   - Active Energy: R3,000.00 (confidence: 0.95)");
  console.log("   - Demand: R5,500.00 (confidence: 0.92)");
  console.log("   - Metering fee: R500.00 (confidence: 0.88) [IMPERMISSIBLE ADD-ON]");
  console.log("   Total: R9,000.00\n");

  // Step 4: List line items
  console.log("=== STEP 4: Review Line Items ===");
  const lineItems = await invoicesListLineItems(ctx, { invoiceId });
  console.log(`Found ${lineItems.lineItems.length} line items:`);
  for (const item of lineItems.lineItems) {
    console.log(`  - ${item.rawLabel}`);
    console.log(`    Category: ${item.parsedCategory}`);
    console.log(`    Value: R${(item.parsedValueCents! / 100).toFixed(2)}`);
    console.log(`    Confidence: ${item.confidence}`);
    if (item.isImpermissibleAddOn) {
      console.log(`    ⚠️  IMPERMISSIBLE ADD-ON`);
    }
  }
  console.log();

  // Step 5: Confirm invoice
  console.log("=== STEP 5: Confirm Invoice ===");
  const confirmResult = await invoicesConfirm(ctx, {
    invoiceId,
    confirmedActiveCents: 300000,
    confirmedDemandCents: 550000,
    confirmedReactiveCents: null,
    confirmedFixedCents: null,
    confirmedTotalCents: 900000,  // Includes metering fee
  });

  console.log("✅ Invoice confirmed");
  console.log(`   Status: ${confirmResult.invoice.status}`);
  console.log(`   Confirmed by: ${confirmResult.invoice.confirmedByUserId}`);
  console.log(`   Confirmed at: ${confirmResult.invoice.confirmedAt}`);
  console.log(`   Total confirmed: R${(confirmResult.invoice.confirmedTotalCents! / 100).toFixed(2)}\n`);

  // Step 6: Lock invoice
  console.log("=== STEP 6: Lock Invoice ===");
  const lockResult = await invoicesLock(ctx, { invoiceId });

  console.log("✅ Invoice locked");
  console.log(`   Status: ${lockResult.invoice.status}`);
  console.log(`   Locked at: ${lockResult.invoice.lockedAt}\n`);

  // Step 7: Verify final state
  console.log("=== STEP 7: Final State ===");
  const finalInvoice = await invoicesGet(ctx, { invoiceId });
  console.log(`Invoice ID: ${finalInvoice.id}`);
  console.log(`Status: ${finalInvoice.status}`);
  console.log(`Period: ${finalInvoice.billingPeriodStart} to ${finalInvoice.billingPeriodEnd}`);
  console.log(`Parse Model: ${finalInvoice.parseModel}`);
  console.log(`Confirmed Total: R${(finalInvoice.confirmedTotalCents! / 100).toFixed(2)}`);
  console.log(`Locked: ✅\n`);

  console.log("🎉 INVOICE WORKFLOW COMPLETE!\n");
  console.log("Next step: Generate reconciliation against this locked invoice");
}

testWorkflow().catch(console.error);
EOF

npm exec bun -- run /tmp/invoice-test.ts
```

## Option B: Manual Test via HTTP (Postman/Curl)

### Prerequisites
1. Create a test user and get a valid session
2. Extract session cookie from the auth response
3. Make requests with the session cookie

### Test Flow

#### 1. Create Invoice Upload
```bash
curl -X POST http://localhost:3001/rpc \
  -H "Content-Type: application/json" \
  -H "Cookie: session=YOUR_SESSION_COOKIE" \
  -d '{
    "method": "invoices.createUpload",
    "params": {
      "siteId": "YOUR_SITE_ID",
      "billingPeriodId": "YOUR_BILLING_PERIOD_ID"
    }
  }'
```

**Response:**
```json
{
  "invoiceId": "uuid",
  "presignedUrl": "https://...",
  "fileHash": "sha256_hash"
}
```

#### 2. Upload PDF (simulated)
```bash
# In real flow, user uploads PDF to presignedUrl
# For testing, you can skip this and manually add line items
```

#### 3. Get Invoice
```bash
curl -X POST http://localhost:3001/rpc \
  -H "Content-Type: application/json" \
  -H "Cookie: session=YOUR_SESSION_COOKIE" \
  -d '{
    "method": "invoices.get",
    "params": {
      "invoiceId": "UUID_FROM_STEP_1"
    }
  }'
```

#### 4. Manually Add Line Items (for testing)
```sql
-- Run in your database to simulate Claude parsing
UPDATE landlord_invoices 
SET 
  status = 'parsed_pending_confirm',
  parsed_raw = '{"lineItems": [...], "totalCents": 900000}',
  parse_model = 'claude-haiku-4-5-20251001'
WHERE id = 'YOUR_INVOICE_ID';

INSERT INTO invoice_line_items (invoice_id, raw_label, parsed_category, parsed_value_cents, confidence, is_impermissible_add_on)
VALUES
  ('YOUR_INVOICE_ID', 'Active Energy', 'active', 300000, '0.95', false),
  ('YOUR_INVOICE_ID', 'Demand Charge', 'demand', 550000, '0.92', false),
  ('YOUR_INVOICE_ID', 'Metering Fee', 'add_on_metering', 50000, '0.88', true);
```

#### 5. List Line Items
```bash
curl -X POST http://localhost:3001/rpc \
  -H "Content-Type: application/json" \
  -H "Cookie: session=YOUR_SESSION_COOKIE" \
  -d '{
    "method": "invoices.listLineItems",
    "params": {
      "invoiceId": "UUID_FROM_STEP_1"
    }
  }'
```

**Response:**
```json
{
  "lineItems": [
    {
      "id": "uuid",
      "rawLabel": "Active Energy 1200 kWh @ R2.50",
      "parsedCategory": "active",
      "parsedValueCents": 300000,
      "confidence": "0.95",
      "isImpermissibleAddOn": false
    },
    ...
  ]
}
```

#### 6. Confirm Invoice
```bash
curl -X POST http://localhost:3001/rpc \
  -H "Content-Type: application/json" \
  -H "Cookie: session=YOUR_SESSION_COOKIE" \
  -d '{
    "method": "invoices.confirm",
    "params": {
      "invoiceId": "UUID_FROM_STEP_1",
      "confirmedActiveCents": 300000,
      "confirmedDemandCents": 550000,
      "confirmedReactiveCents": null,
      "confirmedFixedCents": null,
      "confirmedTotalCents": 900000
    }
  }'
```

**Response:**
```json
{
  "invoice": {
    "id": "uuid",
    "status": "confirmed",
    "confirmedByUserId": "user_id",
    "confirmedAt": "2026-07-03T...",
    "confirmedTotalCents": 900000
  }
}
```

#### 7. Lock Invoice
```bash
curl -X POST http://localhost:3001/rpc \
  -H "Content-Type: application/json" \
  -H "Cookie: session=YOUR_SESSION_COOKIE" \
  -d '{
    "method": "invoices.lock",
    "params": {
      "invoiceId": "UUID_FROM_STEP_1"
    }
  }'
```

**Response:**
```json
{
  "invoice": {
    "id": "uuid",
    "status": "locked",
    "lockedAt": "2026-07-03T..."
  }
}
```

## What to Test

### Happy Path ✅
- [ ] Create invoice upload
- [ ] List line items with confidence scores
- [ ] Confirm invoice with totals
- [ ] Lock invoice (only after confirm)
- [ ] Verify locked status prevents further editing

### Error Cases ❌
- [ ] Try to confirm without parsing first → should error
- [ ] Try to lock without confirming first → should error
- [ ] Try to update line items after confirming → should error

### Impermissible Add-Ons 🚩
- [ ] Verify "Metering fee" is flagged as `isImpermissibleAddOn: true`
- [ ] Verify "Admin charge" gets flagged
- [ ] Verify "Vending fee" gets flagged
- [ ] Verify regular charges are NOT flagged

### Low Confidence Fields 👀
- [ ] Create line item with confidence < 0.7
- [ ] Verify it appears in listLineItems response
- [ ] UI should highlight for user review

### Reconciliation Integration 📊
- [ ] Lock an invoice
- [ ] Call `reconciliation.generate(billingPeriodId)`
- [ ] Verify reconciliation reads the locked invoice data
- [ ] Verify `chargedTotalCents` matches invoice total

## Troubleshooting

### "Invoice not found"
- Verify `invoiceId` UUID is correct
- Check invoice exists in database

### "Invoice must be in parsed_pending_confirm status"
- Manually set status in database (see Step 4)
- Or write a Claude parser worker

### "Cannot confirm - invoice not in parsed_pending_confirm"
- Make sure you set status before confirming
- Line items must exist first

### "Cannot lock - invoice not confirmed"
- Call `confirm` before `lock`
- Verify status changed to "confirmed"

## Next: Reconciliation Testing

Once invoice is locked, you can test reconciliation:

```bash
curl -X POST http://localhost:3001/rpc \
  -H "Content-Type: application/json" \
  -H "Cookie: session=YOUR_SESSION_COOKIE" \
  -d '{
    "method": "reconciliation.generate",
    "params": {
      "billingPeriodId": "YOUR_BILLING_PERIOD_ID"
    }
  }'
```

Should return reconciliation with `chargedTotalCents: 900000` (from locked invoice).

---

Feel free to test and report any issues!
