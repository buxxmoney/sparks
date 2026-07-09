"use client";

import { client } from "@/lib/client";
import { useRPC } from "@/lib/useRPC";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { ArrowLeft, Download } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";

function fmtDate(d: string | Date) {
  return new Date(d).toLocaleDateString();
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Text type="supporting">{label}</Text>
      <span
        style={{
          fontSize: 20,
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
          color: color ?? "inherit",
        }}
      >
        {value}
      </span>
    </div>
  );
}

export default function ReconciliationDetailPage() {
  const params = useParams();
  const siteId = params.siteId as string;
  const reconId = params.reconId as string;

  const [pdfLoading, setPdfLoading] = useState(false);
  const [error, setError] = useState("");

  const {
    data: recon,
    loading,
    refetch,
  } = useRPC(() => client.reconciliation.get({ reconId }), [reconId]);
  const { data: site } = useRPC(() => client.sites.get({ siteId }), [siteId]);
  // Viewers can see the outcome but not download the sealed PDF (editors+ only).
  const canAct = site ? site.myLevel !== "viewer" : false;

  const handleDownloadPDF = async () => {
    setPdfLoading(true);
    setError("");
    try {
      // Generate (seal) the PDF if one doesn't exist yet, then hand back a
      // short-lived signed URL and open it.
      if (!recon?.pdfHash) {
        await client.reconciliation.generatePdf({ reconId });
        await refetch();
      }
      const data = await client.report.getPdf({ reconId });
      window.open(data.presignedUrl, "_blank");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to download PDF");
    } finally {
      setPdfLoading(false);
    }
  };

  if (loading) {
    return (
      <Stack gap={5}>
        <Skeleton height={32} width={240} />
        <Skeleton height={160} />
        <Skeleton height={160} />
      </Stack>
    );
  }

  if (!recon) {
    return <Banner status="error" title="Reconciliation not found" />;
  }

  const hasDG = recon.gapCount > 0;

  const reviewStatus = recon.reviewStatus ?? "provisional";
  const isVerified = reviewStatus === "reviewed";
  const reviewBadge: { variant: "success" | "warning" | "neutral"; label: string } = isVerified
    ? { variant: "success", label: "Verified by Sparks" }
    : reviewStatus === "flagged"
      ? { variant: "warning", label: "Flagged by Sparks" }
      : { variant: "neutral", label: "Provisional — under review" };

  return (
    <Stack gap={5}>
      <Stack direction="horizontal" justify="between" align="end" wrap="wrap" gap={3}>
        <Stack gap={2}>
          <Link href={`/sites/${siteId}/reconciliation`}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <ArrowLeft size={16} /> Back to reconciliations
            </span>
          </Link>
          <Heading level={2}>Reconciliation report</Heading>
        </Stack>
        <Stack direction="horizontal" align="center" gap={3} wrap="wrap">
          <Badge variant={reviewBadge.variant} label={reviewBadge.label} />
          {canAct ? (
            <Button
              label={
                isVerified
                  ? pdfLoading
                    ? "Preparing…"
                    : recon.pdfHash
                      ? "Download sealed PDF"
                      : "Generate & download PDF"
                  : "Sealed PDF locked"
              }
              variant="secondary"
              icon={<Download size={16} />}
              isLoading={pdfLoading}
              isDisabled={!isVerified}
              onClick={handleDownloadPDF}
            />
          ) : (
            <Badge label="View only" />
          )}
        </Stack>
      </Stack>

      {error ? <Banner status="error" title={error} /> : null}

      {isVerified ? (
        <Banner
          status="success"
          title="Verified by Sparks — this reconciliation is dispute-ready."
          description="The sealed PDF carries a hash-stamped evidence trail you can download above."
        />
      ) : reviewStatus === "flagged" ? (
        <Banner
          status="warning"
          title="Sparks flagged this reconciliation"
          description={
            recon.reviewNote ||
            "Our team spotted something to correct. Reopen the invoice, fix the grouping, and reconcile again."
          }
        />
      ) : (
        <Banner
          status="info"
          title="Provisional — under Sparks review"
          description="Your bill is with our team. We'll check the charges against your meter and send you the outcome. The sealed dispute PDF unlocks once Sparks has verified the reconciliation."
        />
      )}

      {hasDG ? (
        <Banner
          status="warning"
          title="Data gaps detected"
          description={`${recon.gapCount} gap${recon.gapCount > 1 ? "s" : ""} totaling ${recon.gapMinutesTotal} minutes · integrity status: ${recon.dataIntegrityStatus}`}
        />
      ) : null}

      <Card padding={5}>
        <Stack gap={2}>
          <Text weight="semibold">Billing period</Text>
          <Text>
            {fmtDate(recon.billingPeriodStart)} – {fmtDate(recon.billingPeriodEnd)}
          </Text>
        </Stack>
      </Card>

      <Card padding={5}>
        <Stack gap={4}>
          <Text weight="semibold">Measured data</Text>
          <Grid columns={{ minWidth: 180 }} gap={4}>
            <Stat
              label="Active Energy"
              value={`${Number.parseFloat(recon.measuredActiveKwh ?? "0").toFixed(2)} kWh`}
            />
            <Stat
              label="Max Demand"
              value={`${Number.parseFloat(recon.measuredMaxDemandKva ?? "0").toFixed(2)} kVA`}
            />
            <Stat
              label="Reactive Energy"
              value={`${Number.parseFloat(recon.measuredReactiveKvarh ?? "0").toFixed(2)} kVArh`}
            />
          </Grid>
        </Stack>
      </Card>

      {/* Tariff comparison / component breakdown / metadata are intentionally NOT
          shown to the customer: they're pre-verification internals that would confuse
          them. The human-reviewed verdict is delivered by Sparks as a review outcome
          (Alerts inbox + email). Once verified, the sealed dispute PDF is the artifact. */}
    </Stack>
  );
}
