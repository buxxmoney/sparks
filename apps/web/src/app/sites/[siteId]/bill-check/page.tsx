"use client";

import { client } from "@/lib/client";
import { useRPC } from "@/lib/useRPC";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Stack } from "@astryxdesign/core/Stack";
import { Table } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { ArrowLeft } from "lucide-react";
import { useParams } from "next/navigation";

function fmtDate(d: string | Date) {
  return new Date(d).toLocaleDateString();
}

export default function ReconciliationPage() {
  const params = useParams();
  const siteId = params.siteId as string;

  const { data: reconciliationsData, loading: reconLoading } = useRPC(
    () => client.reconciliation.list({ siteId }),
    [siteId],
  );

  const recons = reconciliationsData?.reconciliations ?? [];

  return (
    <Stack gap={5}>
      <Stack gap={2}>
        <Link href={`/sites/${siteId}`}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ArrowLeft size={16} /> Back to site
          </span>
        </Link>
        <Heading level={2}>Bill checks</Heading>
      </Stack>

      <Banner
        status="info"
        title="Bill checks are generated from the invoices you send us. Upload your invoice and send it for review, and we'll check it against your meter for you."
      />

      <Card padding={5}>
        <Stack gap={3}>
          <Text weight="semibold">Bill check history</Text>
          {reconLoading ? (
            <Stack gap={2}>
              <Skeleton height={40} />
              <Skeleton height={40} />
            </Stack>
          ) : recons.length > 0 ? (
            <Table
              data={recons}
              columns={[
                {
                  key: "period",
                  header: "Period",
                  renderCell: (r) => (
                    <Text weight="medium">
                      {fmtDate(r.billingPeriodStart)} – {fmtDate(r.billingPeriodEnd)}
                    </Text>
                  ),
                },
                {
                  key: "status",
                  header: "Status",
                  renderCell: (r) => (
                    <Badge
                      variant={r.status === "final" ? "success" : "neutral"}
                      label={r.status}
                    />
                  ),
                },
                {
                  key: "measuredActiveKwh",
                  header: "Measured kWh",
                  renderCell: (r) => (
                    <Text>{Number.parseFloat(r.measuredActiveKwh ?? "0").toFixed(2)} kWh</Text>
                  ),
                },
                {
                  key: "discrepancy",
                  header: "Discrepancy",
                  renderCell: (r) => {
                    const disc = r.discrepancyVsLandlordCents ?? 0;
                    return (
                      <span
                        style={{
                          fontWeight: 600,
                          color: disc > 0 ? "hsl(0 72% 51%)" : "hsl(142 71% 40%)",
                        }}
                      >
                        R {(disc / 100).toFixed(2)}
                      </span>
                    );
                  },
                },
                {
                  key: "integrity",
                  header: "Data integrity",
                  renderCell: (r) => (
                    <Badge
                      variant={r.gapCount > 0 ? "warning" : "success"}
                      label={r.gapCount === 0 ? "OK" : `${r.gapCount} gaps`}
                    />
                  ),
                },
                {
                  key: "action",
                  header: "",
                  renderCell: (r) => (
                    <Button
                      label="View"
                      variant="secondary"
                      size="sm"
                      href={`/sites/${siteId}/bill-check/${r.id}`}
                    />
                  ),
                },
              ]}
              density="compact"
              dividers="rows"
            />
          ) : (
            <Text type="supporting">No bill checks yet.</Text>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}
