"use client";

import { client } from "@/lib/client";
import { useRPC } from "@/lib/useRPC";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { UserPlus, X } from "lucide-react";
import { useState } from "react";

type Level = "viewer" | "editor" | "site_admin";

const LEVEL_OPTIONS = [
  { value: "viewer", label: "Viewer — view only" },
  { value: "editor", label: "Editor — upload, download & reply" },
  { value: "site_admin", label: "Site admin — also manage access" },
];
const LEVEL_LABEL: Record<string, string> = {
  viewer: "Viewer",
  editor: "Editor",
  site_admin: "Site admin",
  // legacy
  owner: "Site admin",
  site_manager: "Editor",
};

/**
 * Per-site "Team & access" management. A site admin (or org owner) invites people
 * by email at a chosen level, and manages existing grants. The server enforces
 * that only site_admin+ can reach these procedures.
 */
export function TeamAccess({ siteId }: { siteId: string }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Level>("viewer");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const { data: inviteData } = useRPC(() => client.siteInvites.list({ siteId }), [siteId, tick]);
  const { data: accessData } = useRPC(() => client.siteAccess.list({ siteId }), [siteId, tick]);
  const invites = inviteData?.invites ?? [];
  const grants = accessData?.grants ?? [];

  const refresh = () => setTick((t) => t + 1);

  const sendInvite = async () => {
    if (!email) {
      setError("Enter an email address to invite");
      return;
    }
    setLoading(true);
    setError("");
    setNotice("");
    try {
      await client.siteInvites.create({ siteId, email, role });
      setNotice(`Invitation sent to ${email} as ${LEVEL_LABEL[role]}.`);
      setEmail("");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send invitation");
    } finally {
      setLoading(false);
    }
  };

  const changeLevel = async (userId: string, level: Level) => {
    setError("");
    try {
      await client.siteAccess.grant({ siteId, userId, role: level });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change access");
    }
  };

  const revoke = async (userId: string) => {
    setError("");
    try {
      await client.siteAccess.revoke({ siteId, userId });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove access");
    }
  };

  const cancel = async (inviteId: string) => {
    setError("");
    try {
      await client.siteInvites.cancel({ inviteId });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel invitation");
    }
  };

  return (
    <Card padding={5}>
      <Stack gap={4}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "hsl(221 83% 53%)", display: "inline-flex" }}>
            <UserPlus size={16} />
          </span>
          <Text weight="semibold">Team &amp; access</Text>
        </span>
        <Text type="supporting">
          Invite people to this site. Viewers can see everything read-only; editors can upload,
          download and reply; site admins can also manage who has access.
        </Text>

        {error ? <Banner status="error" title={error} /> : null}
        {notice ? <Banner status="success" title={notice} /> : null}

        <Stack direction="horizontal" gap={3} align="end" wrap="wrap">
          <TextInput
            label="Email address"
            type="email"
            value={email}
            onChange={(v) => setEmail(v)}
            width={260}
          />
          <Selector
            label="Access level"
            options={LEVEL_OPTIONS}
            value={role}
            onChange={(v) => setRole(v as Level)}
            width={260}
          />
          <Button
            label={loading ? "Sending…" : "Send invite"}
            variant="primary"
            icon={<UserPlus size={16} />}
            isLoading={loading}
            onClick={sendInvite}
          />
        </Stack>

        {grants.length > 0 ? (
          <Stack gap={2}>
            <Text weight="medium">People with access</Text>
            {grants.map((g) => (
              <Stack
                key={g.userId}
                direction="horizontal"
                justify="between"
                align="center"
                gap={3}
                wrap="wrap"
              >
                <Text>{g.email ?? g.userId}</Text>
                <Stack direction="horizontal" gap={2} align="center">
                  <Selector
                    label="Level"
                    isLabelHidden
                    options={LEVEL_OPTIONS}
                    value={
                      g.role === "owner" ? "site_admin" : g.role === "site_manager" ? "editor" : g.role
                    }
                    onChange={(v) => changeLevel(g.userId, v as Level)}
                    width={220}
                  />
                  <Button
                    label="Remove"
                    variant="secondary"
                    size="sm"
                    icon={<X size={14} />}
                    onClick={() => revoke(g.userId)}
                  />
                </Stack>
              </Stack>
            ))}
          </Stack>
        ) : null}

        {invites.length > 0 ? (
          <Stack gap={2}>
            <Text weight="medium">Pending invitations</Text>
            {invites.map((inv) => (
              <Stack key={inv.id} direction="horizontal" justify="between" align="center" gap={3}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <Text>{inv.email}</Text>
                  <Badge variant="warning" label={LEVEL_LABEL[inv.role] ?? inv.role} />
                </span>
                <Button
                  label="Cancel"
                  variant="secondary"
                  size="sm"
                  icon={<X size={14} />}
                  onClick={() => cancel(inv.id)}
                />
              </Stack>
            ))}
          </Stack>
        ) : null}
      </Stack>
    </Card>
  );
}
