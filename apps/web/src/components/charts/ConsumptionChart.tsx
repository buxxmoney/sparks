"use client";

import { useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Stack } from "@astryxdesign/core/Stack";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { InfoLabel, METRIC_HINTS } from "@/components/metric";

// One interval row as returned by demand.listIntervals (numeric fields are strings).
export type IntervalRow = {
  intervalStart: string;
  activeEnergyKwh: string | null;
  reactiveEnergyKvarh: string | null;
  avgDemandKw: string | null;
  avgDemandKva: string | null;
};

// One bucket as returned by readings.energyByPeriod.
export type EnergyPeriodRow = {
  label: string;
  periodStart: string;
  periodEnd: string;
  activeEnergyKwh: string | null;
  reactiveEnergyKvarh: string | null;
};

export type EnergyByPeriod = {
  basis: "billing_period" | "calendar_month";
  periods: EnergyPeriodRow[];
};

// Two families of metric:
//  • "power" (kW/kVA) is an instantaneous rate → trailing-24h time series.
//  • "energy" (kWh/kVArh) accumulates → one bar per billing period, compared
//    across all periods.
type PowerKey = "apparent" | "active";
type EnergyKey = "energy" | "reactive";
type MetricKey = PowerKey | EnergyKey;

const POWER: Record<
  PowerKey,
  { label: string; field: keyof IntervalRow; unit: string; color: string; hint: string }
> = {
  apparent: { label: "Apparent power (kVA)", field: "avgDemandKva", unit: "kVA", color: "hsl(142 71% 40%)", hint: METRIC_HINTS.apparentPower },
  active: { label: "Active power (kW)", field: "avgDemandKw", unit: "kW", color: "hsl(221 83% 53%)", hint: METRIC_HINTS.demandInterval },
};

const ENERGY: Record<
  EnergyKey,
  { label: string; field: keyof EnergyPeriodRow; unit: string; color: string; hint: string }
> = {
  energy: { label: "Energy consumption (kWh)", field: "activeEnergyKwh", unit: "kWh", color: "hsl(221 83% 53%)", hint: METRIC_HINTS.activeEnergy },
  reactive: { label: "Reactive energy (kVArh)", field: "reactiveEnergyKvarh", unit: "kVArh", color: "hsl(38 92% 50%)", hint: METRIC_HINTS.reactiveEnergy },
};

const isEnergy = (k: MetricKey): k is EnergyKey => k === "energy" || k === "reactive";

// Grouped selector: energy names stacked together, power graphs stacked together.
const SELECTOR_OPTIONS = [
  {
    type: "section" as const,
    title: "Energy — across billing periods",
    options: [
      { value: "energy", label: ENERGY.energy.label },
      { value: "reactive", label: ENERGY.reactive.label },
    ],
  },
  {
    type: "section" as const,
    title: "Power — last 24 hours",
    options: [
      { value: "apparent", label: POWER.apparent.label },
      { value: "active", label: POWER.active.label },
    ],
  },
];

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChartTooltip({ active, payload, label, unit }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        borderRadius: 8,
        border: "1px solid hsl(214 32% 91%)",
        background: "#fff",
        padding: "8px 12px",
        fontSize: 12,
        boxShadow: "0 4px 16px rgb(15 23 42 / 0.10)",
      }}
    >
      <div style={{ marginBottom: 4, fontWeight: 500 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: "9999px",
            background: payload[0].color ?? payload[0].fill,
          }}
        />
        <span style={{ fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
          {Number(payload[0].value).toFixed(2)} {unit}
        </span>
      </div>
    </div>
  );
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div
      style={{
        display: "flex",
        height: 256,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 8,
        border: "1px dashed hsl(214 32% 85%)",
        color: "hsl(215 16% 47%)",
        fontSize: 14,
        textAlign: "center",
        padding: "0 24px",
      }}
    >
      {message}
    </div>
  );
}

export function ConsumptionChart({
  intervals,
  energyByPeriod,
}: {
  intervals: IntervalRow[];
  energyByPeriod: EnergyByPeriod | null;
}) {
  const [metricKey, setMetricKey] = useState<MetricKey>("energy");

  const selector = (
    <div style={{ width: 260 }}>
      <Selector
        label="Chart metric"
        isLabelHidden
        options={SELECTOR_OPTIONS}
        value={metricKey}
        onChange={(v) => setMetricKey(v as MetricKey)}
      />
    </div>
  );

  // ── Energy view: one bar per billing period, compared across all periods. ──
  if (isEnergy(metricKey)) {
    const metric = ENERGY[metricKey];
    const periods = energyByPeriod?.periods ?? [];
    const data = periods.map((p) => ({
      label: p.label,
      value: Number.parseFloat((p[metric.field] as string) ?? "0"),
    }));
    const calendarBasis = energyByPeriod?.basis === "calendar_month";

    return (
      <Stack gap={4}>
        <Stack direction="horizontal" justify="between" align="center" wrap="wrap" gap={3}>
          <InfoLabel label={`${metric.label} — per billing period`} hint={metric.hint} strong />
          {selector}
        </Stack>

        {/* Always tell the user what the buckets represent (§ user requirement). */}
        <Text type="supporting" size="sm">
          {calendarBasis
            ? "Shown per calendar month until a billing period is set for this site — set it on an uploaded invoice or in site settings."
            : "One bar per billing period for this site."}
        </Text>

        {data.length === 0 ? (
          <EmptyChart message="No energy data yet — bars appear once metering readings accumulate over a period." />
        ) : (
          <div style={{ height: 256, width: "100%" }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(214 32% 91%)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "hsl(215 16% 47%)" }} tickLine={false} axisLine={{ stroke: "hsl(214 32% 91%)" }} minTickGap={8} />
                <YAxis tick={{ fontSize: 11, fill: "hsl(215 16% 47%)" }} tickLine={false} axisLine={false} width={44} />
                <Tooltip content={(p) => <ChartTooltip {...p} unit={metric.unit} />} cursor={{ fill: "hsl(214 32% 91% / 0.4)" }} />
                <Bar dataKey="value" fill={metric.color} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Stack>
    );
  }

  // ── Power view: trailing-24h time series. ──
  const metric = POWER[metricKey];
  const data = intervals.map((iv) => ({
    label: fmtTime(iv.intervalStart),
    value: Number.parseFloat((iv[metric.field] as string) ?? "0"),
  }));

  return (
    <Stack gap={4}>
      <Stack direction="horizontal" justify="between" align="center" wrap="wrap" gap={3}>
        <InfoLabel label={`${metric.label} — last 24 hours`} hint={metric.hint} strong />
        {selector}
      </Stack>

      {data.length === 0 ? (
        <EmptyChart message="No interval data in this window yet." />
      ) : (
        <div style={{ height: 256, width: "100%" }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
              <defs>
                <linearGradient id={`fill-${metricKey}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={metric.color} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={metric.color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(214 32% 91%)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "hsl(215 16% 47%)" }} tickLine={false} axisLine={{ stroke: "hsl(214 32% 91%)" }} minTickGap={24} />
              <YAxis tick={{ fontSize: 11, fill: "hsl(215 16% 47%)" }} tickLine={false} axisLine={false} width={44} />
              <Tooltip content={(p) => <ChartTooltip {...p} unit={metric.unit} />} />
              <Area type="monotone" dataKey="value" stroke={metric.color} strokeWidth={2} fill={`url(#fill-${metricKey})`} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Stack>
  );
}
