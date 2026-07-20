"use client";

import { useEffect, useMemo, useState } from "react";
import { BarChart3 } from "lucide-react";
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
import { useRPC } from "@/lib/useRPC";
import { client } from "@/lib/client";

// One interval row as returned by demand.listIntervals (numeric fields are strings).
type IntervalRow = {
  intervalStart: string;
  activeEnergyKwh: string | null;
  reactiveEnergyKvarh: string | null;
  avgDemandKw: string | null;
  avgDemandKva: string | null;
  isComplete: boolean;
};

// One bucket as returned by readings.energyByPeriod.
type EnergyPeriodRow = {
  label: string;
  periodStart: string;
  periodEnd: string;
  activeEnergyKwh: string | null;
  reactiveEnergyKvarh: string | null;
};

// Two families of metric:
//  • "power" (kW/kVA) is an instantaneous rate → per-interval series for ONE chosen day.
//  • "energy" (kWh/kVArh) accumulates → one bar per period (week / month / billing period).
type PowerKey = "apparent" | "active";
type EnergyKey = "energy" | "reactive";
type MetricKey = PowerKey | EnergyKey;
type Granularity = "day" | "week" | "month" | "billing_period";

// Series hues follow the entity, not the chart: active power/energy is always
// blue, apparent always aqua, reactive always violet — the same quantity keeps
// the same color wherever it appears. (Palette CVD-validated as a set.)
const HUE = {
  active: "#2a78d6",
  apparent: "#1baf7a",
  reactive: "#4a3aa7",
} as const;

// Chart chrome stays recessive: hairline solid gridlines, muted axis ink.
const GRID = "#e7e5e4";
const AXIS_INK = "#898781";

const POWER: Record<
  PowerKey,
  { label: string; field: keyof IntervalRow; unit: string; color: string; hint: string }
> = {
  apparent: { label: "Apparent power (kVA)", field: "avgDemandKva", unit: "kVA", color: HUE.apparent, hint: METRIC_HINTS.apparentPower },
  active: { label: "Active power (kW)", field: "avgDemandKw", unit: "kW", color: HUE.active, hint: METRIC_HINTS.demandInterval },
};

const ENERGY: Record<
  EnergyKey,
  { label: string; field: keyof EnergyPeriodRow; unit: string; color: string; hint: string }
> = {
  energy: { label: "Energy consumption (kWh)", field: "activeEnergyKwh", unit: "kWh", color: HUE.active, hint: METRIC_HINTS.activeEnergy },
  reactive: { label: "Reactive energy (kVArh)", field: "reactiveEnergyKvarh", unit: "kVArh", color: HUE.reactive, hint: METRIC_HINTS.reactiveEnergy },
};

const isEnergy = (k: MetricKey): k is EnergyKey => k === "energy" || k === "reactive";

// Grouped metric selector: energy names stacked together, power graphs together.
const SELECTOR_OPTIONS = [
  {
    type: "section" as const,
    title: "Energy — by period",
    options: [
      { value: "energy", label: ENERGY.energy.label },
      { value: "reactive", label: ENERGY.reactive.label },
    ],
  },
  {
    type: "section" as const,
    title: "Power — by day",
    options: [
      { value: "apparent", label: POWER.apparent.label },
      { value: "active", label: POWER.active.label },
    ],
  },
];

const GRANULARITY_OPTIONS = [
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
  { value: "billing_period", label: "Billing period" },
];

const DATE_INPUT_STYLE: React.CSSProperties = {
  border: `1px solid ${GRID}`,
  borderRadius: 8,
  padding: "7px 10px",
  fontSize: 13,
  color: "#1c1917",
  background: "#fff",
  fontFamily: "inherit",
  lineHeight: 1.2,
  colorScheme: "light",
};

