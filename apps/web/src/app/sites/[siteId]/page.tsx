"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  FileText,
  Scale,
  Activity,
  CalendarRange,
  Radio,
  MapPin,
  Clock,
  Settings,
  BarChart3,
} from "lucide-react";
import { Stack } from "@astryxdesign/core/Stack";
import { Grid } from "@astryxdesign/core/Grid";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table } from "@astryxdesign/core/Table";
import { Banner } from "@astryxdesign/core/Banner";
import { Link } from "@astryxdesign/core/Link";
import { useRPC } from "@/lib/useRPC";
import { client } from "@/lib/client";
import { MetricStat, METRIC_HINTS } from "@/components/metric";
import { ConsumptionChart } from "@/components/charts/ConsumptionChart";

type BadgeVariant = "success" | "warning" | "error" | "neutral";

const DEVICE_BADGE: Record<string, BadgeVariant> = {
  online: "success",
  provisioning: "neutral",
  degraded: "warning",
  offline: "error",
};

const PRIMARY = "hsl(221 83% 53%)";

function num(value: string | number | null | undefined, digits = 2): string {
  if (value == null) return "—";
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isNaN(n) ? "—" : n.toFixed(digits);
}

// Section-card header: an accented icon + title, with optional right-aligned content.
function CardHead({ icon, title, right }: { icon: ReactNode; title: string; right?: ReactNode }) {
  return (
    <Stack direction="horizontal" justify="between" align="center" gap={2}>
      <Stack direction="horizontal" gap={2} align="center">
        <span style={{ display: "inline-flex", color: PRIMARY }}>{icon}</span>
        <Text weight="semibold">{title}</Text>
      </Stack>
      {right}
    </Stack>
  );
}

function InfoField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack gap={1}>
      <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "hsl(215 16% 47%)" }}>
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
  const { data: demand } = useRPC(() => client.demand.listIntervals({ siteId }), [siteId, tick]);

  const reading = latest?.reading;
  const devices = devicesData?.devices ?? [];
  const intervals = demand?.intervals ?? [];

  if (loading) {
    return (
      <Stack gap={6}>
        <Skeleton width={260} height={32} />
        <Grid columns={{ minWidth: 340, repeat: "fit" }} gap={6}>
          <Skeleton height={190} />
          <Skeleton height={190} />
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
              <ArrowLeft size={16} /> Back to Overview
            </span>
          </Link>
          <Stack direction="horizontal" gap={3} align="center">
            <Heading level={2}>{site.name}</Heading>
            <Badge variant="success" label={site.status} />
          </Stack>
          <Stack direction="horizontal" gap={2} align="center" wrap="wrap">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "hsl(215 16% 47%)" }}>
              <MapPin size={14} />
              <Text type="supporting">
                {[site.city, site.province].filter(Boolean).join(", ") || "No address on file"}
              </Text>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "hsl(215 16% 47%)" }}>
              <Clock size={14} />
              <Text type="supporting">{site.timezone}</Text>
            </span>
          </Stack>
        </Stack>
        <Stack direction="horizontal" gap={2} wrap="wrap">
          <Button label="Settings" variant="secondary" icon={<Settings size={16} />} href={`/sites/${siteId}/settings`} />
          <Button label="Invoices" variant="secondary" icon={<FileText size={16} />} href={`/sites/${siteId}/invoices`} />
          <Button label="Reconciliations" variant="primary" icon={<Scale size={16} />} href={`/sites/${siteId}/reconciliation`} />
        </Stack>
      </Stack>

      {/* KPI cards */}
      <Grid columns={{ minWidth: 340, repeat: "fit" }} gap={6}>
        <Card padding={5}>
          <Stack gap={4}>
            <CardHead
              icon={<Activity size={16} />}
              title="Current load"
              right={
                reading?.time ? (
                  <Text type="supporting" size="sm">as of {new Date(reading.time).toLocaleString()}</Text>
                ) : null
              }
            />
            {reading ? (
              <Grid columns={3} gap={4}>
                <MetricStat label="Active Power" hint={METRIC_HINTS.activePower} value={num(reading.totalPowerKw)} unit="kW" accent="primary" />
                <MetricStat label="Apparent Power" hint={METRIC_HINTS.apparentPower} value={num(reading.totalApparentKva)} unit="kVA" />
                <MetricStat label="Power Factor" hint={METRIC_HINTS.powerFactor} value={num(reading.powerFactor, 3)} />
              </Grid>
            ) : (
              <Text type="supporting">No live readings yet for this site.</Text>
            )}
          </Stack>
        </Card>

        <Card padding={5}>
          <Stack gap={4}>
            <CardHead
              icon={<CalendarRange size={16} />}
              title="Month to date"
              right={
                mtd?.periodStart ? (
                  <Text type="supporting" size="sm">since {new Date(mtd.periodStart).toLocaleDateString()}</Text>
                ) : null
              }
            />
            <Grid columns={3} gap={4}>
              <MetricStat label="Active Energy" hint={METRIC_HINTS.activeEnergy} value={num(mtd?.activeEnergyKwh)} unit="kWh" accent="primary" />
              <MetricStat label="Peak Demand" hint={METRIC_HINTS.peakDemand} value={num(mtd?.peakDemandKva)} unit="kVA" accent="warning" />
              <MetricStat label="Reactive Energy" hint={METRIC_HINTS.reactiveEnergy} value={num(mtd?.reactiveEnergyKvarh)} unit="kVArh" />
            </Grid>
          </Stack>
        </Card>
      </Grid>

      {/* Consumption chart (default: energy kWh; switchable) */}
      <Card padding={5}>
        <Stack gap={3}>
          <CardHead icon={<BarChart3 size={16} />} title="Consumption" />
          <ConsumptionChart intervals={intervals} />
        </Stack>
      </Card>

      {/* Devices */}
      <Card padding={5}>
        <Stack gap={3}>
          <CardHead icon={<Radio size={16} />} title="Devices & Connectivity" />
          {devices.length > 0 ? (
            <Table
              data={devices}
              columns={[
                {
                  key: "serialNumber",
                  header: "Serial",
                  renderCell: (d) => <Text weight="medium">{d.serialNumber}</Text>,
                },
                {
                  key: "status",
                  header: "Status",
                  renderCell: (d) => <Badge variant={DEVICE_BADGE[d.status] ?? "neutral"} label={d.status} />,
                },
                {
                  key: "connectivityMode",
                  header: "Link",
                  renderCell: (d) => <Text type="supporting">{d.connectivityMode?.toUpperCase() ?? "—"}</Text>,
                },
                {
                  key: "lastSeenAt",
                  header: "Last Seen",
                  renderCell: (d) => (
                    <Text type="supporting">
                      {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "Never"}
                    </Text>
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
