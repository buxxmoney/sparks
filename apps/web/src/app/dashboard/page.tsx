"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Building2, MapPin } from "lucide-react";
import { Stack } from "@astryxdesign/core/Stack";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Banner } from "@astryxdesign/core/Banner";
import { useSession } from "@/lib/useSession";
import { useRPC } from "@/lib/useRPC";
import { useOrganization } from "@/lib/useOrganization";
import { client } from "@/lib/client";

// Neutral, theme-agnostic icon tile (derives from currentColor so it works in
// either light or dark mode without reaching for specific theme tokens).
const iconTileStyle: React.CSSProperties = {
  display: "inline-flex",
  width: 36,
  height: 36,
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "var(--radius-inner, 4px)",
  background: "color-mix(in srgb, currentColor 8%, transparent)",
  flexShrink: 0,
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const GRID_COLUMNS = { minWidth: 260, repeat: "fill" } as const;

export default function DashboardPage() {
  const router = useRouter();
  const { session, loading: sessionLoading } = useSession();
  const { organizationId } = useOrganization();

  const { data: sitesData, loading: sitesLoading, error: sitesError } = useRPC(
    organizationId ? () => client.sites.list({ organizationId, limit: 50, offset: 0 }) : null,
    [organizationId],
  );

  useEffect(() => {
    if (!sessionLoading && !session) router.push("/auth/login");
  }, [session, sessionLoading, router]);

  if (sessionLoading || !session) {
    return (
      <Stack gap={4}>
        <Skeleton width={200} height={32} />
        <Grid columns={GRID_COLUMNS} gap={4}>
          <Skeleton height={130} />
          <Skeleton height={130} />
          <Skeleton height={130} />
        </Grid>
      </Stack>
    );
  }

  const sites = sitesData?.sites ?? [];

  return (
    <Stack gap={5}>
      <Stack gap={1}>
        <Heading level={2}>Your sites</Heading>
        <Text type="supporting">
          Live metering and billing reconciliation across your portfolio.
        </Text>
      </Stack>

      {sitesError ? <Banner status="error" title={sitesError} /> : null}

      {sitesLoading ? (
        <Grid columns={GRID_COLUMNS} gap={4}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={130} />
          ))}
        </Grid>
      ) : sites.length > 0 ? (
        <Grid columns={GRID_COLUMNS} gap={4}>
          {sites.map((site) => (
            <ClickableCard key={site.id} label={site.name} href={`/sites/${site.id}`} padding={5}>
              <Stack gap={3} height="100%">
                {/* Icon tile on the left, live status quietly in the corner —
                    matches the stat-tile language of the site dashboard. */}
                <Stack direction="horizontal" justify="between" align="center" gap={2}>
                  <span style={iconTileStyle}>
                    <Building2 size={18} />
                  </span>
                  <Stack direction="horizontal" gap={2} align="center">
                    <StatusDot variant="success" label={capitalize(site.status)} />
                    <Text type="supporting" size="sm">{capitalize(site.status)}</Text>
                  </Stack>
                </Stack>
                <Stack gap={1}>
                  <Text weight="semibold">{site.name}</Text>
                  <Stack direction="horizontal" gap={1} align="center">
                    <MapPin size={14} />
                    <Text type="supporting">
                      {[site.addressLine1, site.city, site.province].filter(Boolean).join(", ") ||
                        "No address"}
                    </Text>
                  </Stack>
                </Stack>
              </Stack>
            </ClickableCard>
          ))}
        </Grid>
      ) : (
        <EmptyState
          icon={<Building2 size={28} />}
          title="No sites yet"
          description="Your metered sites will appear here once Sparks has set them up. Contact your Sparks account manager to add a site."
        />
      )}
    </Stack>
  );
}
