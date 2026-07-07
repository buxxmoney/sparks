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
import { InfoLabel, METRIC_HINTS } from "@/components/metric";

// One interval row as returned by demand.listIntervals (numeric fields are strings).
export type IntervalRow = {
  intervalStart: string;
  activeEnergyKwh: string | null;
  reactiveEnergyKvarh: string | null;
  avgDemandKw: string | null;
  avgDemandKva: string | null;
};

type MetricKey = "energy" | "demand" | "apparent" | "reactive";

const METRICS: Record<
  MetricKey,
  { label: string; field: keyof IntervalRow; unit: string; kind: "bar" | "area"; color: string; hint: string }
> = {
  energy: { label: "Energy (kWh)", field: "activeEnergyKwh", unit: "kWh", kind: "bar", color: "hsl(221 83% 53%)", hint: METRIC_HINTS.activeEnergy },
  demand: { label: "Demand (kW)", field: "avgDemandKw", unit: "kW", kind: "area", color: "hsl(221 83% 53%)", hint: METRIC_HINTS.demandInterval },
  apparent: { label: "Apparent power (kVA)", field: "avgDemandKva", unit: "kVA", kind: "area", color: "hsl(142 71% 40%)", hint: METRIC_HINTS.apparentPower },
  reactive: { label: "Reactive energy (kVArh)", field: "reactiveEnergyKvarh", unit: "kVArh", kind: "bar", color: "hsl(38 92% 50%)", hint: METRIC_HINTS.reactiveEnergy },
};

const SELECTOR_OPTIONS: { value: MetricKey; label: string }[] = [
  { value: "energy", label: "Energy consumption (kWh)" },
  { value: "demand", label: "Demand (kW)" },
  { value: "apparent", label: "Apparent power (kVA)" },
  { value: "reactive", label: "Reactive energy (kVArh)" },
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

export function ConsumptionChart({ intervals }: { intervals: IntervalRow[] }) {
  const [metricKey, setMetricKey] = useState<MetricKey>("energy");
  const metric = METRICS[metricKey];

  const data = intervals.map((iv) => ({
    label: fmtTime(iv.intervalStart),
    value: Number.parseFloat((iv[metric.field] as string) ?? "0"),
  }));

  return (
    <Stack gap={4}>
      <Stack direction="horizontal" justify="between" align="center" wrap="wrap" gap={3}>
        <InfoLabel label={`${metric.label} — last 24 hours`} hint={metric.hint} strong />
        <div style={{ width: 240 }}>
          <Selector
            label="Chart metric"
            isLabelHidden
            options={SELECTOR_OPTIONS}
            value={metricKey}
            onChange={(v) => setMetricKey(v as MetricKey)}
          />
        </div>
      </Stack>

      {data.length === 0 ? (
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
          }}
        >
          No interval data in this window yet.
        </div>
      ) : (
        <div style={{ height: 256, width: "100%" }}>
          <ResponsiveContainer width="100%" height="100%">
            {metric.kind === "bar" ? (
              <BarChart data={data} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(214 32% 91%)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "hsl(215 16% 47%)" }} tickLine={false} axisLine={{ stroke: "hsl(214 32% 91%)" }} minTickGap={24} />
                <YAxis tick={{ fontSize: 11, fill: "hsl(215 16% 47%)" }} tickLine={false} axisLine={false} width={44} />
                <Tooltip content={(p) => <ChartTooltip {...p} unit={metric.unit} />} cursor={{ fill: "hsl(214 32% 91% / 0.4)" }} />
                <Bar dataKey="value" fill={metric.color} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            ) : (
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
            )}
          </ResponsiveContainer>
        </div>
      )}
    </Stack>
  );
}
