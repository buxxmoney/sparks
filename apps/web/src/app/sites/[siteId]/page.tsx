"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  FileText,
  Scale,
  Activity,
  CalendarRange,
  Gauge,
  Radio,
  MapPin,
  Clock,
  Settings,
} from "lucide-react";
import { Stack } from "@astryxdesign/core/Stack";
import { Grid } from "@astryxdesign/core/Grid";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Table, proportional } from "@astryxdesign/core/Table";
import { Banner } from "@astryxdesign/core/Banner";
import { Link } from "@astryxdesign/core/Link";
import { useRPC } from "@/lib/useRPC";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { client } from "@/lib/client";
import { MetricStat, METRIC_HINTS, formatReading } from "@/components/metric";
import { ConsumptionChart } from "@/components/charts/ConsumptionChart";

type BadgeVariant = "success" | "warning" | "error" | "neutral";

const DEVICE_BADGE: Record<string, BadgeVariant> = {
  online: "success",
  provisioning: "neutral",
  degraded: "warning",
  offline: "error",
};

const MUTED_INK = "var(--color-text-secondary, hsl(215 16% 47%))";

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Compact relative time for device heartbeats — "3 min ago" reads faster in a
// table than a full timestamp, and staleness is the thing that matters here.
function timeAgo(at: string | Date): string {
  const d = new Date(at);
  const min = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

function shortTime(at: string | Date): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Section header: a quiet icon + title, with optional right-aligned content.
// The icon stays in muted ink — section headers are wayfinding, not data.
function CardHead({ icon, title, right }: { icon: ReactNode; title: string; right?: ReactNode }) {
  return (
    <Stack direction="horizontal" justify="between" align="center" gap={2} wrap="wrap">
      <Stack direction="horizontal" gap={2} align="center">
        <span style={{ display: "inline-flex", color: MUTED_INK }}>{icon}</span>
        <Text weight="semibold">{title}</Text>
      </Stack>
      {right}
    </Stack>
  );
}

function InfoField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack gap={1}>
      <span
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: MUTED_INK,
        }}
      >
        {label}
      </span>
      <Text size="sm">{children}</Text>
    </Stack>
  );
}

