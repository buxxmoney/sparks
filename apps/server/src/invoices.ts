import { spawn } from "node:child_process";
import { Anthropic } from "@anthropic-ai/sdk";
import { db, invoiceLineItems, landlordInvoices } from "@sparks/db";
import { eq } from "drizzle-orm";

/**
 * Extract a PDF's embedded text layer via poppler's `pdftotext -layout` (columns
 * preserved). Returns null when poppler isn't installed OR the PDF has no usable
 * text (e.g. a scan) — the caller then falls back to sending the PDF itself for
 * vision parsing. Install locally with `brew install poppler`; a deploy host
 * needs the `poppler-utils` package.
 */
async function extractPdfText(pdf: Buffer): Promise<string | null> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("pdftotext", ["-layout", "-", "-"]);
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    proc.stdout?.on("data", (d: Buffer) => chunks.push(d));
    proc.on("error", () => resolve(null)); // ENOENT — poppler not installed
    proc.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const text = Buffer.concat(chunks).toString("utf-8").trim();
      // Too little text ⇒ likely a scanned/image-only PDF ⇒ use vision fallback.
      resolve(text.length >= 40 ? text : null);
    });
    proc.stdin?.on("error", () => {}); // ignore EPIPE if the binary is absent
    proc.stdin?.write(pdf);
    proc.stdin?.end();
  });
}

export type LineCategory =
  | "active"
  | "demand"
  | "reactive"
  | "fixed"
  | "vat"
  | "add_on_metering"
  | "add_on_admin"
  | "add_on_vending"
  | "other";

export interface ParsedLineItem {
  rawLabel: string;
  valueCents: number;
  confidence: number;
  // Canonical grouping fields (derived from the physical unit, so grouping works
  // across any landlord's invoice format).
  utility: string; // electricity | water | sanitation | refuse | vat | other
  supplyGroup: string; // tenant | common | central_aircon | generator | unknown
  unit: string | null;
  quantity: number | null;
  rate: number | null; // Rand per unit (stated or derived = amount ÷ quantity)
  component: string; // active_energy | demand | reactive_energy | generation | network | service_fixed | levy_surcharge | volume | vat | other
  category: LineCategory; // the coarse bucket the reconciliation uses
  isImpermissibleAddOn: boolean;
}

export interface ParsedInvoice {
  lineItems: ParsedLineItem[];
  totalCents: number;
  parseModel: string;
  periodStart: string | null; // YYYY-MM-DD as read from the invoice
  periodEnd: string | null; // YYYY-MM-DD (last day billed, inclusive)
}

const IMPERMISSIBLE_ADD_ON_KEYWORDS = ["metering", "admin", "vending", "nett", "reading"];

