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
export async function extractPdfText(pdf: Buffer): Promise<string | null> {
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
  // Fail loudly and specifically if the API key is missing — otherwise the SDK
  // throws a generic error deep in the call and the upload looks like a mystery 500.
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "Invoice parsing is unavailable: ANTHROPIC_API_KEY is not set on the server.",
    );
  }
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
- Extract each distinct charge EXACTLY ONCE. Use the exact printed text for rawLabel.
- CRITICAL — avoid double-counting. SA utility invoices usually show the same charges TWICE: a high-level SUMMARY/ROLLUP table (e.g. "Rand Value Totals" or a per-utility "Subtotal/VAT/Total" table, one row per utility+supply group) AND an ITEMISED breakdown (e.g. "Consumption Charges", one row per tariff component like active energy, network demand, reactive energy). For each utility+supply group:
    • if an ITEMISED breakdown exists, extract ONLY those component rows and DO NOT also extract that group's summary/subtotal row;
    • if the group appears ONLY in a summary (no itemised rows), extract the single summary row.
  Extracting both the rollup AND its components would double the amount — never do that.
- NEVER emit a subtotal, section total, per-utility/per-group rollup ("Rand Value Totals" rows), carried-forward, balance, or GRAND total as a line item. Those are sums of other lines. The grand total belongs in totalRand only.
- Sanity check before returning: your line items for a given utility+supply group should sum to that group's printed subtotal — NOT twice it. If they'd sum to roughly double a printed subtotal, you have included both the rollup and its components; drop the rollup rows.
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
  console.log(
    `[invoice-parse] pdf=${pdfContent.length}B textLayer=${
      extractedText ? `${extractedText.length} chars` : "none (vision fallback)"
    }`,
  );

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

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model,
      // Structured transcription from an exact text layer — extended thinking just
      // adds latency and eats the output budget (which truncated big bills into
      // invalid JSON). Disable it; give the JSON a generous cap.
      thinking: { type: "disabled" },
      max_tokens: 16000,
      messages: [{ role: "user", content: requestContent }],
    });
  } catch (err) {
    // Anthropic SDK errors carry a status + message — log them so an auth/quota/
    // model problem is obvious in the server logs instead of a bare 500.
    const status = (err as { status?: number }).status;
    console.error(
      `[invoice-parse] Anthropic call failed (model=${model}, status=${status ?? "?"}): ${
        err instanceof Error ? err.message : err
      }`,
    );
    throw new Error(
      `The invoice parser could not reach Claude (${status ?? "network"} error). Please try again.`,
      { cause: err },
    );
  }

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

/* ─────────────── Tariff cross-referencing ─────────────── */

export interface TariffAnalysisLine {
  charge: string; // the invoice's charge label
  detectedTariff: string; // the tariff/component this maps to
  rateSource: "invoice" | "schedule" | "unknown";
  scheduleRate: string | null; // e.g. "253.03 c/kWh"
  scheduleRef: string | null; // where in the reference doc, e.g. "Table 5, p21"
  billed: string; // amount billed, as R
  expected: string | null; // qty × rate, as R (null if not computable)
  verdict: "match" | "over" | "under" | "unknown";
  comment: string | null;
}

export interface TariffAnalysis {
  available: boolean;
  scheduleName: string | null;
  provider: string | null;
  note: string | null; // e.g. "No reference schedule on file for Eskom."
  // "direct" = the schedule IS the bill's provider (a like-for-like check).
  // "reference" = a national baseline (Eskom) shown as context for a bill from a
  // different (e.g. municipal) provider — rates are indicative, not the bill's tariff.
  basis?: "direct" | "reference";
  // A short caveat about basis/tariff-year to show the reviewer up front (or null).
  contextNote?: string | null;
  lines: TariffAnalysisLine[];
}

interface AnalysisCharge {
  rawLabel: string;
  unit: string | null;
  quantity: number | null;
  rate: number | null; // rate PRINTED on the invoice, if any
  amountRand: number;
}

/**
 * Cross-reference a bill's charges against a provider's published tariff schedule.
 * For each charge the AI: identifies the tariff/component, finds the applicable
 * rate in the schedule text (with a table/page pointer), notes whether the rate was
 * already printed on the invoice or looked up here, recomputes the expected amount,
 * and flags matches/mismatches — saying "unknown" when it genuinely can't tell.
 * Best-effort; returns available:false with a note if analysis can't run.
 */
