"use client";

import { useState } from "react";
import {
  Building2,
  UserPlus,
  MapPin,
  ClipboardCheck,
  ExternalLink,
  Send,
  ScrollText,
  Trash2,
  Upload,
} from "lucide-react";
import { Stack } from "@astryxdesign/core/Stack";
import { Grid } from "@astryxdesign/core/Grid";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { Badge } from "@astryxdesign/core/Badge";
import { Table } from "@astryxdesign/core/Table";
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useRPC } from "@/lib/useRPC";
import { client } from "@/lib/client";

const PRIMARY = "hsl(221 83% 53%)";

export default function AdminPage() {
  const { data: orgData, loading, error, refetch } = useRPC(
    () => client.admin.listOrganizations(),
    [],
  );

  // Provision-customer form.
  const [cName, setCName] = useState("");
  const [cEmail, setCEmail] = useState("");
  const [orgName, setOrgName] = useState("");
  const [custMsg, setCustMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [custBusy, setCustBusy] = useState(false);

  // Add-site form.
  const [siteOrgId, setSiteOrgId] = useState("");
  const [siteName, setSiteName] = useState("");
  const [siteAddr, setSiteAddr] = useState("");
  const [siteCity, setSiteCity] = useState("");
  const [siteProvince, setSiteProvince] = useState("");
  const [siteMsg, setSiteMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [siteBusy, setSiteBusy] = useState(false);

  // Sparks QA queue — reconciliations awaiting sign-off.
  const {
    data: queueData,
    loading: queueLoading,
    refetch: refetchQueue,
  } = useRPC(() => client.admin.listReviewQueue(), []);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [queueMsg, setQueueMsg] = useState<{ kind: "success" | "error"; text: string } | null>(
    null,
  );
  // The recon the operator is composing an outcome for (null = queue view).
  const [respondTo, setRespondTo] = useState<{ reconId: string; siteName: string } | null>(null);
  const [outSubject, setOutSubject] = useState("");
  const [outBody, setOutBody] = useState("");
  const [outFile, setOutFile] = useState<{ name: string; base64: string } | null>(null);

  const organizations = orgData?.organizations ?? [];
  const queue = queueData?.queue ?? [];

  const openRespond = (reconId: string, siteName: string) => {
    setRespondTo({ reconId, siteName });
    setOutSubject("Your bill review is complete");
    setOutBody("");
    setOutFile(null);
    setQueueMsg(null);
  };

  const pickFile = (file: File | undefined) => {
    if (!file) {
      setOutFile(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      setOutFile({ name: file.name, base64: result.split(",")[1] ?? "" });
    };
    reader.readAsDataURL(file);
  };

  // Reference tariff schedules (Eskom / municipal published prices).
  const { data: schedData, refetch: refetchSched } = useRPC(
    () => client.admin.tariffSchedulesList(),
    [],
  );
  const schedules = schedData?.schedules ?? [];
  const [schName, setSchName] = useState("");
  const [schProvider, setSchProvider] = useState("");
  const [schFrom, setSchFrom] = useState("");
  const [schTo, setSchTo] = useState("");
  const [schFile, setSchFile] = useState<{ name: string; base64: string } | null>(null);
  const [schBusy, setSchBusy] = useState(false);
  const [schMsg, setSchMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const pickSchedule = (file: File | undefined) => {
    if (!file) {
      setSchFile(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () =>
      setSchFile({ name: file.name, base64: String(reader.result).split(",")[1] ?? "" });
    reader.readAsDataURL(file);
  };

  const uploadSchedule = async () => {
    if (!schName || !schProvider || !schFrom || !schFile) {
      setSchMsg({ kind: "error", text: "Name, provider, effective-from date and a PDF are required." });
      return;
    }
    setSchBusy(true);
    setSchMsg(null);
    try {
      const res = await client.admin.tariffSchedulesCreate({
        name: schName,
        provider: schProvider,
        effectiveFrom: new Date(schFrom),
        effectiveTo: schTo ? new Date(schTo) : undefined,
        filename: schFile.name,
        contentBase64: schFile.base64,
      });
      setSchMsg({
        kind: "success",
        text: `Uploaded "${res.name}" — ${
          res.textExtracted
            ? `${res.textChars.toLocaleString()} characters extracted`
            : "no text layer found (scanned PDF?)"
        }.`,
      });
      setSchName("");
      setSchProvider("");
      setSchFrom("");
      setSchTo("");
      setSchFile(null);
      refetchSched();
    } catch (err) {
      setSchMsg({ kind: "error", text: err instanceof Error ? err.message : "Upload failed" });
    } finally {
      setSchBusy(false);
    }
  };

  const deleteSchedule = async (id: string) => {
    try {
      await client.admin.tariffSchedulesDelete({ scheduleId: id });
      refetchSched();
    } catch (err) {
      setSchMsg({ kind: "error", text: err instanceof Error ? err.message : "Delete failed" });
    }
  };

  const sendOutcome = async (status: "reviewed" | "flagged") => {
    if (!respondTo) return;
    if (!outSubject.trim() || !outBody.trim()) {
      setQueueMsg({ kind: "error", text: "Add a subject and a description before sending." });
      return;
    }
    setReviewBusy(true);
    setQueueMsg(null);
    try {
      await client.admin.reviewReconciliation({
        reconId: respondTo.reconId,
        status,
        subject: outSubject,
        body: outBody,
        attachmentBase64: outFile?.base64,
        attachmentName: outFile?.name,
      });
      setQueueMsg({
        kind: "success",
        text:
          status === "reviewed"
            ? "Sent — verified, and the customer's sealed PDF is unlocked."
            : "Sent — flagged back to the customer with your notes.",
      });
      setRespondTo(null);
      refetchQueue();
    } catch (err) {
      setQueueMsg({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to send the outcome.",
      });
    } finally {
      setReviewBusy(false);
    }
  };

  const randFmt = (cents: number) =>
    `R ${(cents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // listOrganizations is operator-gated; a non-operator gets FORBIDDEN.
  if (error) {
    return (
      <Stack maxWidth={720}>
        <EmptyState
          icon={<Building2 size={28} />}
          title="Operators only"
          description="This area is for Sparks platform operators. If you reached it by mistake, head back to your dashboard."
          actions={<Button label="Go to dashboard" variant="secondary" href="/dashboard" />}
        />
      </Stack>
    );
  }

  const submitCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    setCustMsg(null);
    if (!cName || !cEmail || !orgName) {
      setCustMsg({ kind: "error", text: "Fill in the customer name, email and organization." });
      return;
    }
    setCustBusy(true);
    try {
      await client.admin.createCustomer({
        customerName: cName,
        customerEmail: cEmail,
        organizationName: orgName,
      });
      setCustMsg({
        kind: "success",
        text: `Account created for ${cEmail}. A set-password email has been sent.`,
      });
      setCName("");
      setCEmail("");
      setOrgName("");
      refetch();
    } catch (err) {
      setCustMsg({ kind: "error", text: err instanceof Error ? err.message : "Failed to create account." });
    } finally {
      setCustBusy(false);
    }
  };

  const submitSite = async (e: React.FormEvent) => {
    e.preventDefault();
    setSiteMsg(null);
    if (!siteOrgId || !siteName) {
      setSiteMsg({ kind: "error", text: "Pick an organization and enter a site name." });
      return;
    }
    setSiteBusy(true);
    try {
      await client.sites.create({
        organizationId: siteOrgId,
        name: siteName,
        addressLine1: siteAddr || undefined,
        city: siteCity || undefined,
        province: siteProvince || undefined,
      });
      setSiteMsg({ kind: "success", text: `Site "${siteName}" added.` });
      setSiteName("");
      setSiteAddr("");
      setSiteCity("");
      setSiteProvince("");
      refetch();
    } catch (err) {
      setSiteMsg({ kind: "error", text: err instanceof Error ? err.message : "Failed to add site." });
    } finally {
      setSiteBusy(false);
    }
  };

  return (
    <Stack gap={6}>
      <Stack gap={1}>
        <Heading level={2}>Operator admin</Heading>
        <Text type="supporting">Provision customer accounts and the sites under each organization.</Text>
      </Stack>

      <Grid columns={{ minWidth: 420, repeat: "fit" }} gap={6}>
        {/* Provision a customer */}
        <Card padding={5}>
          <form onSubmit={submitCustomer}>
            <Stack gap={4}>
              <Stack direction="horizontal" gap={2} align="center">
                <span style={{ display: "inline-flex", color: PRIMARY }}><UserPlus size={16} /></span>
                <Text weight="semibold">Provision a customer</Text>
              </Stack>
              {custMsg ? <Banner status={custMsg.kind} title={custMsg.text} /> : null}
              <TextInput label="Contact name" value={cName} onChange={setCName} isDisabled={custBusy} width="100%" />
              <TextInput label="Contact email" type="email" value={cEmail} onChange={setCEmail} isDisabled={custBusy} width="100%" />
              <TextInput label="Organization name" value={orgName} onChange={setOrgName} isDisabled={custBusy} width="100%" />
              <div style={{ display: "grid" }}>
                <Button label={custBusy ? "Creating…" : "Create account & send invite"} type="submit" variant="primary" isLoading={custBusy} />
              </div>
            </Stack>
          </form>
        </Card>

        {/* Add a site to an org */}
        <Card padding={5}>
          <form onSubmit={submitSite}>
            <Stack gap={4}>
              <Stack direction="horizontal" gap={2} align="center">
                <span style={{ display: "inline-flex", color: PRIMARY }}><MapPin size={16} /></span>
                <Text weight="semibold">Add a site to an organization</Text>
              </Stack>
              {siteMsg ? <Banner status={siteMsg.kind} title={siteMsg.text} /> : null}
              <Selector
                label="Organization"
                placeholder="Select an organization…"
                options={organizations.map((o) => ({ value: o.id, label: o.name }))}
                value={siteOrgId}
                onChange={setSiteOrgId}
              />
              <TextInput label="Site name" value={siteName} onChange={setSiteName} isDisabled={siteBusy} width="100%" />
              <TextInput label="Address line 1" value={siteAddr} onChange={setSiteAddr} isDisabled={siteBusy} width="100%" />
              <Grid columns={2} gap={3}>
                <TextInput label="City" value={siteCity} onChange={setSiteCity} isDisabled={siteBusy} width="100%" />
                <TextInput label="Province" value={siteProvince} onChange={setSiteProvince} isDisabled={siteBusy} width="100%" />
              </Grid>
              <div style={{ display: "grid" }}>
                <Button label={siteBusy ? "Adding…" : "Add site"} type="submit" variant="primary" isLoading={siteBusy} />
              </div>
            </Stack>
          </form>
        </Card>
      </Grid>

      {/* Sparks QA queue */}
      <Card padding={5}>
        <Stack gap={3}>
          <Stack direction="horizontal" gap={2} align="center">
            <span style={{ display: "inline-flex", color: PRIMARY }}>
              <ClipboardCheck size={16} />
            </span>
            <Text weight="semibold">Reconciliation QA queue</Text>
            {queue.length > 0 ? <Badge variant="warning" label={`${queue.length} pending`} /> : null}
          </Stack>
          <Text type="supporting">
            Every reconciliation lands here as provisional. Verify to unlock the customer's sealed
            dispute PDF, or flag it back for a fix. Customer-requested reviews are shown first.
          </Text>
          {queueMsg ? <Banner status={queueMsg.kind} title={queueMsg.text} /> : null}
          {queueLoading ? (
            <Stack gap={2}>
              <Skeleton height={40} />
              <Skeleton height={40} />
            </Stack>
          ) : queue.length === 0 ? (
            <Text type="supporting">Nothing awaiting review. 🎉</Text>
          ) : (
            <Table
              data={queue}
              columns={[
                {
                  key: "site",
                  header: "Site / org",
                  renderCell: (q) => (
                    <Stack gap={0}>
                      <Text weight="medium">{q.siteName ?? "—"}</Text>
                      <Text type="supporting">{q.organizationName ?? "—"}</Text>
                    </Stack>
                  ),
                },
                {
                  key: "period",
                  header: "Period",
                  renderCell: (q) => (
                    <Text type="supporting">
                      {new Date(q.billingPeriodStart).toLocaleDateString()} –{" "}
                      {new Date(q.billingPeriodEnd).toLocaleDateString()}
                    </Text>
                  ),
                },
                {
                  key: "discrepancy",
                  header: "Discrepancy",
                  renderCell: (q) => {
                    const d = q.discrepancyVsLandlordCents ?? 0;
                    return (
                      <Text
                        weight="medium"
                        // biome-ignore lint/style/useNamingConvention: inline color
                      >
                        <span style={{ color: d > 0 ? "hsl(0 72% 45%)" : "hsl(142 71% 35%)" }}>
                          {d > 0 ? "+" : ""}
                          {randFmt(d)}
                        </span>
                      </Text>
                    );
                  },
                },
                {
                  key: "flags",
                  header: "Flags",
                  renderCell: (q) => (
                    <Stack direction="horizontal" gap={1} wrap="wrap">
                      {q.reviewRequestedAt ? <Badge variant="warning" label="Customer asked" /> : null}
                      {q.reviewStatus === "flagged" ? <Badge variant="warning" label="Flagged" /> : null}
                      {q.dataIntegrityStatus === "gaps_present" ? (
                        <Badge label="Data gaps" />
                      ) : null}
                    </Stack>
                  ),
                },
                {
                  key: "actions",
                  header: "",
                  renderCell: (q) => (
                    <Stack direction="horizontal" gap={2} wrap="wrap" align="center">
                      <Button
                        label="Open"
                        variant="ghost"
                        icon={<ExternalLink size={14} />}
                        href={`/sites/${q.siteId}/reconciliation/${q.reconId}`}
                      />
                      <Button
                        label="Review & respond"
                        variant="primary"
                        onClick={() => openRespond(q.reconId, q.siteName ?? "the site")}
                      />
                    </Stack>
                  ),
                },
              ]}
              density="compact"
              dividers="rows"
            />
          )}

          {/* Compose the outcome that goes back to the customer. */}
          {respondTo ? (
            <Card padding={5}>
              <Stack gap={4}>
                <Stack direction="horizontal" gap={2} align="center">
                  <span style={{ display: "inline-flex", color: PRIMARY }}>
                    <Send size={16} />
                  </span>
                  <Text weight="semibold">Send review outcome — {respondTo.siteName}</Text>
                </Stack>
                <Text type="supporting">
                  Write the description that goes to the customer's Alerts inbox and email. Attach a
                  document if you prepared one. "Verified" unlocks their sealed dispute PDF.
                </Text>
                <TextInput
                  label="Subject"
                  value={outSubject}
                  onChange={setOutSubject}
                  isDisabled={reviewBusy}
                  width="100%"
                />
                <Stack gap={1}>
                  <Text type="supporting">Description / findings</Text>
                  <textarea
                    value={outBody}
                    onChange={(e) => setOutBody(e.target.value)}
                    rows={6}
                    disabled={reviewBusy}
                    placeholder="What you found, whether the charges hold up, and what happens next…"
                    style={{
                      width: "100%",
                      padding: "10px 12px",
                      border: "1px solid hsl(210 16% 82%)",
                      borderRadius: 8,
                      font: "inherit",
                      resize: "vertical",
                    }}
                  />
                </Stack>
                <Stack gap={1}>
                  <Text type="supporting">Attach a document (optional, PDF)</Text>
                  <input
                    type="file"
                    accept="application/pdf"
                    disabled={reviewBusy}
                    onChange={(e) => pickFile(e.target.files?.[0])}
                  />
                </Stack>
                <Stack direction="horizontal" gap={3} wrap="wrap">
                  <Button
                    label={reviewBusy ? "Sending…" : "Send as Verified"}
                    variant="primary"
                    isLoading={reviewBusy}
                    onClick={() => sendOutcome("reviewed")}
                  />
                  <Button
                    label="Send as Flagged"
                    variant="secondary"
                    isDisabled={reviewBusy}
                    onClick={() => sendOutcome("flagged")}
                  />
                  <Button
                    label="Cancel"
                    variant="ghost"
                    isDisabled={reviewBusy}
                    onClick={() => setRespondTo(null)}
                  />
                </Stack>
              </Stack>
            </Card>
          ) : null}
        </Stack>
      </Card>

      {/* Reference tariff schedules */}
      <Card padding={5}>
        <Stack gap={4}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: PRIMARY, display: "inline-flex" }}>
              <ScrollText size={16} />
            </span>
            <Text weight="semibold">Reference tariff schedules</Text>
          </span>
          <Text type="supporting">
            Upload a provider's published prices (e.g. Eskom's Schedule of Standard Prices). When a
            customer sends a bill for review, the AI cross-references any charge that only names a
            tariff against the matching schedule and includes the rate check in the review email.
          </Text>
          {schMsg ? <Banner status={schMsg.kind} title={schMsg.text} /> : null}
          <Stack direction="horizontal" gap={3} align="end" wrap="wrap">
            <TextInput label="Schedule name" value={schName} onChange={setSchName} width={220} />
            <TextInput
              label="Provider"
              description="e.g. Eskom, City of Johannesburg"
              value={schProvider}
              onChange={setSchProvider}
              width={200}
            />
            <Stack gap={1}>
              <Text type="supporting">Effective from</Text>
              <input type="date" value={schFrom} onChange={(e) => setSchFrom(e.target.value)} />
            </Stack>
            <Stack gap={1}>
              <Text type="supporting">Effective to (optional)</Text>
              <input type="date" value={schTo} onChange={(e) => setSchTo(e.target.value)} />
            </Stack>
            <Stack gap={1}>
              <Text type="supporting">Schedule PDF</Text>
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => pickSchedule(e.target.files?.[0])}
              />
            </Stack>
            <Button
              label={schBusy ? "Uploading…" : "Upload schedule"}
              variant="primary"
              icon={<Upload size={16} />}
              isLoading={schBusy}
              onClick={uploadSchedule}
            />
          </Stack>

          {schedules.length === 0 ? (
            <Text type="supporting">No reference schedules uploaded yet.</Text>
          ) : (
            <Table
              data={schedules}
              columns={[
                {
                  key: "name",
                  header: "Schedule",
                  renderCell: (s) => <Text weight="medium">{s.name}</Text>,
                },
                {
                  key: "provider",
                  header: "Provider",
                  renderCell: (s) => <Badge label={s.provider} />,
                },
                {
                  key: "effective",
                  header: "Effective",
                  renderCell: (s) => (
                    <Text type="supporting">
                      {new Date(s.effectiveFrom).toLocaleDateString()}
                      {s.effectiveTo ? ` – ${new Date(s.effectiveTo).toLocaleDateString()}` : " →"}
                    </Text>
                  ),
                },
                {
                  key: "text",
                  header: "Rates text",
                  renderCell: (s) =>
                    s.textLength > 0 ? (
                      <Text type="supporting">{s.textLength.toLocaleString()} chars</Text>
                    ) : (
                      <Badge variant="warning" label="no text" />
                    ),
                },
                {
                  key: "action",
                  header: "",
                  renderCell: (s) => (
                    <Button
                      label="Remove"
                      variant="ghost"
                      size="sm"
                      icon={<Trash2 size={14} />}
                      onClick={() => deleteSchedule(s.id)}
                    />
                  ),
                },
              ]}
              density="compact"
              dividers="rows"
            />
          )}
        </Stack>
      </Card>

      {/* Organizations overview */}
      <Card padding={5}>
        <Stack gap={3}>
          <Text weight="semibold">Organizations</Text>
          {loading ? (
            <Stack gap={2}>
              <Skeleton height={40} />
              <Skeleton height={40} />
            </Stack>
          ) : organizations.length === 0 ? (
            <Text type="supporting">No organizations yet. Provision a customer above.</Text>
          ) : (
            <Table
              data={organizations}
              columns={[
                { key: "name", header: "Organization", renderCell: (o) => <Text weight="medium">{o.name}</Text> },
                { key: "ownerEmail", header: "Owner", renderCell: (o) => <Text type="supporting">{o.ownerEmail ?? "—"}</Text> },
                { key: "siteCount", header: "Sites", renderCell: (o) => <Badge label={String(o.siteCount)} /> },
              ]}
              density="compact"
              dividers="rows"
            />
          )}
        </Stack>
      </Card>
    </Stack>
  );
}
