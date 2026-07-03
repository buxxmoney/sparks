import { db, landlordInvoices, invoiceLineItems } from "@sparks/db";
import { eq } from "drizzle-orm";
import { Anthropic } from "@anthropic-ai/sdk";

export interface ParsedLineItem {
  rawLabel: string;
  category: string;
  valueCents: number;
  confidence: number;
}

export interface ParsedInvoice {
  lineItems: ParsedLineItem[];
  totalCents: number;
  parseModel: string;
}

const IMPERMISSIBLE_ADD_ON_KEYWORDS = ["metering", "admin", "vending", "nett", "reading"];

export function categorizeLineItem(label: string, category: string): {
  category: string;
  isImpermissible: boolean;
} {
  const lower = label.toLowerCase();
  const hasImpermissible = IMPERMISSIBLE_ADD_ON_KEYWORDS.some((kw) => lower.includes(kw));

  const categoryMap: Record<string, string> = {
    active: "active",
    demand: "demand",
    reactive: "reactive",
    fixed: "fixed",
    vat: "vat",
    metering: "add_on_metering",
    admin: "add_on_admin",
    vending: "add_on_vending",
  };

  const mapped = categoryMap[category.toLowerCase()] || category;

  return {
    category: mapped,
    isImpermissible: hasImpermissible && mapped.startsWith("add_on"),
  };
}

export async function parseInvoiceWithClaude(
  invoiceId: string,
  pdfContent: Buffer,
): Promise<ParsedInvoice> {
  const invoice = await db.query.landlordInvoices.findFirst({
    where: eq(landlordInvoices.id, invoiceId),
  });

  if (!invoice) {
    throw new Error(`Invoice ${invoiceId} not found`);
  }

  const client = new Anthropic();

  const base64Pdf = pdfContent.toString("base64");

  const model = process.env.INVOICE_PARSE_MODEL || "claude-haiku-4-5-20251001";

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: base64Pdf,
            },
          },
          {
            type: "text",
            text: `Parse this invoice and extract line items. Return ONLY a JSON object (no markdown) with:
{
  "lineItems": [
    {
      "rawLabel": "string (exact text from invoice)",
      "category": "active|demand|reactive|fixed|vat|metering|admin|vending|other",
      "valueCents": number (amount in ZAR cents),
      "confidence": number (0.0 to 1.0)
    }
  ],
  "totalCents": number (total invoice in ZAR cents)
}

For each line:
- Use "active" for energy charges (kWh)
- Use "demand" for demand/kVA charges
- Use "reactive" for reactive energy charges
- Use "fixed" for fixed monthly charges
- Use "vat" for VAT
- Use "metering", "admin", "vending" for add-on charges
- Use "other" for unrecognized charges
- Confidence: 0.9-1.0 for clear items, 0.7-0.9 for slightly ambiguous, <0.7 for unclear

IMPORTANT: The sum of all lineItems valueCents MUST equal totalCents.`,
          },
        ],
      },
    ],
  });

  const content = response.content[0];
  if (content?.type !== "text") {
    throw new Error("Unexpected response type from Claude");
  }

  const jsonMatch = content.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Could not extract JSON from Claude response");
  }

  const parsed = JSON.parse(jsonMatch[0]);

  const lineItemsSum = parsed.lineItems.reduce(
    (sum: number, item: ParsedLineItem) => sum + item.valueCents,
    0,
  );

  if (lineItemsSum !== parsed.totalCents) {
    console.warn(
      `Arithmetic check failed: lineItems sum (${lineItemsSum}) != total (${parsed.totalCents})`,
    );
  }

  return {
    lineItems: parsed.lineItems,
    totalCents: parsed.totalCents,
    parseModel: model,
  };
}

export async function persistParsedInvoice(
  invoiceId: string,
  parsed: ParsedInvoice,
): Promise<void> {
  const invoice = await db.query.landlordInvoices.findFirst({
    where: eq(landlordInvoices.id, invoiceId),
  });

  if (!invoice) {
    throw new Error(`Invoice ${invoiceId} not found`);
  }

  type LineCategory =
    | "active" | "demand" | "reactive" | "fixed" | "vat"
    | "add_on_metering" | "add_on_admin" | "add_on_vending" | "other";

  const lineItemsData = parsed.lineItems.map((item) => {
    const { category, isImpermissible } = categorizeLineItem(item.rawLabel, item.category);
    return {
      invoiceId,
      rawLabel: item.rawLabel,
      parsedCategory: category as LineCategory,
      parsedValueCents: item.valueCents,
      confidence: item.confidence.toString(),
      isImpermissibleAddOn: isImpermissible,
    };
  });

  await db.insert(invoiceLineItems).values(lineItemsData);

  await db
    .update(landlordInvoices)
    .set({
      status: "parsed_pending_confirm",
      parsedRaw: JSON.stringify(parsed),
      parseModel: parsed.parseModel,
    })
    .where(eq(landlordInvoices.id, invoiceId));
}