// ── Timezone helpers: resolve a calendar day in the SITE's zone to a UTC [from, to). ──
// The picker deals in the site's local day; the API wants UTC instants, so we translate
// using the zone's offset at that moment (correct across DST, though SA has none).
function tzParts(tz: string, at: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  let hour = get("hour");
  if (hour === 24) hour = 0; // some engines render midnight as 24
  return { y: get("year"), mo: get("month"), d: get("day"), h: hour, mi: get("minute"), s: get("second") };
}

function todayInTz(tz: string): string {
  const { y, mo, d } = tzParts(tz, new Date());
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function zonedDayRange(dayStr: string, tz: string): { from: Date; to: Date } {
  const guess = new Date(`${dayStr}T00:00:00Z`);
  const p = tzParts(tz, guess);
  const localAsUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  const offset = localAsUtc - guess.getTime(); // ms the zone is ahead of UTC
  const from = new Date(guess.getTime() - offset); // shift so local wall-clock = 00:00 of dayStr
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { from, to };
}

function fmtDayLabel(dayStr: string): string {
  const [y, m, d] = dayStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-ZA", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Interval labels must read in the SITE's timezone (the day window is chosen in it), NOT the
// viewer's browser zone — otherwise a 10:00Z peak shows at a browser-dependent hour.
function fmtTime(iso: string, tz: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: tz });
}

// Axis ticks read faster compacted (216k, 1.2M) — the tooltip carries exact values.
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

const TICK = { fontSize: 11, fill: AXIS_INK };

