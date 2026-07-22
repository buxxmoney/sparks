"use client";

import { client } from "@/lib/client";
import { useRPC } from "@/lib/useRPC";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Stack } from "@astryxdesign/core/Stack";
import { Table } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { Activity, Building, Building2, ChevronDown, ChevronRight, MapPin } from "lucide-react";
import { useState } from "react";

const MUTED = "var(--color-text-secondary, hsl(215 16% 47%))";

// The sites under one organization — fetched lazily when its row is expanded, so
// we don't fan out a query per org on load. Each site links to its live dashboard
// (operators have cross-tenant read-only access; see requireSiteAccess).
function OrgSites({ organizationId }: { organizationId: string }) {
  const { data, loading } = useRPC(
    () => client.admin.listOrgSites({ organizationId }),
    [organizationId],
  );
  const sites = data?.sites ?? [];

  if (loading) {
    return (
      <Stack gap={2}>
        <Skeleton height={36} />
        <Skeleton height={36} />
      </Stack>
    );
  }

  if (sites.length === 0) {
    return <Text type="supporting">No sites under this organization yet.</Text>;
  }

  return (
    <Table
      data={sites}
      columns={[
        {
          key: "name",
          header: "Site",
          renderCell: (s) => <Text weight="medium">{s.name}</Text>,
        },
        {
          key: "city",
          header: "City",
          renderCell: (s) => (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: MUTED }}>
              <MapPin size={13} />
              <Text type="supporting">{s.city ?? "—"}</Text>
            </span>
          ),
        },
        {
          key: "status",
          header: "Status",
          renderCell: (s) => <Badge label={s.status} />,
        },
        {
          key: "open",
          header: "",
          renderCell: (s) => (
            <Button
              label="Open dashboard"
              variant="secondary"
              size="sm"
              icon={<Activity size={14} />}
              href={`/sites/${s.id}`}
            />
          ),
        },
      ]}
      density="compact"
      dividers="rows"
    />
  );
}

export default function OrganizationsPage() {
  const { data, loading, error } = useRPC(() => client.admin.listOrganizations(), []);
  const organizations = data?.organizations ?? [];
  const [openId, setOpenId] = useState<string | null>(null);

  // listOrganizations is operator-gated on the server; a non-operator gets
  // FORBIDDEN. Mirror the operator-admin denial rather than a raw error.
  if (error) {
    return (
      <Stack gap={6} height="100%">
        <Heading level={2}>Organizations</Heading>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: "100%", maxWidth: 440 }}>
            <EmptyState
              icon={<Building2 size={28} />}
              title="Operators only"
              description="This area is for Sparks platform operators. If you reached it by mistake, head back to your dashboard."
              actions={<Button label="Go to dashboard" variant="secondary" href="/dashboard" />}
            />
          </div>
        </div>
      </Stack>
    );
  }

  return (
    <Stack gap={5}>
      <Stack gap={1}>
        <Heading level={2}>Organizations</Heading>
        <Text type="supporting">
          Every customer organization and its sites. Open any site to monitor its live dashboard
          (read-only).
        </Text>
      </Stack>

      {loading ? (
        <Stack gap={3}>
          <Skeleton height={64} />
          <Skeleton height={64} />
          <Skeleton height={64} />
        </Stack>
      ) : organizations.length === 0 ? (
        <EmptyState
          icon={<Building size={28} />}
          title="No organizations yet"
          description="Provision a customer in the operator admin to see it here."
          actions={<Button label="Operator admin" variant="secondary" href="/admin" />}
        />
      ) : (
        <Stack gap={3}>
          {organizations.map((org) => {
            const isOpen = openId === org.id;
            return (
              <Card key={org.id} padding={4}>
                <Stack gap={isOpen ? 4 : 0}>
                  <button
                    type="button"
                    onClick={() => setOpenId((cur) => (cur === org.id ? null : org.id))}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                      <span style={{ display: "inline-flex", color: MUTED }}>
                        {isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                      </span>
                      <span style={{ display: "flex", flexDirection: "column" }}>
                        <Text weight="semibold">{org.name}</Text>
                        {org.ownerEmail ? (
                          <Text type="supporting" size="sm">
                            {org.ownerEmail}
                          </Text>
                        ) : null}
                      </span>
                    </span>
                    <Badge
                      variant="neutral"
                      label={`${org.siteCount} ${org.siteCount === 1 ? "site" : "sites"}`}
                    />
                  </button>

                  {isOpen ? <OrgSites organizationId={org.id} /> : null}
                </Stack>
              </Card>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
