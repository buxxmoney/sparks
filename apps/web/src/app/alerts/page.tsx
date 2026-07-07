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
import { Bell, CheckCircle2, Download, FileText, Scale } from "lucide-react";
import { useState } from "react";

type AlertPayload = {
  reconId?: string;
  verified?: boolean;
  attachmentName?: string | null;
} | null;

export default function AlertsPage() {
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

  const downloadAttachment = async (alertId: string) => {
    const { url } = await client.alerts.attachmentUrl({ alertId });
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
            return (
              <Card key={a.deliveryId} padding={5}>
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
                    <Text type="supporting">{new Date(a.createdAt).toLocaleString()}</Text>
                  </Stack>

                  {a.message ? (
                    <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.6 }}>
                      {a.message}
                    </div>
                  ) : null}

                  <Stack direction="horizontal" gap={2} wrap="wrap">
                    {payload?.reconId && a.siteId ? (
                      <Button
                        label="View reconciliation"
                        variant="primary"
                        icon={<Scale size={16} />}
                        href={`/sites/${a.siteId}/reconciliation/${payload.reconId}`}
                      />
                    ) : null}
                    {payload?.attachmentName ? (
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