export function categorizeLineItem(
  label: string,
  category: string,
): {
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

/**
 * Derive the canonical `component` from the physical unit (+ description hints).
 * The unit is the universal signal that survives any invoice format: kWh→energy,
 * kVA→demand, kVArh→reactive, kl→volume (water/sanitation), basic→fixed.
 */
export function normalizeComponent(unit: string | null, rawLabel: string, utility: string): string {
  const u = (unit ?? "").toLowerCase().replace(/\s+/g, "");
  const l = (rawLabel ?? "").toLowerCase();

  if (utility === "vat" || l.includes("vat")) return "vat";
  // Non-electricity utilities are billed on volume (kl); we don't reconcile them.
  if (utility && utility !== "electricity") return "volume";

  if (u.includes("kvar") || l.includes("reactive")) return "reactive_energy";
  if (u.includes("kva") || u === "kw" || l.includes("demand")) return "demand";
  if (u.includes("kwh")) {
    if (u.includes("gen") || l.includes("gen ") || l.includes("generation")) return "generation";
    if (l.includes("surch") || l.includes("levy") || l.includes("subsidy")) return "levy_surcharge";
    return "active_energy";
  }
  if (l.includes("network")) return "network";
  if (l.includes("levy") || l.includes("surch") || l.includes("subsidy")) return "levy_surcharge";
  if (u.includes("basic") || l.includes("service") || l.includes("fixed") || l.includes("charge")) {
    return "service_fixed";
  }
  return "other";
}

/** Map a component to the coarse reconciliation bucket, flagging impermissible add-ons. */
export function deriveLineCategory(
  component: string,
  rawLabel: string,
): { category: LineCategory; isImpermissible: boolean } {
  const l = rawLabel.toLowerCase();
  if (l.includes("metering") || l.includes("meter rental") || l.includes("sub-meter")) {
    return { category: "add_on_metering", isImpermissible: true };
  }
  if (l.includes("admin")) return { category: "add_on_admin", isImpermissible: true };
  if (l.includes("vending")) return { category: "add_on_vending", isImpermissible: true };

  switch (component) {
    case "active_energy":
    case "generation":
      return { category: "active", isImpermissible: false };
    case "demand":
      return { category: "demand", isImpermissible: false };
    case "reactive_energy":
      return { category: "reactive", isImpermissible: false };
    case "network":
    case "service_fixed":
    case "levy_surcharge":
      return { category: "fixed", isImpermissible: false };
    case "vat":
      return { category: "vat", isImpermissible: false };
    default:
      return { category: "other", isImpermissible: false };
  }
}

export async function parseInvoiceWithClaude(pdfContent: Buffer): Promise<ParsedInvoice> {
  const client = new Anthropic();

  const rules = `Return ONLY a JSON object (no prose, no markdown):
{
  "periodStart": "the billing period START date as YYYY-MM-DD (the 'from' / reading-cycle start / statement period start)",
  "periodEnd": "the billing period END date as YYYY-MM-DD (the 'to' / reading-cycle end), the last day billed",
  "lineItems": [
    {
      "rawLabel": "the charge description exactly as printed",
      "utility": "electricity|water|sanitation|refuse|vat|other",
      "supplyGroup": "tenant|common|central_aircon|generator|unknown",
      "unit": "kWh|kVA|kVArh|Gen kWh|kl|basic|other  (or null if none shown)",
      "quantity": number or null,
      "rate": number or null,
      "amountText": "the amount exactly as printed, including currency and separators (e.g. \\"R2 640,00\\")",
      "amountRand": number,
      "confidence": number
    }
  ],
  "totalText": "the invoice's grand total, exactly as printed",
  "totalRand": number
}

Rules:
- Extract EVERY charge line shown (all utilities). Use the exact printed text for rawLabel.
- amountRand is the printed amount as a plain number in Rand (e.g. 2640.00). South African invoices may use a comma as the decimal separator and spaces or commas as thousands separators — "R2 640,00" and "R2,640.00" both mean 2640.00. Interpret correctly.
- quantity is the consumption/units for the line; rate is the price per unit in Rand, ONLY if the invoice prints it (else null — do not compute it).
- Credits, discounts, or negative adjustments must be NEGATIVE numbers.
- Read the AMOUNT column, not the units, tariff rate, or reading.
- DO NOT invent, round, or adjust values to make the line items sum to the total. Report exactly what is printed.
- utility: infer from the unit and wording — kWh/kVA/kVArh/Gen kWh = electricity; kl or "water"/"sewer"/"sanitation" = water/sanitation; a VAT line = vat; else other.
- supplyGroup: if the invoice separates the supply (e.g. "Tenant", "Central Aircon", "Common"), use that; if it's a single tenant's charges with no split, use "tenant"; otherwise "unknown".
- unit is the physical unit exactly (kWh, kVA, kVArh, Gen kWh, kl) or "basic" for fixed/service charges billed per period.
- totalRand is the invoice GRAND total exactly as printed (all utilities incl. VAT).
- periodStart / periodEnd: the billing/reading period this statement covers, each as YYYY-MM-DD. Look for "Reading Cycle", "Period", "Start Date"/"End Date", "From"/"To". If genuinely not shown, use null.
- confidence: 0.9-1.0 clearly legible, 0.7-0.9 slightly ambiguous, <0.7 unclear.`;

  // Prefer the PDF's exact embedded text layer (no visual misreads); fall back to
  // sending the PDF itself for vision parsing when there's no text (a scan) or
  // poppler isn't installed.
  const extractedText = await extractPdfText(pdfContent);
  const source = extractedText ? "text" : "pdf";

  // Adaptive model: with a clean text layer the task is transcription, not visual
  // reasoning — the faster Haiku is accurate (verified: exact reconcilable total).
  // Scanned bills (vision fallback) need the stronger reader, so use Sonnet there.
  // INVOICE_PARSE_MODEL overrides both (e.g. "claude-sonnet-5" for max thoroughness,
  // "claude-opus-4-8" for especially messy scans).
  const model =
    process.env.INVOICE_PARSE_MODEL ??
    (source === "text" ? "claude-haiku-4-5-20251001" : "claude-sonnet-5");
  console.log(`[invoice-parse] source=${source} model=${model}`);

  const requestContent: Anthropic.ContentBlockParam[] = extractedText
    ? [
        {
          type: "text",
          text: `You are extracting charges from a South African electricity invoice for a legal reconciliation. Accuracy is critical: represent the document EXACTLY as printed. Never compute, round, adjust, or balance any figure.

Below is the exact text extracted from the PDF (column layout preserved). Use it as the authoritative source for every digit.

<invoice_text>
${extractedText}
</invoice_text>

${rules}`,
        },
      ]
    : [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: pdfContent.toString("base64"),
          },
        },
        {
          type: "text",
          text: `You are extracting charges from a South African electricity invoice for a legal reconciliation. Accuracy is critical: represent the document EXACTLY as printed. Never compute, round, adjust, or balance any figure.

${rules}`,
        },
      ];

  const response = await client.messages.create({
    model,
    // Structured transcription from an exact text layer — extended thinking just
    // adds latency and eats the output budget (which truncated big bills into
    // invalid JSON). Disable it; give the JSON a generous cap.
    thinking: { type: "disabled" },
    max_tokens: 16000,
    messages: [{ role: "user", content: requestContent }],
  });

  // Find the text block — Claude 5 models (e.g. Sonnet 5) return a `thinking`
  // block first, so we can't assume content[0] is the text.
  const content = response.content.find((b) => b.type === "text");
  if (!content || content.type !== "text") {
    throw new Error("Unexpected response type from Claude (no text block)");
  }

  // Claude sometimes wraps the JSON in a ```json fence; strip it, then take the
  // outermost {...}. If the response was truncated (stop_reason "max_tokens") the
  // JSON is incomplete — say so clearly rather than crashing on JSON.parse.
  const cleaned = content.text.replace(/```(?:json)?/gi, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error(`[invoice-parse] no JSON in Claude response:\n${content.text.slice(0, 500)}`);
    throw new Error("Could not extract line items from the invoice — the parser returned no JSON.");
  }

  interface RawLine {
    rawLabel: string;
    utility?: string;
    supplyGroup?: string;
    unit?: string | null;
    quantity?: number | string | null;
    rate?: number | string | null;
    amountRand: number | string;
    amountText?: string;
    confidence: number | string;
  }
  let parsed: {
    lineItems: RawLine[];
    totalRand: number | string;
    periodStart?: string | null;
    periodEnd?: string | null;
  };
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error(
      `[invoice-parse] JSON.parse failed (stop_reason=${response.stop_reason}). Raw text:\n${content.text.slice(0, 800)}`,
    );
    throw new Error(
      response.stop_reason === "max_tokens"
        ? "The invoice is large and the parser's response was truncated. Try a shorter invoice or contact support."
        : "The parser returned malformed JSON for this invoice.",
    );
  }

  if (!Array.isArray(parsed.lineItems)) {
    throw new Error("The parser did not return any line items for this invoice.");
  }

  // Rand → integer cents is done HERE, deterministically (round once at the cents
  // boundary), rather than asking the model to output cents — LLMs are unreliable
  // at that silent unit conversion, which was the main source of wrong numbers.
  const toCents = (v: number | string): number => Math.round(Number(v) * 100);
  const num = (v: number | string | null | undefined): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const lineItems: ParsedLineItem[] = parsed.lineItems.map((li) => {
    const utility = (li.utility ?? "other").toLowerCase();
    const supplyGroup = (li.supplyGroup ?? "unknown").toLowerCase();
    const unit = li.unit ?? null;
    const quantity = num(li.quantity);
    const amountRand = Number(li.amountRand);
    // Use the stated rate; otherwise derive it from amount ÷ quantity.
    const statedRate = num(li.rate);
    const rate = statedRate ?? (quantity && quantity !== 0 ? amountRand / quantity : null);
    const component = normalizeComponent(unit, li.rawLabel, utility);
    const { category, isImpermissible } = deriveLineCategory(component, li.rawLabel);
    return {
      rawLabel: li.rawLabel,
      valueCents: toCents(li.amountRand),
      confidence: Number(li.confidence),
      utility,
      supplyGroup,
      unit,
      quantity,
      rate,
      component,
      category,
      isImpermissibleAddOn: isImpermissible,
    };
  });
  const totalCents = toCents(parsed.totalRand);

  // Informational only — we intentionally do NOT force the model to balance, so a
  // mismatch surfaces a real invoice discrepancy for the reviewer rather than
  // being papered over.
  const lineItemsSum = lineItems.reduce((sum, item) => sum + item.valueCents, 0);
  if (lineItemsSum !== totalCents) {
    console.warn(
      `[invoice-parse] line items sum (${lineItemsSum}c) != stated total (${totalCents}c) — surfaced for review`,
    );
  }

  // Validate the period dates look like YYYY-MM-DD; otherwise treat as unknown.
  const isoDate = (v: unknown): string | null =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null;

  return {
    lineItems,
    totalCents,
    parseModel: model,
    periodStart: isoDate(parsed.periodStart),
    periodEnd: isoDate(parsed.periodEnd),
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

  const lineItemsData = parsed.lineItems.map((item) => ({
    invoiceId,
    rawLabel: item.rawLabel,
    parsedCategory: item.category,
    parsedValueCents: item.valueCents,
    confidence: item.confidence.toString(),
    isImpermissibleAddOn: item.isImpermissibleAddOn,
    utility: item.utility,
    supplyGroup: item.supplyGroup,
    unit: item.unit,
    quantity: item.quantity !== null ? item.quantity.toString() : null,
    rate: item.rate !== null ? item.rate.toString() : null,
    component: item.component,
  }));

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
