"use client";

import { type GroupedLine, InvoiceReview, type ReviewLine } from "@/components/invoice-review";
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
import { Text } from "@astryxdesign/core/Text";
import { ArrowLeft, CalendarRange, RotateCcw, Scale } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

type BadgeVariant = "neutral" | "success" | "warning";

function fmtDate(d: string | Date) {
  return new Date(d).toLocaleDateString();
}

// The stored period is half-open [start, end); show the INCLUSIVE dates the user
// recognises from the invoice (end = stored end − 1 day) as YYYY-MM-DD.
function toDateInput(d: string | Date, dayOffset = 0): string {
  const dt = new Date(d);
  dt.setUTCDate(dt.getUTCDate() + dayOffset);
  return dt.toISOString().slice(0, 10);
}

function fmtRand(cents: number) {
  return `R ${(cents / 100).toFixed(2)}`;
}

export default function InvoiceDetailPage() {
  const params = useParams();
  const siteId = params.siteId as string;
  const invoiceId = params.invoiceId as string;

  const [lines, setLines] = useState<ReviewLine[]>([]);
  const [error, setError] = useState("");
  const [sendLoading, setSendLoading] = useState(false);
  const [sentMsg, setSentMsg] = useState("");
  const [sentReconId, setSentReconId] = useState<string | null>(null);

  // Editable billing period (read from the invoice; shown as inclusive dates).
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [periodMsg, setPeriodMsg] = useState<"idle" | "saving" | "saved">("idle");

  const {
    data: invoice,
    loading: invoiceLoading,
    refetch: refetchInvoice,
  } = useRPC(() => client.invoices.get({ invoiceId }), [invoiceId]);
  const { data: site } = useRPC(() => client.sites.get({ siteId }), [siteId]);
  // Viewers are read-only; editors and above can send for review / reopen.
  const canAct = site ? site.myLevel !== "viewer" : false;

  useEffect(() => {
    if (invoice) {
      setPeriodStart(toDateInput(invoice.billingPeriodStart));
      setPeriodEnd(toDateInput(invoice.billingPeriodEnd, -1)); // stored end is exclusive
    }
  }, [invoice]);

  const savePeriod = async () => {
    setPeriodMsg("saving");
    setError("");
    try {
      await client.invoices.setPeriod({
        invoiceId,
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
      });
      await refetchInvoice();
      setPeriodMsg("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update the billing period");
      setPeriodMsg("idle");
    }
  };

  useEffect(() => {
    if (invoice && invoice.status === "parsed_pending_confirm") {
      const fetchLineItems = async () => {
        try {
          const data = await client.invoices.listLineItems({ invoiceId });
          setLines(
            data.lineItems.map((li) => ({
              id: li.id,
              rawLabel: li.rawLabel,
              // Prefer any previously-confirmed grouping (e.g. after a Reopen).
              component: li.confirmedComponent ?? li.component ?? "other",
              utility: li.confirmedUtility ?? li.utility ?? "other",
              supplyGroup: li.confirmedSupplyGroup ?? li.supplyGroup ?? "unknown",
              unit: li.unit ?? null,
              quantity:
                li.quantity !== null && li.quantity !== undefined ? Number(li.quantity) : null,
              rate: li.rate !== null && li.rate !== undefined ? Number(li.rate) : null,
              valueCents: li.confirmedValueCents ?? li.parsedValueCents ?? 0,
            })),
          );
        } catch (err) {
          console.error("Failed to load line items", err);
        }
      };
      fetchLineItems();
    }
  }, [invoice, invoiceId]);

  // "Send to Sparks for review": pin the parser's numbers (confirm + freeze +
  // generate the provisional reconciliation) and flag it for the QA queue. Sparks
  // corrects the grouping and verifies; the customer just waits to hear back.
  const handleSend = async (grouped: GroupedLine[], note: string) => {
    setSendLoading(true);
    setError("");
    setSentMsg("");
    try {
      const data = await client.invoices.confirmReconcile({ invoiceId, lines: grouped });
      await client.invoices.requestReview({ invoiceId, note: note || undefined });
      setSentReconId(data.reconId);
      setSentMsg("Sent to Sparks — our team will review your bill and get back to you.");
      await refetchInvoice();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send for review");
    } finally {
      setSendLoading(false);
    }
  };


  // Parsing runs in the background. While the invoice is still being read (and hasn't
  // failed), poll every 2s so the screen flips to the review as soon as it's ready.
  const isParsing =
    !!invoice && !invoice.parseError && (invoice.status === "parsing" || invoice.status === "uploaded");
  useEffect(() => {
    if (!isParsing) return;
    const id = setInterval(() => refetchInvoice(), 2000);
    return () => clearInterval(id);
  }, [isParsing, refetchInvoice]);

  const [retryLoading, setRetryLoading] = useState(false);
  const handleRetry = async () => {
    setRetryLoading(true);
    setError("");
    try {
      await client.invoices.retryParse({ invoiceId });
      await refetchInvoice();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to retry parsing");
    } finally {
      setRetryLoading(false);
    }
  };

  // Only show the full-page skeleton on the FIRST load. During background polling
  // (every 2s while parsing) `invoiceLoading` briefly flips true on each refetch —
  // if we returned the skeleton then, the page would flicker skeleton ↔ content.
  // Once we have the invoice, keep rendering it (the "Reading…" card handles parsing).
  if (invoiceLoading && !invoice) {
    return (
      <Stack gap={5}>
        <Skeleton height={32} width={220} />
        <Skeleton height={180} />
      </Stack>
    );
  }

  if (!invoice) {
    return <Banner status="error" title="Invoice not found" />;
  }

  const isPendingConfirm = invoice.status === "parsed_pending_confirm";
  const isConfirmed = invoice.status === "confirmed";
  const isLocked = invoice.status === "locked";
  const hasParseError = !!invoice.parseError;
  const reading = isParsing; // still being read in the background
  const statusLabel = hasParseError
    ? "couldn't read"
    : reading
      ? "reading…"
      : invoice.status.replace(/_/g, " ");
  const statusVariant: BadgeVariant = hasParseError
    ? "warning"
    : isLocked || isConfirmed
      ? "success"
      : reading
        ? "neutral"
        : "warning";

  return (
    <Stack gap={5}>
      <Stack direction="horizontal" justify="between" align="end" wrap="wrap" gap={3}>
        <Stack gap={2}>
          <Link href={`/sites/${siteId}/invoices`}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <ArrowLeft size={16} /> Back to invoices
            </span>
          </Link>
          <Heading level={2}>Invoice review</Heading>
        </Stack>
        <Badge variant={statusVariant} label={statusLabel} />
      </Stack>

      {error ? <Banner status="error" title={error} /> : null}

      {/* Background parsing is still running. */}
      {reading ? (
        <Card padding={5}>
          <Stack gap={3} align="center">
            <Text weight="semibold">Reading your invoice…</Text>
            <Text type="supporting">
              We're extracting the billing period and charges. This usually takes a few seconds —
              the page updates automatically when it's ready.
            </Text>
            <Skeleton height={120} />
          </Stack>
        </Card>
      ) : null}

      {/* Parsing failed — show why and let the customer retry against the stored PDF. */}
      {hasParseError ? (
        <Card padding={5}>
          <Stack gap={4}>
            <Banner
              status="error"
              title="We couldn't read this invoice"
              description={invoice.parseError ?? undefined}
            />
            <Text type="supporting">
              This can happen with an unusual layout or a scanned copy. Try again, or upload a
              clearer PDF.
            </Text>
            {canAct ? (
              <div style={{ display: "grid" }}>
                <Button
                  label={retryLoading ? "Retrying…" : "Try again"}
                  variant="primary"
                  icon={<RotateCcw size={16} />}
                  isLoading={retryLoading}
                  onClick={handleRetry}
                />
              </div>
            ) : null}
          </Stack>
        </Card>
      ) : null}

      {!reading && !hasParseError ? (
      <Card padding={5}>
        <Stack gap={3}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <CalendarRange size={16} color="hsl(221 83% 45%)" />
            <Text weight="semibold">Billing period</Text>
            <Text type="supporting">
              — the dates we read from your invoice. They set the period your usage is checked
              against, so check they match your bill and adjust if needed.
            </Text>
          </span>
          {isPendingConfirm ? (
            <Stack direction="horizontal" gap={3} align="end" wrap="wrap">
              <Stack gap={1}>
                <Text type="supporting">From</Text>
                <input
                  type="date"
                  value={periodStart}
                  onChange={(e) => {
                    setPeriodStart(e.target.value);
                    setPeriodMsg("idle");
                  }}
                />
              </Stack>
              <Stack gap={1}>
                <Text type="supporting">To (last day billed)</Text>
                <input
                  type="date"
                  value={periodEnd}
                  onChange={(e) => {
                    setPeriodEnd(e.target.value);
                    setPeriodMsg("idle");
                  }}
                />
              </Stack>
              <Button
                label={periodMsg === "saving" ? "Saving…" : "Save period"}
                variant="secondary"
                isLoading={periodMsg === "saving"}
                onClick={savePeriod}
              />
              {periodMsg === "saved" ? <Text type="supporting">Saved.</Text> : null}
            </Stack>
          ) : (
            <Text>
              {fmtDate(invoice.billingPeriodStart)} –{" "}
              {fmtDate(toDateInput(invoice.billingPeriodEnd, -1))}
            </Text>
          )}
        </Stack>
      </Card>
      ) : null}

      {isPendingConfirm ? (
        <Card padding={5}>
          <Stack gap={4}>
            <Text weight="semibold">Your electricity charges</Text>
            {lines.length > 0 ? (
              <InvoiceReview
                lines={lines}
                onSend={handleSend}
                sendLoading={sendLoading}
                canSend={canAct}
              />
            ) : (
              <Text type="supporting">No line items found.</Text>
            )}
          </Stack>
        </Card>
      ) : null}

      {(isConfirmed || isLocked) && !isPendingConfirm ? (
        <Card padding={5}>
          <Stack gap={4}>
            <Banner
              status="success"
              title={sentMsg || "Sent to Sparks — our team is reviewing your bill."}
              description="We'll check the charges against your meter and get back to you. Your bill check is provisional until we've verified it."
            />
            <Heading level={4}>
              Amount we're checking: {fmtRand(invoice.confirmedTotalCents ?? 0)}
            </Heading>
            <Stack direction="horizontal" gap={3} wrap="wrap">
              <Button
                label="View bill check"
                variant="primary"
                icon={<Scale size={16} />}
                href={
                  sentReconId
                    ? `/sites/${siteId}/bill-check/${sentReconId}`
                    : `/sites/${siteId}/bill-check`
                }
              />
            </Stack>
            <Text type="supporting">
              It's with Sparks now — we'll get back to you. Need a change? Reply to us and we'll sort
              it out.
            </Text>
          </Stack>
        </Card>
      ) : null}
    </Stack>
  );
}
