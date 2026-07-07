"use client";

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { ChevronDown, ChevronRight, Send, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

export type ReviewLine = {
  id: string;
  rawLabel: string;
  component: string;
  utility: string;
  supplyGroup: string;
  unit: string | null;
  quantity: number | null;
  rate: number | null;
  valueCents: number;
};

// The grouping sent to the server (the parser's, as-is — Sparks corrects it in QA).
export type GroupedLine = {
  lineItemId: string;
  utility: string;
  supplyGroup: string;
  component: string;
  valueCents: number;
};

const COMPONENT_LABELS: Record<string, string> = {
  active_energy: "Active energy",
  generation: "Generation",
  demand: "Demand",
  reactive_energy: "Reactive",
  network: "Network",
  service_fixed: "Service / fixed",
  levy_surcharge: "Levy / surcharge",
  volume: "Volume",
  vat: "VAT",
  other: "Other",
};

function componentBucket(component: string): "active" | "demand" | "reactive" | "fixed" | null {
  switch (component) {
    case "active_energy":
    case "generation":
      return "active";
    case "demand":
      return "demand";
    case "reactive_energy":
      return "reactive";
    case "network":
    case "service_fixed":
    case "levy_surcharge":
      return "fixed";
    default:
      return null;
  }
}

function rand(cents: number) {
  const v = (cents / 100).toLocaleString("en-ZA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return cents < 0 ? `-R ${v.replace("-", "")}` : `R ${v}`;
}

export function InvoiceReview({
  lines,
  onSend,
  sendLoading,
  canSend = true,
}: {
  lines: ReviewLine[];
  onSend: (grouped: GroupedLine[], note: string) => void;
  sendLoading: boolean;
  canSend?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState("");

  // Reconcilable base = tenant electricity, straight from the parser (read-only).
  const derived = useMemo(() => {
    const tenantElec = lines.filter(
      (l) => l.utility === "electricity" && l.supplyGroup === "tenant",
    );
    const reconcilable = tenantElec.reduce((s, l) => s + l.valueCents, 0);
    const buckets = { active: 0, demand: 0, reactive: 0, fixed: 0 };
    for (const l of tenantElec) {
      const b = componentBucket(l.component);
      if (b) buckets[b] += l.valueCents;
    }
    return { tenantElec, reconcilable, buckets };
  }, [lines]);

  const send = () => {
    onSend(
      lines.map((l) => ({
        lineItemId: l.id,
        utility: l.utility,
        supplyGroup: l.supplyGroup,
        component: l.component,
        valueCents: l.valueCents,
      })),
      note,
    );
  };

  return (
    <Stack gap={4}>
      {/* Reconcilable total — the headline number, breakdown tucked behind the arrow. */}
      <div style={{ background: "hsl(214 95% 96%)", borderRadius: 12, padding: "16px 18px" }}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            width: "100%",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            {expanded ? (
              <ChevronDown size={18} color="hsl(221 83% 42%)" />
            ) : (
              <ChevronRight size={18} color="hsl(221 83% 42%)" />
            )}
            <span>
              <span style={{ fontSize: 13, color: "hsl(221 83% 38%)", fontWeight: 600 }}>
                Reconcilable total
              </span>
              <span style={{ display: "block", fontSize: 12, color: "hsl(221 60% 45%)" }}>
                your electricity charges — tap to see how we got here
              </span>
            </span>
          </span>
          <span
            style={{
              fontSize: 26,
              fontWeight: 700,
              color: "hsl(221 83% 38%)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {rand(derived.reconcilable)}
          </span>
        </button>

        {expanded ? (
          <div style={{ marginTop: 12, fontSize: 13 }}>
            {derived.tenantElec.length === 0 ? (
              <Text type="supporting">
                No tenant-electricity lines were detected. Sparks will confirm this when reviewing.
              </Text>
            ) : (
              <>
                {derived.tenantElec.map((l) => (
                  <div
                    key={l.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: "5px 0",
                      borderTop: "0.5px solid hsl(221 40% 88%)",
                    }}
                  >
                    <span style={{ color: "hsl(221 30% 30%)" }}>
                      <span style={{ fontWeight: 500 }}>
                        {COMPONENT_LABELS[l.component] ?? l.component}
                      </span>
                      <span style={{ color: "hsl(215 16% 55%)", marginLeft: 8 }}>{l.rawLabel}</span>
                    </span>
                    <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                      {rand(l.valueCents)}
                    </span>
                  </div>
                ))}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginTop: 6,
                    paddingTop: 6,
                    borderTop: "1px solid hsl(221 40% 78%)",
                    fontWeight: 700,
                    color: "hsl(221 83% 38%)",
                  }}
                >
                  <span>Total</span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    {rand(derived.reconcilable)}
                  </span>
                </div>
              </>
            )}
          </div>
        ) : null}
      </div>

      {/* Honest disclaimer — the numbers are AI-assisted; a person verifies them. */}
      <Banner
        status="info"
        title="A Sparks professional will review your bill"
        description="These figures are extracted from your invoice with AI, which can make mistakes. Our team reviews every bill to make sure everything is correct — send it over and we'll get back to you."
      />

      {!canSend ? (
        <Banner
          status="warning"
          title="You have view-only access"
          description="Ask a site editor or an owner to send this bill to Sparks for review."
        />
      ) : null}

      <Stack gap={2}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Sparkles size={14} color="hsl(221 83% 45%)" />
          <Text type="supporting">Anything we should know? (optional)</Text>
        </span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. the demand charge looks higher than usual, or a line I don't recognise…"
          rows={3}
          style={{
            width: "100%",
            padding: "10px 12px",
            border: "1px solid hsl(210 16% 82%)",
            borderRadius: 8,
            font: "inherit",
            resize: "vertical",
          }}
        />
      </Stack>

      <div style={{ display: "grid" }}>
        <Button
          label={sendLoading ? "Sending…" : "Send to Sparks for review"}
          variant="primary"
          icon={<Send size={16} />}
          isLoading={sendLoading}
          isDisabled={!canSend}
          onClick={send}
        />
      </div>
    </Stack>
  );
}
