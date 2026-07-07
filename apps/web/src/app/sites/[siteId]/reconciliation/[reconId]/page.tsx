"use client";

import { client } from "@/lib/client";
import { useRPC } from "@/lib/useRPC";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { ArrowLeft, CheckCircle2, Download } from "lucide-react";
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

  const [finalizeLoading, setFinalizeLoading] = useState(false);
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

  const handleFinalize = async () => {
    setFinalizeLoading(true);
    setError("");
    try {
      await client.reconciliation.finalize({ reconId });
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to finalize reconciliation");
    } finally {
      setFinalizeLoading(false);
    }
  };

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
  const discrepancy = recon.discrepancyVsLandlordCents ?? 0;
  const discColor = discrepancy > 0 ? "hsl(0 72% 51%)" : "hsl(142 71% 40%)";

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
          {recon.status === "draft" ? (
            <Button
              label={finalizeLoading ? "Finalizing…" : "Finalize"}
              variant="primary"
              icon={<CheckCircle2 size={16} />}
              isLoading={finalizeLoading}
              onClick={handleFinalize}
            />
          ) : null}
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
          description="The numbers below are live so you can see them now, but the sealed dispute PDF only unlocks once Sparks has verified the reconciliation."
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

      <Card padding={5}>
        <Stack gap={4}>
          <Text weight="semibold">Tariff comparison</Text>
          <Grid columns={{ minWidth: 180 }} gap={4}>
            <Stat
              label="Expected (Landlord)"
              value={`R ${((recon.expectedLandlordCents ?? 0) / 100).toFixed(2)}`}
            />
            <Stat
              label="Charged"
              value={`R ${((recon.chargedTotalCents ?? 0) / 100).toFixed(2)}`}
            />
            <Stat
              label="Discrepancy"
              value={`${discrepancy > 0 ? "+" : ""}R ${(discrepancy / 100).toFixed(2)}`}
              color={discColor}
            />
          </Grid>
          {(recon.expectedCeilingCents ?? 0) > 0 ? (
            <>
              <Divider />
              <Text type="supporting">
                <strong>Legal ceiling</strong> — expected R{" "}
                {((recon.expectedCeilingCents ?? 0) / 100).toFixed(2)} · discrepancy R{" "}
                {((recon.discrepancyVsCeilingCents ?? 0) / 100).toFixed(2)}
              </Text>
            </>
          ) : null}
        </Stack>
      </Card>

      {recon.components && recon.components.length > 0 ? (
        <Card padding={5}>
          <Stack gap={4}>
            <Text weight="semibold">Charge-by-charge comparison</Text>
            <Text type="supporting">
              Each electricity component the landlord charged, against what the meter × the landlord
              tariff says it should be. A positive discrepancy means you were overcharged.
            </Text>
            <div style={{ overflowX: "auto" }}>
              <table
                style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 460 }}
              >
                <thead>
                  <tr style={{ color: "hsl(215 16% 55%)", fontSize: 11, textAlign: "right" }}>
                    <th style={{ textAlign: "left", fontWeight: 400, padding: "4px 0" }}>
                      Component
                    </th>
                    <th style={{ fontWeight: 400 }}>Charged</th>
                    <th style={{ fontWeight: 400 }}>Expected</th>
                    <th style={{ fontWeight: 400 }}>Discrepancy</th>
                  </tr>
                </thead>
                <tbody>
                  {recon.components.map((c) => {
                    const d = c.discrepancyVsLandlordCents;
                    const color = d > 0 ? "hsl(0 72% 45%)" : d < 0 ? "hsl(142 71% 35%)" : "inherit";
                    return (
                      <tr key={c.key} style={{ borderTop: "0.5px solid hsl(210 16% 90%)" }}>
                        <td style={{ padding: "8px 0" }}>{c.label}</td>
                        <td
                          style={{
                            padding: "8px 0",
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          R {(c.chargedCents / 100).toFixed(2)}
                        </td>
                        <td
                          style={{
                            padding: "8px 0",
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                            color: "hsl(215 16% 50%)",
                          }}
                        >
                          R {(c.expectedLandlordCents / 100).toFixed(2)}
                        </td>
                        <td
                          style={{
                            padding: "8px 0",
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                            fontWeight: 600,
                            color,
                          }}
                        >
                          {d > 0 ? "+" : ""}R {(d / 100).toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: "0.5px solid hsl(210 16% 80%)" }}>
                    <td style={{ padding: "8px 0", fontWeight: 500 }}>Total</td>
                    <td
                      style={{
                        padding: "8px 0",
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                        fontWeight: 500,
                      }}
                    >
                      R {((recon.chargedTotalCents ?? 0) / 100).toFixed(2)}
                    </td>
                    <td
                      style={{
                        padding: "8px 0",
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                        fontWeight: 500,
                        color: "hsl(215 16% 50%)",
                      }}
                    >
                      R {((recon.expectedLandlordCents ?? 0) / 100).toFixed(2)}
                    </td>
                    <td
                      style={{
                        padding: "8px 0",
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                        fontWeight: 600,
                        color: discColor,
                      }}
                    >
                      {discrepancy > 0 ? "+" : ""}R {(discrepancy / 100).toFixed(2)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Stack>
        </Card>
      ) : null}

      <Card padding={5}>
        <Stack gap={4}>
          <Text weight="semibold">Metadata</Text>
          <Grid columns={{ minWidth: 160 }} gap={4}>
            <Stat label="Status" value={recon.status} />
            <Stat label="Version" value={String(recon.version)} />
            <Stat label="Data Integrity" value={recon.dataIntegrityStatus} />
            <Stat label="Data Gaps" value={`${recon.gapCount} (${recon.gapMinutesTotal} min)`} />
          </Grid>
        </Stack>
      </Card>
    </Stack>
  );
}
