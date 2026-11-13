"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  FileText,
  Scale,
  CalendarRange,
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
import { Table, proportional } from "@astryxdesign/core/Table";
import { Banner } from "@astryxdesign/core/Banner";
import { Link } from "@astryxdesign/core/Link";
import { useRPC } from "@/lib/useRPC";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { client } from "@/lib/client";
import { MetricStat, METRIC_HINTS, formatReading } from "@/components/metric";
import { ConsumptionChart } from "@/components/charts/ConsumptionChart";
import { type BillPeriodView, BillToDate } from "@/components/bill-to-date";
import { LoadingVeil } from "@/components/loading-veil";
import { OperatorBillingCycle } from "@/components/operator-billing-cycle";
import { OperatorTariff } from "@/components/operator-tariff";
import { SettingsDrawer } from "@/components/settings-drawer";

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

  // Operators open a settings drawer to adjust this site's billing cycle — the
  // window the "billing period to date" and peak-demand cards are computed over.
  // Saving bumps `tick`, so those cards refetch against the new window without a
  // reload; the drawer sits over the page, so they're still in view behind it.
  const [settingsOpen, setSettingsOpen] = useState(false);

  const { data: site, loading, error } = useRPC(() => client.sites.get({ siteId }), [siteId]);
  // Energy only: peak demand is no longer shown, and skipping it spares the
  // per-interval scan it needs.
  const { data: mtd } = useRPC(
    () => client.readings.monthToDate({ siteId, includePeak: false }),
    [siteId, tick],
  );
  // The period the cost card is showing. The energy card mirrors it; until the
  // cost card reports (or when the site has no tariff) it falls back to the
  // current period's month-to-date figure.
  const [billPeriod, setBillPeriod] = useState<BillPeriodView | null>(null);
  const followBill =
    billPeriod !== null && (billPeriod.activeEnergyKwh !== null || billPeriod.isClosed);
  const energyKwh = followBill ? billPeriod.activeEnergyKwh : mtd?.activeEnergyKwh;
  const energyPeriodStart = followBill ? billPeriod.periodStart : mtd?.periodStart;
  const energyPeriodEnd = followBill ? billPeriod.periodEnd : null;
  const energyClosed = followBill && billPeriod.isClosed;
  const shortDay = (iso: string) =>
    new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  const { data: devicesData } = useRPC(() => client.devices.list({ siteId }), [siteId, tick]);
  // The history chart owns its own data fetching (it varies by the day / period the user
  // picks in its controls), so the page no longer fetches intervals or energy-by-period.

  const devices = devicesData?.devices ?? [];
  // Below this width the devices table's minimum column widths exceed the
  // viewport and it spills; re-arrange each row into a stacked card instead.
  // The same breakpoint shrinks the header action buttons so three of them
  // don't crowd a phone.
  const isNarrow = useMediaQuery("(max-width: 640px)");
  const btnSize = isNarrow ? "sm" : "md";

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

  // Sparks operators view any site cross-tenant, read-only (site.myLevel === "operator").
  // They reach it from the operator console, so send them back there and hide writes.
  const isOperator = site.myLevel === "operator";

  return (
    <Stack gap={6}>
      {isOperator ? (
        <Banner
          status="info"
          title="Operator view — read-only"
          description="You're viewing this customer site as a Sparks operator. Changes are made from the operator console, apart from the billing cycle in Site settings."
        />
      ) : null}
      {/* Header */}
      <Stack direction="horizontal" justify="between" align="start" wrap="wrap" gap={3}>
        <Stack gap={2}>
          <Link href={isOperator ? "/admin" : "/dashboard"}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <ArrowLeft size={16} /> {isOperator ? "Back to operator console" : "Back to sites"}
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
        {/* Invoices / bill checks / settings are the customer's workflow — an
            operator only monitors the live dashboard, so hide the whole action
            group for them (the server rejects these writes regardless). */}
        {isOperator ? (
          <Button
            label="Site settings"
            variant="secondary"
            size={btnSize}
            icon={<Settings size={16} />}
            onClick={() => setSettingsOpen(true)}
          />
        ) : (
          <Stack direction="horizontal" gap={2} wrap="wrap">
            <Button label="Bill checks" variant="primary" size={btnSize} icon={<Scale size={16} />} href={`/sites/${siteId}/bill-check`} />
            <Button label="Invoices" variant="secondary" size={btnSize} icon={<FileText size={16} />} href={`/sites/${siteId}/invoices`} />
            <Button label="Settings" variant="secondary" size={btnSize} icon={<Settings size={16} />} href={`/sites/${siteId}/settings`} />
          </Stack>
        )}
      </Stack>

      {/* Overview — energy used this billing period on the left, what it is
          estimated to cost on the right. Energy is the figure a customer actually
          tracks; the instantaneous-load, reactive-energy and peak-demand tiles
          that used to sit here were removed as noise. The energy card follows the
          period selected on the cost card, so the two never describe different
          periods. Stacks to one column on a phone. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isNarrow ? "1fr" : "minmax(260px, 1fr) minmax(0, 2fr)",
          gap: 16,
          alignItems: "stretch",
        }}
      >
        <Card padding={5} height="100%">
          <Stack gap={4} height="100%">
            <CardHead
              icon={<CalendarRange size={16} />}
              title="Energy used"
              right={
                energyPeriodStart ? (
                  <Text type="supporting" size="sm">
                    {energyClosed && energyPeriodEnd
                      ? `${shortDay(energyPeriodStart)} – ${shortDay(energyPeriodEnd)}`
                      : `since ${shortDay(energyPeriodStart)}`}
                  </Text>
                ) : null
              }
            />
            <LoadingVeil active={billPeriod?.pending === true} label="Loading…">
              <Stack gap={2}>
                <MetricStat
                  label="Active Energy"
                  hint={METRIC_HINTS.activeEnergy}
                  value={formatReading(energyKwh, 0)}
                  unit="kWh"
                  size="lg"
                />
                <Text type="supporting" size="sm">
                  {energyClosed
                    ? "Consumed over the full billing period."
                    : "Consumed so far this billing period."}
                </Text>
              </Stack>
            </LoadingVeil>
          </Stack>
        </Card>

        {/* Estimated cost — priced from the same register readings as the energy
            figure beside it. Renders nothing for customers whose site has no
            tariff assigned, in which case the energy card stands alone. */}
        <BillToDate siteId={siteId} isOperator={isOperator} tick={tick} onPeriod={setBillPeriod} />
      </div>

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

      {/* Operator settings, as a right-hand drawer over the dashboard: the billing
          cycle and the tariff. Everything else an operator could change is still
          done from the operator console. */}
      {isOperator ? (
        <SettingsDrawer isOpen={settingsOpen} onOpenChange={setSettingsOpen} title="Site settings">
          <OperatorBillingCycle siteId={siteId} onSaved={() => setTick((t) => t + 1)} />
          <OperatorTariff siteId={siteId} onSaved={() => setTick((t) => t + 1)} />
        </SettingsDrawer>
      ) : null}
    </Stack>
  );
}
