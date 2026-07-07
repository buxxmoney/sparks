"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, ChevronRight } from "lucide-react";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { setSelectedOrganization } from "@/lib/useOrganizationContext";
import { getSessionData } from "@/lib/api";
import { client } from "@/lib/client";
import { AuthShell } from "@/components/AuthShell";

interface Membership {
  organizationId: string;
  organizationName: string;
  role: string;
}

const iconTileStyle: React.CSSProperties = {
  display: "inline-flex",
  width: 40,
  height: 40,
  flexShrink: 0,
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 10,
  background: "color-mix(in srgb, currentColor 10%, transparent)",
};

export default function OrgSelectorPage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selecting, setSelecting] = useState(false);

  useEffect(() => {
    const loadMemberships = async () => {
      try {
        const session = await getSessionData();
        if (!session) {
          router.push("/auth/login");
          return;
        }

        const data = await client.session.listMemberships();
        setMemberships(data);

        if (data.length === 1) {
          setSelectedOrganization(data[0].organizationId);
          router.push("/dashboard");
          return;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load organizations");
      } finally {
        setLoading(false);
      }
    };

    loadMemberships();
  }, [router]);

  const handleSelectOrg = (orgId: string) => {
    setSelecting(true);
    setSelectedOrganization(orgId);
    router.push("/dashboard");
  };

  return (
    <AuthShell title="Select organization" subtitle="Choose which account to work in">
      {loading ? (
        <Stack gap={3}>
          <Skeleton height={64} />
          <Skeleton height={64} />
        </Stack>
      ) : error ? (
        <Stack gap={4}>
          <Banner status="error" title={error} />
          <Button label="Back to login" variant="secondary" onClick={() => router.push("/auth/login")} />
        </Stack>
      ) : memberships.length === 0 ? (
        <Stack gap={4}>
          <Banner status="info" title="You don't have access to any organizations yet. Please contact an administrator." />
          <Button label="Back to login" variant="secondary" onClick={() => router.push("/auth/login")} />
        </Stack>
      ) : (
        <Stack gap={3}>
          {memberships.map((m) => (
            <ClickableCard
              key={m.organizationId}
              label={m.organizationName}
              onClick={() => handleSelectOrg(m.organizationId)}
              isDisabled={selecting}
              padding={4}
            >
              <Stack direction="horizontal" gap={3} align="center">
                <span style={iconTileStyle}>
                  <Building2 size={20} />
                </span>
                <Stack gap={1} width="100%">
                  <Text weight="semibold">{m.organizationName}</Text>
                  <Badge label={`Role: ${m.role}`} />
                </Stack>
                <ChevronRight size={20} style={{ opacity: 0.4, flexShrink: 0 }} />
              </Stack>
            </ClickableCard>
          ))}
        </Stack>
      )}
    </AuthShell>
  );
}
