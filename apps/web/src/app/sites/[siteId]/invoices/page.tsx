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
import { ArrowLeft, Upload, X } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";

type BadgeVariant = "neutral" | "success" | "warning";
const INVOICE_BADGE: Record<string, BadgeVariant> = {
  locked: "success",
  confirmed: "success",
  parsed_pending_confirm: "warning",
};

function fmtDate(d: string | Date) {
  return new Date(d).toLocaleDateString();
}

export default function InvoicesPage() {
  const params = useParams();
  const router = useRouter();
  const siteId = params.siteId as string;

  const [showUploadForm, setShowUploadForm] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [uploadLoading, setUploadLoading] = useState(false);

  const { data: invoicesData, loading: invoicesLoading } = useRPC(
    () => client.invoices.list({ siteId }),
    [siteId],
  );
  const { data: site } = useRPC(() => client.sites.get({ siteId }), [siteId]);
  // Viewers are read-only; editors and above can upload/act.
  const canAct = site ? site.myLevel !== "viewer" : false;

  const invoices = invoicesData?.invoices ?? [];

  // Read a File to a base64 string (without the data: prefix).
  const toBase64 = (f: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(f);
    });

  const handleUpload = async () => {
    if (!file) {
      setUploadError("Please choose a PDF invoice to upload");
      return;
    }
    setUploadLoading(true);
    setUploadError("");
    try {
      const contentBase64 = await toBase64(file);
      const data = await client.invoices.uploadAndParse({
        siteId,
        filename: file.name,
        contentBase64,
      });
      router.push(`/sites/${siteId}/invoices/${data.invoiceId}`);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Failed to upload and parse invoice");
    } finally {
      setUploadLoading(false);
    }
  };

  return (
    <Stack gap={5}>
      <Stack direction="horizontal" justify="between" align="end" wrap="wrap" gap={3}>
        <Stack gap={2}>
          <Link href={`/sites/${siteId}`}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <ArrowLeft size={16} /> Back to site
            </span>
          </Link>
          <Heading level={2}>Invoices</Heading>
        </Stack>
        {canAct ? (
          <Button
            label={showUploadForm ? "Cancel" : "Upload invoice"}
            variant={showUploadForm ? "secondary" : "primary"}
            icon={showUploadForm ? <X size={16} /> : <Upload size={16} />}
            onClick={() => setShowUploadForm((s) => !s)}
          />
        ) : (
          <Badge label="View only" />
        )}
      </Stack>

      {showUploadForm ? (
        <Card padding={5}>
          <Stack gap={4}>
            <Text weight="semibold">Upload invoice</Text>
            {uploadError ? <Banner status="error" title={uploadError} /> : null}
            <Stack gap={1}>
              <Text type="supporting">Invoice PDF</Text>
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <Text type="supporting">
                The billing period and line items are read from the invoice — you review and confirm
                them (and can fix the period) on the next screen.
              </Text>
            </Stack>
            <div style={{ display: "grid" }}>
              <Button
                label={uploadLoading ? "Uploading & parsing…" : "Upload & parse"}
                variant="primary"
                isLoading={uploadLoading}
                onClick={handleUpload}
              />
            </div>
          </Stack>
        </Card>
      ) : null}

      <Card padding={5}>
        <Stack gap={3}>
          <Text weight="semibold">Invoice history</Text>
          {invoicesLoading ? (
            <Stack gap={2}>
              <Skeleton height={40} />
              <Skeleton height={40} />
            </Stack>
          ) : invoices.length > 0 ? (
            <Table
              data={invoices}
              columns={[
                {
                  key: "period",
                  header: "Period",
                  renderCell: (i) => (
                    <Text weight="medium">
                      {fmtDate(i.billingPeriodStart)} – {fmtDate(i.billingPeriodEnd)}
                    </Text>
                  ),
                },
                {
                  key: "status",
                  header: "Status",
                  renderCell: (i) => (
                    <Badge
                      variant={INVOICE_BADGE[i.status] ?? "neutral"}
                      label={i.status.replace(/_/g, " ")}
                    />
                  ),
                },
                {
                  key: "createdAt",
                  header: "Uploaded",
                  renderCell: (i) => <Text type="supporting">{fmtDate(i.createdAt)}</Text>,
                },
                {
                  key: "action",
                  header: "",
                  renderCell: (i) => (
                    <Button
                      label="View"
                      variant="secondary"
                      size="sm"
                      href={`/sites/${siteId}/invoices/${i.id}`}
                    />
                  ),
                },
              ]}
              density="compact"
              dividers="rows"
            />
          ) : (
            <Text type="supporting">No invoices yet.</Text>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}
