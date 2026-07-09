"use client";

import type { ReactNode } from "react";
import { HelpCircle } from "lucide-react";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";

const infoButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: 0,
  border: "none",
  background: "none",
  color: "inherit",
  opacity: 0.65,
  cursor: "help",
};

/**
 * Format a numeric reading for display: thousands separators, fixed decimals.
 * Accepts the string-typed numerics the API returns; "—" for missing/invalid.
 */
export function formatReading(
  value: string | number | null | undefined,
  digits = 2,
): string {
  if (value == null) return "—";
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * A metric label with a small `?` affordance. Hovering (or focusing, for keyboard
 * users) the icon explains the term in plain language — so someone who doesn't
 * know what "Apparent Power" or "Peak Demand" means can find out in place.
 */
export function InfoLabel({
  label,
  hint,
  strong,
}: {
  label: string;
  hint: string;
  strong?: boolean;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {strong ? (
        <Text weight="medium">{label}</Text>
      ) : (
        <Text type="supporting">{label}</Text>
      )}
      <Tooltip content={hint} placement="above">
        <button type="button" aria-label={`What is ${label}?`} style={infoButtonStyle}>
          <HelpCircle size={14} />
        </button>
      </Tooltip>
    </span>
  );
}

// Value type scale: "lg" is the one hero figure a block leads with, "md" the
// standard tile value, "sm" a supporting sub-value inside a block.
const VALUE_SIZE = { sm: 20, md: 26, lg: 38 } as const;

/**
 * A single stat: an info-labelled caption above a large value with an optional
 * unit. The value stays in primary ink — identity comes from the label, not
 * from color-coding each metric a different hue.
 */
export function MetricStat({
  label,
  hint,
  value,
  unit,
  size = "md",
}: {
  label: string;
  hint: string;
  value: ReactNode;
  unit?: string;
  size?: keyof typeof VALUE_SIZE;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <InfoLabel label={label} hint={hint} />
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span
          style={{
            fontSize: VALUE_SIZE[size],
            fontWeight: 600,
            lineHeight: 1.1,
            letterSpacing: "-0.02em",
            color: "var(--color-text-primary, inherit)",
          }}
        >
          {value}
        </span>
        {unit ? <Text type="supporting">{unit}</Text> : null}
      </div>
    </div>
  );
}

/**
 * Central glossary so every tooltip across the app describes a term the same way.
 * Written for a non-expert landlord/tenant, not an engineer.
 */
export const METRIC_HINTS = {
  activePower:
    "The real power being drawn right now, in kilowatts (kW). This is the electricity actually doing work — what most people think of as 'usage'.",
  apparentPower:
    "Total power the supply must deliver, in kilovolt-amps (kVA) — the combination of useful (active) power and the reactive power equipment needs. Utilities often bill demand on this.",
  reactivePower:
    "The power drawn right now to sustain magnetic fields in motors and transformers, in kilovolt-amps reactive (kVAr). It does no useful work but the network still has to carry it.",
  powerFactor:
    "How efficiently power is used: active power ÷ apparent power, from 0 to 1. Closer to 1 is better; a low value can attract penalty charges.",
  activeEnergy:
    "Total real electricity consumed so far this month, in kilowatt-hours (kWh). This is the number that drives the energy portion of a bill.",
  peakDemand:
    "The highest average demand (in kVA) measured over any single billing interval this month. Utilities charge for this peak, so a brief spike can cost the whole month.",
  reactiveEnergy:
    "Energy used to sustain magnetic fields in motors and transformers, in kVArh. It does no useful work but the network still carries it — excess reactive energy can be billed.",
  demandInterval:
    "Electricity demand is averaged over fixed clock windows (15, 30, 45 or 60 minutes). Billing uses the highest of these interval averages, not the instantaneous peak.",
} as const;