export async function analyzeInvoiceTariffs(params: {
  scheduleName: string;
  provider: string; // the schedule's provider (e.g. "Eskom")
  scheduleText: string;
  charges: AnalysisCharge[];
  basis: "direct" | "reference";
  billProvider: string; // provider inferred from the bill (may differ, e.g. "Johannesburg")
  contextNote: string | null; // caveat about basis / tariff-year
}): Promise<TariffAnalysis> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      available: false,
      scheduleName: params.scheduleName,
      provider: params.provider,
      note: "Tariff analysis unavailable: ANTHROPIC_API_KEY not set.",
      lines: [],
    };
  }
  const client = new Anthropic();
  // A reasoning task over a long reference doc — default to a stronger model.
  const model = process.env.TARIFF_ANALYSIS_MODEL ?? "claude-sonnet-5";

  const chargeLines = params.charges
    .map(
      (c, i) =>
        `${i + 1}. "${c.rawLabel}" | unit=${c.unit ?? "?"} | qty=${c.quantity ?? "?"} | printedRate=${
          c.rate ?? "none"
        } | billed=R${c.amountRand.toFixed(2)}`,
    )
    .join("\n");

  const basisInstruction =
    params.basis === "direct"
      ? `This schedule IS the bill's provider (${params.provider}), so treat it as the authoritative like-for-like tariff and check each charge against it.`
      : `IMPORTANT: this bill appears to be from "${params.billProvider}", NOT ${params.provider}. The ${params.provider} schedule is provided as a NATIONAL REFERENCE BASELINE (Eskom is the state utility other tariffs derive from). So: map each charge to its nearest ${params.provider} tariff for CONTEXT, give that reference rate, but in the comment make clear it's the ${params.provider} equivalent — NOT this bill's actual tariff — so a small "over/under" may just reflect the provider difference. Set verdict "unknown" for a charge with no sensible ${params.provider} equivalent.`;

  const prompt = `You are a South African utility-tariff analyst helping a reviewer check a tenant's electricity/utility bill.

${basisInstruction}
${params.contextNote ? `Context for the reviewer: ${params.contextNote}` : ""}

Below is the "${params.scheduleName}" schedule (provider ${params.provider}), followed by the charge lines from the bill. For EACH charge line, work out the applicable tariff rate and whether the billed amount is right.

<reference_schedule>
${params.scheduleText}
</reference_schedule>

<bill_charges>
${chargeLines}
</bill_charges>

Return ONLY a JSON object:
{
  "lines": [
    {
      "charge": "the bill charge label",
      "detectedTariff": "the tariff/component it maps to (e.g. 'Businessrate active energy charge')",
      "rateSource": "invoice | schedule | unknown",
      "scheduleRate": "the applicable rate with unit, e.g. '253.03 c/kWh' (or null)",
      "scheduleRef": "where in the schedule you found it, e.g. 'Table 5, p21' (or null)",
      "expected": "expected amount in Rand as a plain number string from quantity × rate (or null if not computable)",
      "verdict": "match | over | under | unknown",
      "comment": "one short note; ALWAYS say plainly if you could not determine the rate"
    }
  ]
}

Rules:
- If the invoice already printed a rate for the line, set rateSource "invoice" and still note the schedule's rate for comparison if you can find it.
- If the line only NAMES a tariff (no printed rate), look the rate up in the schedule; set rateSource "schedule" and give scheduleRef.
- If you genuinely cannot find or determine the rate, set rateSource "unknown", scheduleRate null, verdict "unknown", and say so in comment. NEVER guess a number.
- verdict: "match" if expected ≈ billed (within ~2%), "over" if billed materially exceeds expected, "under" if below, else "unknown".
- Be precise with SA number formats (comma decimals, space thousands). Do not invent values.`;

  let text: string;
  try {
    const response = await client.messages.create({
      model,
      thinking: { type: "disabled" },
      max_tokens: 8000,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    });
    const block = response.content.find((b) => b.type === "text");
    text = block && block.type === "text" ? block.text : "";
  } catch (err) {
    console.error(`[tariff-analysis] Anthropic call failed (model=${model}):`, err);
    return {
      available: false,
      scheduleName: params.scheduleName,
      provider: params.provider,
      note: `Tariff analysis could not run (${err instanceof Error ? err.message : "error"}).`,
      lines: [],
    };
  }

  const match = text.replace(/```(?:json)?/gi, "").match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      available: false,
      scheduleName: params.scheduleName,
      provider: params.provider,
      note: "Tariff analysis returned no usable result.",
      lines: [],
    };
  }
  try {
    const parsed = JSON.parse(match[0]) as { lines?: Partial<TariffAnalysisLine>[] };
    const lines: TariffAnalysisLine[] = (parsed.lines ?? []).map((l, i) => ({
      charge: l.charge ?? params.charges[i]?.rawLabel ?? "",
      detectedTariff: l.detectedTariff ?? "—",
      rateSource: (l.rateSource as TariffAnalysisLine["rateSource"]) ?? "unknown",
      scheduleRate: l.scheduleRate ?? null,
      scheduleRef: l.scheduleRef ?? null,
      billed: `R${(params.charges[i]?.amountRand ?? 0).toFixed(2)}`,
      expected: l.expected != null ? `R${Number(l.expected).toFixed(2)}` : null,
      verdict: (l.verdict as TariffAnalysisLine["verdict"]) ?? "unknown",
      comment: l.comment ?? null,
    }));
    return {
      available: true,
      scheduleName: params.scheduleName,
      provider: params.provider,
      note: null,
      basis: params.basis,
      contextNote: params.contextNote,
      lines,
    };
  } catch {
    return {
      available: false,
      scheduleName: params.scheduleName,
      provider: params.provider,
      note: "Tariff analysis result could not be parsed.",
      lines: [],
    };
  }
}