export default function SiteDetailsPage() {
  const params = useParams();
  const siteId = params.siteId as string;

  // Live data refreshes every 30s (near-real-time load + consumption graphs).
  // `tick` bumps on an interval and is a dependency of the live queries below.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const { data: site, loading, error } = useRPC(() => client.sites.get({ siteId }), [siteId]);
  const { data: latest } = useRPC(() => client.readings.latest({ siteId }), [siteId, tick]);
  const { data: mtd } = useRPC(() => client.readings.monthToDate({ siteId }), [siteId, tick]);
  const { data: devicesData } = useRPC(() => client.devices.list({ siteId }), [siteId, tick]);
  // The history chart owns its own data fetching (it varies by the day / period the user
  // picks in its controls), so the page no longer fetches intervals or energy-by-period.

  const reading = latest?.reading;
  const devices = devicesData?.devices ?? [];
  // Below this width the devices table's minimum column widths exceed the
  // viewport and it spills; re-arrange each row into a stacked card instead.
  // The same breakpoint shrinks the header action buttons so three of them
  // don't crowd a phone.
  const isNarrow = useMediaQuery("(max-width: 640px)");
  const btnSize = isNarrow ? "sm" : "md";

  // Reactive power isn't stored on the instantaneous reading, but it's the third
  // side of the power triangle: Q = √(S² − P²), with S = apparent (kVA), P = active
  // (kW). Guard the root against tiny negatives from rounding.
  const activeKw = reading?.totalPowerKw != null ? Number.parseFloat(reading.totalPowerKw) : null;
  const apparentKva =
    reading?.totalApparentKva != null ? Number.parseFloat(reading.totalApparentKva) : null;
  const reactiveKvar =
    activeKw != null && apparentKva != null && !Number.isNaN(activeKw) && !Number.isNaN(apparentKva)
      ? Math.sqrt(Math.max(0, apparentKva * apparentKva - activeKw * activeKw))
      : null;
  if (loading) {
    return (
      <Stack gap={6}>
        <Skeleton width={260} height={32} />
        <Grid columns={{ minWidth: 200, repeat: "fill" }} gap={4}>
          <Skeleton height={110} />
          <Skeleton height={110} />
          <Skeleton height={110} />
          <Skeleton height={110} />
        </Grid>
        <Skeleton height={320} />
      </Stack>
    );
  }

  if (error || !site) {
    return (
      <Stack>
        <Banner status="error" title={error ?? "Site not found"} />
      </Stack>
    );
  }

  return (
    <Stack gap={6}>
      {/* Header */}
      <Stack direction="horizontal" justify="between" align="start" wrap="wrap" gap={3}>
        <Stack gap={2}>
          <Link href="/dashboard">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <ArrowLeft size={16} /> Back to sites
            </span>
          </Link>
          <Stack direction="horizontal" gap={3} align="center">
            <Heading level={2}>{site.name}</Heading>
            <Badge variant="success" label={capitalize(site.status)} />
          </Stack>
          <Stack direction="horizontal" gap={2} align="center" wrap="wrap">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: MUTED_INK }}>
              <MapPin size={14} />
              <Text type="supporting">
                {[site.city, site.province].filter(Boolean).join(", ") || "No address on file"}
              </Text>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: MUTED_INK }}>
              <Clock size={14} />
              <Text type="supporting">{site.timezone}</Text>
            </span>
          </Stack>
        </Stack>
        <Stack direction="horizontal" gap={2} wrap="wrap">
          <Button label="Bill checks" variant="primary" size={btnSize} icon={<Scale size={16} />} href={`/sites/${siteId}/bill-check`} />
          <Button label="Invoices" variant="secondary" size={btnSize} icon={<FileText size={16} />} href={`/sites/${siteId}/invoices`} />
          <Button label="Settings" variant="secondary" size={btnSize} icon={<Settings size={16} />} href={`/sites/${siteId}/settings`} />
        </Stack>
      </Stack>

      {/* Live overview — Current load (power) leads on the left with apparent
          power as the hero figure and active/reactive beneath it. On the right,
          energy used this billing period sits directly above the peak-demand
          block. Grid (not row-flex) so each card stretches to fill its column —
          row-flex wrappers let the cards shrink-wrap and left the tiles ragged.
          On narrow viewports the columns stack: load → energy → max demand. */}
      <Grid columns={{ minWidth: 340, repeat: "fill" }} gap={4}>
        <Card padding={5} height="100%">
          <Stack gap={4} height="100%">
            <CardHead
              icon={<Activity size={16} />}
              title="Current load"
              right={
                reading?.time ? (
                  <Stack direction="horizontal" gap={2} align="center">
                    <StatusDot variant="success" label="Live" isPulsing />
                    <Text type="supporting" size="sm">Updated {shortTime(reading.time)}</Text>
                  </Stack>
                ) : null
              }
            />
            {reading ? (
              <>
                <MetricStat
                  label="Apparent Power"
                  hint={METRIC_HINTS.apparentPower}
                  value={formatReading(apparentKva, 1)}
                  unit="kVA"
                  size="lg"
                />
                <div style={{ borderTop: "1px solid var(--color-border, #ebebeb)" }} />
                <Grid columns={{ minWidth: 130, repeat: "fill" }} gap={4}>
                  <MetricStat label="Active Power" hint={METRIC_HINTS.activePower} value={formatReading(activeKw, 1)} unit="kW" size="sm" />
                  <MetricStat label="Reactive Power" hint={METRIC_HINTS.reactivePower} value={formatReading(reactiveKvar, 1)} unit="kVAr" size="sm" />
                </Grid>
              </>
            ) : (
              <Text type="supporting">No live readings yet for this site.</Text>
            )}
          </Stack>
        </Card>

        {/* Right column: energy-to-date above maximum demand; the demand card
            grows to keep the column bottom-aligned with the load card. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16, height: "100%" }}>
          <Card padding={5}>
            <Stack gap={4}>
              <CardHead
                icon={<CalendarRange size={16} />}
                title="Billing period to date"
                right={
                  mtd?.periodStart ? (
                    <Text type="supporting" size="sm">
                      since {new Date(mtd.periodStart).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}
                    </Text>
                  ) : null
                }
              />
              <Grid columns={{ minWidth: 140, repeat: "fill" }} gap={5}>
                <MetricStat label="Active Energy" hint={METRIC_HINTS.activeEnergy} value={formatReading(mtd?.activeEnergyKwh, 0)} unit="kWh" />
                <MetricStat label="Reactive Energy" hint={METRIC_HINTS.reactiveEnergy} value={formatReading(mtd?.reactiveEnergyKvarh, 0)} unit="kVArh" />
              </Grid>
            </Stack>
          </Card>

          <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
            <Card padding={5} height="100%">
              <Stack gap={4} height="100%">
                <CardHead
                  icon={<Gauge size={16} />}
                  title="Maximum demand"
                  right={
                    mtd?.periodStart ? (
                      <Text type="supporting" size="sm">
                        since {new Date(mtd.periodStart).toLocaleDateString([], { day: "numeric", month: "short" })}
                      </Text>
                    ) : null
                  }
                />
                <MetricStat
                  label="Peak Network Demand"
                  hint={METRIC_HINTS.peakDemand}
                  value={formatReading(mtd?.peakDemandKva, 1)}
                  unit="kVA"
                  size="lg"
                />
                <Text type="supporting" size="sm">
                  Highest {site.demandIntervalMinutes}-minute interval average this billing period.
                </Text>
              </Stack>
            </Card>
          </div>
        </div>
      </Grid>

      {/* Historical — 24h power series + energy across billing periods (switchable).
          The chart owns its header row (title + metric selector). */}
      <Card padding={5}>
        <ConsumptionChart
          siteId={siteId}
          demandIntervalMinutes={site.demandIntervalMinutes}
          timezone={site.timezone}
        />
      </Card>

      {/* Devices */}
      <Card padding={5}>
        <Stack gap={3}>
          <CardHead icon={<Radio size={16} />} title="Devices & Connectivity" />
          {devices.length > 0 && isNarrow ? (
            <Stack gap={3}>
              {devices.map((d) => (
                <div
                  key={d.id}
                  style={{
                    border: "1px solid var(--color-border, #ebebeb)",
                    borderRadius: "var(--radius-inner, 4px)",
                    padding: 12,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <Stack direction="horizontal" justify="between" align="center" gap={2}>
                    <Text weight="medium">{d.serialNumber}</Text>
                    <Badge variant={DEVICE_BADGE[d.status] ?? "neutral"} label={capitalize(d.status)} />
                  </Stack>
                  <Stack direction="horizontal" justify="between" align="center" gap={2}>
                    <Text type="supporting" size="sm">{d.connectivityMode?.toUpperCase() ?? "—"}</Text>
                    <Text type="supporting" size="sm">
                      {d.lastSeenAt ? `Seen ${timeAgo(d.lastSeenAt)}` : "Never seen"}
                    </Text>
                  </Stack>
                </div>
              ))}
            </Stack>
          ) : devices.length > 0 ? (
            // Explicit column widths: without them each column takes the
            // 240px default minimum, overflowing the card even on desktop.
            // Table brings its own horizontal scroll wrapper for mobile.
            <Table
              data={devices}
              columns={[
                {
                  key: "serialNumber",
                  header: "Serial",
                  width: proportional(2, { minWidth: 150 }),
                  renderCell: (d) => (
                    <span style={{ whiteSpace: "nowrap" }}>
                      <Text weight="medium">{d.serialNumber}</Text>
                    </span>
                  ),
                },
                {
                  key: "status",
                  header: "Status",
                  width: proportional(1, { minWidth: 110 }),
                  renderCell: (d) => <Badge variant={DEVICE_BADGE[d.status] ?? "neutral"} label={capitalize(d.status)} />,
                },
                {
                  key: "connectivityMode",
                  header: "Link",
                  width: proportional(1, { minWidth: 90 }),
                  renderCell: (d) => <Text type="supporting">{d.connectivityMode?.toUpperCase() ?? "—"}</Text>,
                },
                {
                  key: "lastSeenAt",
                  header: "Last Seen",
                  width: proportional(1, { minWidth: 110 }),
                  renderCell: (d) => (
                    <span style={{ whiteSpace: "nowrap" }}>
                      <Text type="supporting">{d.lastSeenAt ? timeAgo(d.lastSeenAt) : "Never"}</Text>
                    </span>
                  ),
                },
              ]}
              density="compact"
              dividers="rows"
            />
          ) : (
            <Text type="supporting">No devices provisioned for this site.</Text>
          )}
        </Stack>
      </Card>

      {/* Site information */}
      <Card padding={5}>
        <Stack gap={4}>
          <Text weight="semibold">Site Information</Text>
          <Grid columns={{ minWidth: 200, repeat: "fit" }} gap={5}>
            <InfoField label="Address">
              {site.addressLine1 || "—"}
              <br />
              {[site.city, site.province].filter(Boolean).join(", ")}
            </InfoField>
            <InfoField label="Supply Zone">{site.supplyZone || "—"}</InfoField>
            <InfoField label="Timezone">{site.timezone}</InfoField>
            <InfoField label="Demand Interval">{site.demandIntervalMinutes} min</InfoField>
          </Grid>
        </Stack>
      </Card>
    </Stack>
  );
}
