"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Stack } from "@astryxdesign/core/Stack";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Banner } from "@astryxdesign/core/Banner";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Link } from "@astryxdesign/core/Link";
import { client } from "@/lib/client";

export default function NewSitePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);

  const [formData, setFormData] = useState({
    name: "",
    addressLine1: "",
    city: "",
    province: "",
  });

  useEffect(() => {
    const getOrgId = async () => {
      try {
        const data = await client.session.me();
        setOrganizationId(data.organizationId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load organization");
      } finally {
        setInitializing(false);
      }
    };
    getOrgId();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    if (!organizationId) {
      setError("Unable to determine organization. Please log in again.");
      setLoading(false);
      return;
    }

    try {
      // Timezone (Africa/Johannesburg) and demand interval (30 min) default on the
      // server — an operator only needs the site's name and address here.
      const result = await client.sites.create({
        organizationId,
        name: formData.name,
        addressLine1: formData.addressLine1,
        city: formData.city,
        province: formData.province,
      });

      if (result.id) {
        router.refresh();
        router.push(`/sites/${result.id}`);
      } else {
        throw new Error("Site creation failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const update = (field: string, value: string) => setFormData((f) => ({ ...f, [field]: value }));

  if (initializing) {
    return (
      <Stack gap={4}>
        <Skeleton height={32} width={200} />
        <Skeleton height={280} />
      </Stack>
    );
  }

  if (!organizationId) {
    return (
      <Stack gap={4}>
        <Banner status="error" title={error || "Unable to determine organization. Please log in again."} />
        <div style={{ display: "grid", justifyItems: "start" }}>
          <Button label="Back to Overview" variant="secondary" onClick={() => router.push("/dashboard")} />
        </div>
      </Stack>
    );
  }

  return (
    <Stack gap={5}>
      <Stack gap={2}>
        <Link href="/dashboard">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ArrowLeft size={16} /> Back to overview
          </span>
        </Link>
        <Heading level={2}>Create new site</Heading>
      </Stack>

      <Card padding={5}>
        <form onSubmit={handleSubmit}>
          <Stack gap={4}>
            {error ? <Banner status="error" title={error} /> : null}
            <TextInput
              label="Site name"
              isRequired
              value={formData.name}
              onChange={(v) => update("name", v)}
              placeholder="e.g. Sandton City — Shop 42"
              width="100%"
            />
            <TextInput label="Address line 1" isRequired value={formData.addressLine1} onChange={(v) => update("addressLine1", v)} width="100%" />
            <Stack direction="horizontal" gap={4} wrap="wrap">
              <TextInput label="City" isRequired value={formData.city} onChange={(v) => update("city", v)} width={240} />
              <TextInput label="Province" isRequired value={formData.province} onChange={(v) => update("province", v)} width={240} />
            </Stack>
            <Text type="supporting">Timezone and demand interval are configured per site in Settings after creation.</Text>
            <Stack direction="horizontal" justify="end" gap={3}>
              <Button label="Cancel" type="button" variant="secondary" onClick={() => router.push("/dashboard")} />
              <Button label={loading ? "Creating…" : "Create site"} type="submit" variant="primary" isLoading={loading} />
            </Stack>
          </Stack>
        </form>
      </Card>
    </Stack>
  );
}
