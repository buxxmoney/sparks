"use client";

import type { CSSProperties, ReactNode } from "react";
import { Text } from "@astryxdesign/core/Text";

/**
 * Shared visual vocabulary for the customer-facing breakdown views.
 *
 * Matched to the generated PDF reports (apps/server/src/reports.ts): ruled tables
 * on a white field, brand green accents, near-black ink for figures. A customer who
 * reads a breakdown on screen and then downloads the PDF should recognise the same
 * document rather than two unrelated designs — so the palette, the cell rules and
 * the charge glossary all live here, in one place, instead of being restated per
 * dialog and drifting apart.
 */
export const REPORT = {
  brand: "var(--color-accent, #0c6c30)",
  rule: "#e2e5e9",
  ruleStrong: "#0b1220",
  ink: "#1a1a1a",
  inkMuted: "#6b7280",
  headerFill: "#f6f7f8",
  groupFill: "#fafbfc",
  warn: "#e65100",
  warnFill: "#fff8f2",
} as const;

export const cellBase: CSSProperties = {
  border: `1px solid ${REPORT.rule}`,
  padding: "9px 12px",
  verticalAlign: "top",
  fontSize: 13,
  color: REPORT.ink,
};

export const numericCell: CSSProperties = {
  ...cellBase,
  textAlign: "right",
  whiteSpace: "nowrap",
  fontVariantNumeric: "tabular-nums",
};

/**
 * What each category of charge actually IS, in plain language.
 *
 * Rule 18: customers are tenants, not engineers. Every charge a bill can carry gets
 * an explanation in the same words wherever it appears — on the bill breakdown and
 * on the tariff rate card — so the two views teach one vocabulary, not two.
 *
 * Order is the order a utility invoice presents these charges.
 */
export const CHARGE_GLOSSARY = [
  {
    key: "active_energy",
    title: "Active energy",
    short: "The electricity you actually used.",
    blurb:
      "The electricity actually consumed, measured in kilowatt-hours (kWh). Many tariffs charge this in blocks — the first so many units at one rate, the next at a higher one — or at different rates by time of day. Each block or period is listed as its own line.",
  },
  {
    key: "demand",
    title: "Demand",
    short: "The capacity your site needed at its busiest moment.",
    blurb:
      "Charged on the single highest demand interval in the period, in kVA — what the network had to be ready to deliver at your busiest moment, not the total you consumed. One brief spike can set this for the whole period.",
  },
  {
    key: "reactive_energy",
    title: "Reactive energy",
    short: "Power the network carries that does no useful work.",
    blurb:
      "Some equipment draws power that flows back and forth without doing useful work. The network still has to carry it. Most tariffs allow a free portion and only bill the excess.",
  },
  {
    key: "fixed",
    title: "Fixed charges",
    short: "Charged every period, whatever you use.",
    blurb:
      "Service and capacity charges levied in full for the billing period regardless of consumption. They cover the cost of maintaining your connection, and are not pro-rated if you use less.",
  },
  {
    key: "ancillary",
    title: "Other charges",
    short: "Anything else the tariff defines.",
    blurb: "Charges your tariff defines that fall outside the categories above.",
  },
] as const;

/** Section rule + label, matching the report's section headings. */
export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span
        style={{ width: 3, height: 14, background: REPORT.brand, display: "inline-block" }}
      />
      <Text weight="semibold">{children}</Text>
    </div>
  );
}