// biome-ignore lint/suspicious/noExplicitAny: recharts tooltip content props are untyped
function ChartTooltip({ active, payload, label, unit }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        borderRadius: 8,
        border: `1px solid ${GRID}`,
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
          {exact.format(Number(payload[0].value))} {unit}
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
        border: `1px dashed ${GRID}`,
        color: AXIS_INK,
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
  siteId,
  demandIntervalMinutes,
  timezone,
}: {
  siteId: string;
  demandIntervalMinutes: number;
  timezone: string;
}) {
  const [metricKey, setMetricKey] = useState<MetricKey>("energy");
  const [day, setDay] = useState<string>(() => todayInTz(timezone));
  const [granularity, setGranularity] = useState<Granularity>("day");

  // Auto-refresh the live power series (only material when viewing today).
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const today = todayInTz(timezone);
  const { from, to } = useMemo(() => zonedDayRange(day, timezone), [day, timezone]);

  // Power series for the chosen day; energy buckets for the chosen granularity.
  const { data: demand } = useRPC(
    () => client.demand.listIntervals({ siteId, from, to }),
    [siteId, from.getTime(), to.getTime(), tick],
  );
  const { data: energyByPeriod } = useRPC(
    () => client.readings.energyByPeriod({ siteId, granularity }),
    [siteId, granularity],
  );
  const intervals: IntervalRow[] = demand?.intervals ?? [];

  // Single header row: static title + metric selector + the metric-specific control
  // (period selector for energy, day picker for power).
  const header = (hint: string, control: React.ReactNode) => (
    <Stack direction="horizontal" justify="between" align="center" wrap="wrap" gap={3}>
      <Stack direction="horizontal" gap={2} align="center">
        <span style={{ display: "inline-flex", color: AXIS_INK }}>
          <BarChart3 size={16} />
        </span>
        <InfoLabel label="History" hint={hint} strong />
      </Stack>
      <Stack direction="horizontal" gap={2} align="center" wrap="wrap">
        <div style={{ width: "min(240px, 100%)" }}>
          <Selector
            label="Chart metric"
            isLabelHidden
            options={SELECTOR_OPTIONS}
            value={metricKey}
            onChange={(v) => setMetricKey(v as MetricKey)}
          />
        </div>
        {control}
      </Stack>
    </Stack>
  );

  // ── Energy view: one bar per period (week / month / billing period). ──
  if (isEnergy(metricKey)) {
    const metric = ENERGY[metricKey];
    const periods = energyByPeriod?.periods ?? [];
    const data = periods.map((p) => ({
      label: p.label,
      value: Number.parseFloat((p[metric.field] as string) ?? "0"),
    }));
    const basis = energyByPeriod?.basis;
    const caption =
      basis === "day"
        ? "Daily energy totals."
        : basis === "week"
          ? "Weekly energy totals."
          : basis === "month"
            ? "Monthly energy totals."
            : basis === "calendar_month"
              ? "Shown per calendar month until a billing period is set for this site — set it on an uploaded invoice or in site settings."
              : "One bar per billing period for this site.";

    const periodControl = (
      <div style={{ width: "min(170px, 100%)" }}>
        <Selector
          label="Period"
          isLabelHidden
          options={GRANULARITY_OPTIONS}
          value={granularity}
          onChange={(v) => setGranularity(v as Granularity)}
        />
      </div>
    );

    return (
      <Stack gap={4}>
        {header(metric.hint, periodControl)}

        <Text type="supporting" size="sm">
          {caption}
        </Text>

        {data.length === 0 ? (
          <EmptyChart message="No energy data yet — bars appear once metering readings accumulate over a period." />
        ) : (
          <div style={{ height: 256, width: "100%" }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={8} />
                <YAxis tick={TICK} tickFormatter={(v: number) => compact.format(v)} tickLine={false} axisLine={false} width={44} />
                <Tooltip content={(p) => <ChartTooltip {...p} unit={metric.unit} />} cursor={{ fill: "rgb(120 113 108 / 0.08)" }} />
                <Bar dataKey="value" fill={metric.color} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Stack>
    );
  }

  // ── Power view: per-interval demand series for the chosen day. ──
  const metric = POWER[metricKey];
  const data = intervals.map((iv) => {
    const raw = iv[metric.field] as string | null;
    // Gap incomplete intervals (data gaps): the register catches up in one interval, inflating
    // its demand into a phantom spike that can outrank the true peak. Null ⇒ the area breaks
    // there rather than plotting a false value — matching how the peak-demand tile excludes them.
    const value = iv.isComplete && raw != null ? Number.parseFloat(raw) : null;
    return { label: fmtTime(iv.intervalStart, timezone), value };
  });

  // Each point sits at its interval's START, and the area only paints between two points — so a
  // complete interval right before a gap would paint nothing across its own half-hour, making the
  // data look like it ends 30 min early. Hold that value into ONLY the first gap slot so the block
  // fills to its end boundary; the blank then begins where the data truly stops. Use the ORIGINAL
  // values so the hold can't chain forward and bridge the whole gap (a gap is always ≥2 slots).
  const original = data.map((d) => d.value);
  for (let i = 1; i < data.length; i++) {
    if (original[i] === null && original[i - 1] !== null) {
      data[i] = { ...data[i], value: original[i - 1] };
    }
  }

  const dayControl = (
    <input
      type="date"
      value={day}
      max={today}
      onChange={(e) => setDay(e.target.value || today)}
      style={DATE_INPUT_STYLE}
      aria-label="Day to show"
    />
  );

  return (
    <Stack gap={4}>
      {header(metric.hint, dayControl)}

      <Text type="supporting" size="sm">
        Average demand per {demandIntervalMinutes}-minute interval on {fmtDayLabel(day)}
        {day === today ? " (today)" : ""}.
      </Text>

      {data.length === 0 ? (
        <EmptyChart message="No interval data for this day." />
      ) : (
        <div style={{ height: 256, width: "100%" }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={24} />
              <YAxis tick={TICK} tickFormatter={(v: number) => compact.format(v)} tickLine={false} axisLine={false} width={44} />
              <Tooltip content={(p) => <ChartTooltip {...p} unit={metric.unit} />} />
              <Area
                type="monotone"
                dataKey="value"
                stroke={metric.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                fill={metric.color}
                fillOpacity={0.1}
                connectNulls={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Stack>
  );
}
