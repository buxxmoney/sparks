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

// Accent colours for the big stat value. Fixed light-mode palette matching the
// consumption chart (MediaTheme is pinned to light).
const ACCENT_COLOR: Record<string, string> = {
  default: "inherit",
  primary: "hsl(221 83% 53%)",
  success: "hsl(142 71% 40%)",
  warning: "hsl(26 83% 14%)",
};

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

/** A single stat: an info-labelled caption above a large value with an optional unit. */
export function MetricStat({
  label,
  hint,
  value,
  unit,
  accent,
}: {
  label: string;
  hint: string;
  value: ReactNode;
  unit?: string;
  accent?: "default" | "primary" | "success" | "warning";
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <InfoLabel label={label} hint={hint} />
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span
          style={{
            fontSize: 24,
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "-0.01em",
            color: ACCENT_COLOR[accent ?? "default"],
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
