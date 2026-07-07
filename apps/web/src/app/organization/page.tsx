"use client";

import { client } from "@/lib/client";
import { useOrganization } from "@/lib/useOrganization";
import { useRPC } from "@/lib/useRPC";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Building, Plus, ShieldCheck, UserPlus, X } from "lucide-react";
import { useState } from "react";

type Level = "viewer" | "editor" | "site_admin";
const LEVELS = [
  { value: "viewer", label: "Viewer — view only" },
  { value: "editor", label: "Editor — upload, download & reply" },
  { value: "site_admin", label: "Site admin — also manage access" },
];
const normLevel = (r: string): Level =>
  r === "owner" ? "site_admin" : r === "site_manager" ? "editor" : (r as Level);

export default function OrganizationPage() {
  const { organizationId } = useOrganization();
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  const { data, loading, error: loadError } = useRPC(
    () => (organizationId ? client.org.accessOverview({ organizationId }) : Promise.resolve(null)),
    [organizationId, tick],
  );

  // Invite form.
  const [invEmail, setInvEmail] = useState("");
  const [invSite, setInvSite] = useState("");
  const [invLevel, setInvLevel] = useState<Level>("viewer");
  const [invMsg, setInvMsg] = useState("");

  // Per-member "add site access" row.
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [addSite, setAddSite] = useState("");
  const [addLevel, setAddLevel] = useState<Level>("viewer");

  const members = data?.members ?? [];
  const sites = data?.sites ?? [];
  const grants = data?.grants ?? [];
  const ownerCount = members.filter((m) => m.orgRole === "owner").length;
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? "Site";

  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      setTick((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  };

  const invite = async () => {
    if (!invEmail || !invSite) {
      setError("Enter an email and pick a site to invite someone.");
      return;
    }
    setInvMsg("");
    await run(async () => {
      await client.siteInvites.create({ siteId: invSite, email: invEmail, role: invLevel });
      setInvMsg(`Invitation sent to ${invEmail}.`);
      setInvEmail("");
    });
  };

  if (!organizationId) return null;

  if (loadError) {
    return (
      <Stack maxWidth={720}>
        <EmptyState
          icon={<Building size={28} />}
          title="Owners only"
          description="Organization management is available to organization owners."
          actions={<Button label="Go to dashboard" variant="secondary" href="/dashboard" />}
        />
      </Stack>
    );
  }

  return (
    <Stack gap={5}>
      <Stack gap={1}>
        <Heading level={2}>Organization</Heading>
        <Text type="supporting">
          Manage who's in your organization and what they can do on each site.
        </Text>
      </Stack>

      {error ? <Banner status="error" title={error} /> : null}

      {/* Invite */}
      <Card padding={5}>
        <Stack gap={4}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "hsl(221 83% 53%)", display: "inline-flex" }}>
              <UserPlus size={16} />
            </span>
            <Text weight="semibold">Invite someone</Text>
          </span>
          {invMsg ? <Banner status="success" title={invMsg} /> : null}
          <Stack direction="horizontal" gap={3} align="end" wrap="wrap">
            <TextInput
              label="Email address"
              type="email"
              value={invEmail}
              onChange={setInvEmail}
              width={240}
            />
            <Selector
              label="Site"
              placeholder="Choose a site…"
              options={sites.map((s) => ({ value: s.id, label: s.name }))}
              value={invSite}
              onChange={setInvSite}
              width={200}
            />
            <Selector
              label="Access level"
              options={LEVELS}
              value={invLevel}
              onChange={(v) => setInvLevel(v as Level)}
              width={240}
            />
            <Button label="Send invite" variant="primary" icon={<UserPlus size={16} />} onClick={invite} />
          </Stack>
        </Stack>
      </Card>

      {/* People */}
      <Card padding={5}>
        <Stack gap={4}>
          <Text weight="semibold">People</Text>
          {loading ? (
            <Stack gap={2}>
              <Skeleton height={60} />
              <Skeleton height={60} />
            </Stack>
          ) : members.length === 0 ? (
            <Text type="supporting">No members yet. Invite someone above.</Text>
          ) : (
            <Stack gap={4}>
              {members.map((m) => {
                const isOwner = m.orgRole === "owner";
                const isLastOwner = isOwner && ownerCount === 1;
                const myGrants = grants.filter((g) => g.userId === m.userId);
                const ungranted = sites.filter((s) => !myGrants.some((g) => g.siteId === s.id));
                return (
                  <div
                    key={m.userId}
                    style={{ borderTop: "0.5px solid hsl(210 16% 90%)", paddingTop: 16 }}
                  >
                    <Stack
                      direction="horizontal"
                      justify="between"
                      align="center"
                      gap={3}
                      wrap="wrap"
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <Text weight="medium">{m.name ?? m.email ?? m.userId}</Text>
                        {isOwner ? (
                          <Badge variant="success" label="Owner" />
                        ) : (
                          <Badge label="Member" />
                        )}
                      </span>
                      <Stack direction="horizontal" gap={2} align="center" wrap="wrap">
                        {isOwner ? (
                          <Button
                            label="Step down to member"
                            variant="secondary"
                            size="sm"
                            isDisabled={isLastOwner}
                            onClick={() =>
                              run(() =>
                                client.org.setMemberRole({
                                  organizationId,
                                  userId: m.userId,
                                  role: "member",
                                }),
                              )
                            }
                          />
                        ) : (
                          <Button
                            label="Make owner"
                            variant="secondary"
                            size="sm"
                            icon={<ShieldCheck size={14} />}
                            onClick={() =>
                              run(() =>
                                client.org.setMemberRole({
                                  organizationId,
                                  userId: m.userId,
                                  role: "owner",
                                }),
                              )
                            }
                          />
                        )}
                        <Button
                          label="Remove"
                          variant="secondary"
                          size="sm"
                          icon={<X size={14} />}
                          isDisabled={isLastOwner}
                          onClick={() =>
                            run(() => client.org.removeMember({ organizationId, userId: m.userId }))
                          }
                        />
                      </Stack>
                    </Stack>

                    {/* Per-site privileges */}
                    <div style={{ marginTop: 10, paddingLeft: 4 }}>
                      {isOwner ? (
                        <Text type="supporting">Owners can see and manage every site.</Text>
                      ) : (
                        <Stack gap={2}>
                          {myGrants.length === 0 ? (
                            <Text type="supporting">No site access yet.</Text>
                          ) : (
                            myGrants.map((g) => (
                              <Stack
                                key={g.siteId}
                                direction="horizontal"
                                justify="between"
                                align="center"
                                gap={3}
                                wrap="wrap"
                              >
                                <Text>{siteName(g.siteId)}</Text>
                                <Stack direction="horizontal" gap={2} align="center">
                                  <Selector
                                    label="Level"
                                    isLabelHidden
                                    options={LEVELS}
                                    value={normLevel(g.role)}
                                    onChange={(v) =>
                                      run(() =>
                                        client.siteAccess.grant({
                                          siteId: g.siteId,
                                          userId: m.userId,
                                          role: v as Level,
                                        }),
                                      )
                                    }
                                    width={230}
                                  />
                                  <Button
                                    label="Remove"
                                    variant="ghost"
                                    size="sm"
                                    icon={<X size={14} />}
                                    onClick={() =>
                                      run(() =>
                                        client.siteAccess.revoke({
                                          siteId: g.siteId,
                                          userId: m.userId,
                                        }),
                                      )
                                    }
                                  />
                                </Stack>
                              </Stack>
                            ))
                          )}

                          {/* Add access to another site */}
                          {addingFor === m.userId ? (
                            <Stack direction="horizontal" gap={2} align="end" wrap="wrap">
                              <Selector
                                label="Site"
                                placeholder="Site…"
                                options={ungranted.map((s) => ({ value: s.id, label: s.name }))}
                                value={addSite}
                                onChange={setAddSite}
                                width={180}
                              />
                              <Selector
                                label="Level"
                                options={LEVELS}
                                value={addLevel}
                                onChange={(v) => setAddLevel(v as Level)}
                                width={230}
                              />
                              <Button
                                label="Grant"
                                variant="primary"
                                size="sm"
                                isDisabled={!addSite}
                                onClick={() =>
                                  run(async () => {
                                    await client.siteAccess.grant({
                                      siteId: addSite,
                                      userId: m.userId,
                                      role: addLevel,
                                    });
                                    setAddingFor(null);
                                    setAddSite("");
                                  })
                                }
                              />
                              <Button
                                label="Cancel"
                                variant="ghost"
                                size="sm"
                                onClick={() => setAddingFor(null)}
                              />
                            </Stack>
                          ) : ungranted.length > 0 ? (
                            <div>
                              <Button
                                label="Add site access"
                                variant="ghost"
                                size="sm"
                                icon={<Plus size={14} />}
                                onClick={() => {
                                  setAddingFor(m.userId);
                                  setAddSite("");
                                  setAddLevel("viewer");
                                }}
                              />
                            </div>
                          ) : null}
                        </Stack>
                      )}
                    </div>
                  </div>
                );
              })}
            </Stack>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}
