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
import { Text } from "@astryxdesign/core/Text";
import { Bell, CheckCircle2, ChevronRight, Download, FileText, Scale } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type AlertPayload = {
  reconId?: string;
  invoiceId?: string;
  verified?: boolean;
  // Explicit destination that overrides the site-derived link (e.g. operator
  // alerts point at "/admin", where the recipient has no per-site access).
  href?: string;
  // New: several attachments. `attachmentName` is the legacy single-attachment shape.
  attachments?: { key: string; name: string }[];
  attachmentName?: string | null;
} | null;

export default function AlertsPage() {
  const router = useRouter();
  const { data, loading, refetch } = useRPC(() => client.alerts.list(), []);
  const [busy, setBusy] = useState(false);
  const alerts = data?.alerts ?? [];
  const hasUnread = alerts.some((a) => !a.readAt);

  const markAllRead = async () => {
    setBusy(true);
    try {
      await client.alerts.markAllRead();
      await refetch();
    } finally {
      setBusy(false);
    }
  };

  const markRead = async (deliveryId: string) => {
    await client.alerts.acknowledge({ deliveryId });
    await refetch();
  };

  const downloadAttachment = async (alertId: string, attachmentKey?: string) => {
    const { url } = await client.alerts.attachmentUrl({ alertId, attachmentKey });
    window.open(url, "_blank");
  };

  return (
    <Stack gap={5}>
      <Stack direction="horizontal" justify="between" align="end" wrap="wrap" gap={3}>
        <Stack gap={1}>
          <Heading level={2}>Alerts</Heading>
          <Text type="supporting">Updates on your bill reviews and your sites.</Text>
        </Stack>
        {hasUnread ? (
          <Button
            label={busy ? "Marking…" : "Mark all read"}
            variant="secondary"
            icon={<CheckCircle2 size={16} />}
            isLoading={busy}
            onClick={markAllRead}
          />
        ) : null}
      </Stack>

      {loading ? (
        <Stack gap={3}>
          <Skeleton height={90} />
          <Skeleton height={90} />
        </Stack>
      ) : alerts.length === 0 ? (
        <EmptyState
          icon={<Bell size={28} />}
          title="No alerts yet"
          description="When Sparks finishes reviewing a bill, the outcome shows up here."
        />
      ) : (
        <Stack gap={3}>
          {alerts.map((a) => {
            const payload = a.payload as AlertPayload;
            const unread = !a.readAt;
            const verified = payload?.verified === true;
            // Where this alert takes you: an explicit payload href wins (operator
            // alerts → /admin); otherwise the invoice (parse-ready) or the bill
            // check (review outcome), on the alert's site.
            const targetHref = payload?.href
              ? payload.href
              : a.siteId
                ? payload?.invoiceId
                  ? `/sites/${a.siteId}/invoices/${payload.invoiceId}`
                  : payload?.reconId
                    ? `/sites/${a.siteId}/bill-check/${payload.reconId}`
                    : null
                : null;
            // Opening a message just navigates — it does NOT mark it read, because
            // marking read deletes it (see alertsAcknowledge). The recipient dismisses
            // explicitly via "Mark read" / "Mark all read".
            const openAlert = () => {
              if (!targetHref) return;
              router.push(targetHref);
            };
            return (
              <Card key={a.deliveryId} padding={5}>
                <Stack gap={3}>
                  {/* Clickable header + message → opens the invoice/bill-check. */}
                  <div
                    onClick={targetHref ? openAlert : undefined}
                    onKeyDown={
                      targetHref
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") openAlert();
                          }
                        : undefined
                    }
                    role={targetHref ? "button" : undefined}
                    tabIndex={targetHref ? 0 : undefined}
                    style={{ cursor: targetHref ? "pointer" : "default" }}
                  >
                    <Stack gap={3}>
                      <Stack direction="horizontal" justify="between" align="start" gap={3} wrap="wrap">
                        <Stack direction="horizontal" gap={2} align="center">
                          <span
                            style={{
                              display: "inline-flex",
                              color: verified ? "hsl(142 71% 35%)" : "hsl(38 92% 40%)",
                            }}
                          >
                            {verified ? <CheckCircle2 size={18} /> : <FileText size={18} />}
                          </span>
                          <Text weight="semibold">{a.title}</Text>
                          {unread ? <Badge variant="warning" label="New" /> : null}
                        </Stack>
                        <Stack direction="horizontal" gap={2} align="center">
                          <Text type="supporting">{new Date(a.createdAt).toLocaleString()}</Text>
                          {targetHref ? (
                            <ChevronRight size={18} style={{ opacity: 0.4, flexShrink: 0 }} />
                          ) : null}
                        </Stack>
                      </Stack>

                      {a.message ? (
                        <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.6 }}>
                          {a.message}
                        </div>
                      ) : null}
                    </Stack>
                  </div>

                  <Stack direction="horizontal" gap={2} wrap="wrap">
                    {payload?.reconId && a.siteId ? (
                      <Button
                        label="View bill check"
                        variant="primary"
                        icon={<Scale size={16} />}
                        href={`/sites/${a.siteId}/bill-check/${payload.reconId}`}
                      />
                    ) : payload?.href ? (
                      <Button
                        label="Open review queue"
                        variant="primary"
                        icon={<Scale size={16} />}
                        href={payload.href}
                      />
                    ) : null}
                    {/* New multi-attachment shape, then legacy single. */}
                    {(payload?.attachments ?? []).map((att) => (
                      <Button
                        key={att.key}
                        label={`Download ${att.name}`}
                        variant="secondary"
                        icon={<Download size={16} />}
                        onClick={() => downloadAttachment(a.alertId, att.key)}
                      />
                    ))}
                    {!payload?.attachments && payload?.attachmentName ? (
                      <Button
                        label={`Download ${payload.attachmentName}`}
                        variant="secondary"
                        icon={<Download size={16} />}
                        onClick={() => downloadAttachment(a.alertId)}
                      />
                    ) : null}
                    {unread ? (
                      <Button
                        label="Mark read"
                        variant="ghost"
                        onClick={() => markRead(a.deliveryId)}
                      />
                    ) : null}
                  </Stack>
                </Stack>
              </Card>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
