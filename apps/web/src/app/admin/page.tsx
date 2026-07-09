"use client";

import { useEffect, useState } from "react";
import {
  Building2,
  UserPlus,
  MapPin,
  ClipboardCheck,
  Send,
  ScrollText,
  Trash2,
  Upload,
  Coins,
  History,
  Search,
  ChevronDown,
  ChevronRight,
  Cpu,
  Plus,
  Copy,
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

  // The unified work queue — every submitted bill still awaiting an operator response.
  const {
    data: queueData,
    loading: queueLoading,
    refetch: refetchQueue,
  } = useRPC(() => client.admin.listReviewQueue(), []);

  // Reviewed history — bills already responded to. Searchable + paginated (it grows
  // without bound). The search box is debounced so we don't fire a call per keystroke.
  const REVIEWED_LIMIT = 25;
  const [reviewedSearch, setReviewedSearch] = useState("");
  const [reviewedQuery, setReviewedQuery] = useState("");
  const [reviewedOffset, setReviewedOffset] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => {
      setReviewedQuery(reviewedSearch.trim());
      setReviewedOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [reviewedSearch]);
  const {
    data: reviewedData,
    loading: reviewedLoading,
    refetch: refetchReviewed,
  } = useRPC(
    () =>
      client.admin.listReviewedBills({
        query: reviewedQuery || undefined,
        limit: REVIEWED_LIMIT,
        offset: reviewedOffset,
      }),
    [reviewedQuery, reviewedOffset],
  );
  const reviewed = reviewedData?.reviewed ?? [];
  const reviewedTotal = reviewedData?.total ?? 0;

  // Provisioning/setup forms live behind a toggle so the work queue stays front-and-centre.
  const [showProvisioning, setShowProvisioning] = useState(false);

  // Org/site decommissioning (subscription ended). manageOrg opens the panel that lists
  // the org's sites + the delete-organization flow.
  const [manageOrg, setManageOrg] = useState<{ id: string; name: string } | null>(null);
  const [orgDeleteConfirm, setOrgDeleteConfirm] = useState("");
  const [orgActionBusy, setOrgActionBusy] = useState(false);
  const [orgActionMsg, setOrgActionMsg] = useState<{ kind: "success" | "error"; text: string } | null>(
    null,
  );
  const {
    data: orgSitesData,
    loading: orgSitesLoading,
    refetch: refetchOrgSites,
  } = useRPC(
    manageOrg ? () => client.admin.listOrgSites({ organizationId: manageOrg.id }) : null,
    [manageOrg?.id],
  );
  const orgSites = orgSitesData?.sites ?? [];

  // Hardware provisioning for a chosen site (device → meter → mint the JWT offline).
  const [manageSite, setManageSite] = useState<{ id: string; name: string } | null>(null);
  const {
    data: hardwareData,
    loading: hardwareLoading,
    refetch: refetchHardware,
  } = useRPC(
    manageSite ? () => client.admin.listSiteHardware({ siteId: manageSite.id }) : null,
    [manageSite?.id],
  );
  const hardwareDevices = hardwareData?.devices ?? [];
  const [devSerial, setDevSerial] = useState("");
  const [devModel, setDevModel] = useState("rpi");
  const [addMeterFor, setAddMeterFor] = useState<string | null>(null);
  const [meterSerial, setMeterSerial] = useState("");
  const [hwBusy, setHwBusy] = useState(false);
  const [hwMsg, setHwMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [copiedMeter, setCopiedMeter] = useState<string | null>(null);

  const [reviewBusy, setReviewBusy] = useState(false);
  const [queueMsg, setQueueMsg] = useState<{ kind: "success" | "error"; text: string } | null>(
    null,
  );
  // The recon the operator is composing an outcome for (null = queue view).
  const [respondTo, setRespondTo] = useState<{ reconId: string; siteName: string } | null>(null);
  const [outSubject, setOutSubject] = useState("");
  const [outBody, setOutBody] = useState("");
  // Zero or more PDF documents to attach to the outcome.
  const [outFiles, setOutFiles] = useState<{ name: string; base64: string }[]>([]);

  // The site the operator is assigning a landlord tariff to (null = closed). Carries the
  // bill's billing period so the pending reconciliation can be recomputed on assign.
  const [assignTo, setAssignTo] = useState<{
    siteId: string;
    siteName: string;
    billingPeriodId: string | null;
    periodStart: string | null;
  } | null>(null);
  const [assignName, setAssignName] = useState("Landlord tariff");
  const [assignEffFrom, setAssignEffFrom] = useState("");
  // The common landlord charge types, each an optional decimal rate. Blank = not charged.
  const [assignRates, setAssignRates] = useState({
    active: "",
    demand: "",
    fixed: "",
    reactive: "",
  });
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignMsg, setAssignMsg] = useState<{ kind: "success" | "error"; text: string } | null>(
    null,
  );

  const organizations = orgData?.organizations ?? [];
  const queue = queueData?.queue ?? [];

  const openRespond = (reconId: string, siteName: string) => {
    setRespondTo({ reconId, siteName });
    setOutSubject("Your bill review is complete");
    setOutBody("");
    setOutFiles([]);
    setQueueMsg(null);
  };

  const pickFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = String(reader.result).split(",")[1] ?? "";
        setOutFiles((cur) => [...cur, { name: file.name, base64 }]);
      };
      reader.readAsDataURL(file);
    }
  };

  const removeOutFile = (idx: number) => setOutFiles((cur) => cur.filter((_, i) => i !== idx));

  // Reference tariff schedules (Eskom / municipal published prices).
  const { data: schedData, refetch: refetchSched } = useRPC(
    () => client.admin.tariffSchedulesList(),
    [],
  );
  const schedules = schedData?.schedules ?? [];
  // Poll while any schedule is still extracting so its status flips to ready live.
  const anyExtracting = schedules.some((s) => s.extractionStatus === "pending");
  useEffect(() => {
    if (!anyExtracting) return;
    const id = setInterval(() => refetchSched(), 3000);
    return () => clearInterval(id);
  }, [anyExtracting, refetchSched]);
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
        text: `Uploaded "${res.name}" — extracting rates with ${res.engine}. It'll show as ready below in a minute or two.`,
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
        attachments: outFiles.length > 0 ? outFiles : undefined,
      });
      setQueueMsg({
        kind: "success",
        text:
          status === "reviewed"
            ? "Sent — reconciliation confirmed; the customer can download their sealed report."
            : "Sent — closed with no reconciliation; no report was generated.",
      });
      setRespondTo(null);
      refetchQueue();
      refetchReviewed();
    } catch (err) {
      setQueueMsg({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to send the outcome.",
      });
    } finally {
      setReviewBusy(false);
    }
  };

  const openAssign = async (target: {
    siteId: string;
    siteName: string;
    billingPeriodId: string | null;
    periodStart: string | null;
  }) => {
    setAssignTo(target);
    setAssignMsg(null);
    setAssignBusy(false);
    setAssignName("Landlord tariff");
    // Default the effective-from date to the bill's period start so the assignment covers
    // the (often historical) period being priced — otherwise the recompute stays pending.
    setAssignEffFrom(target.periodStart ? new Date(target.periodStart).toISOString().slice(0, 10) : "");
    setAssignRates({ active: "", demand: "", fixed: "", reactive: "" });
    // Prefill from any landlord tariff already on file, so re-assigning starts from the
    // current rates instead of a blank form.
    try {
      const cur = await client.admin.siteTariffGet({ siteId: target.siteId });
      if (cur.rates.length > 0) {
        const find = (ct: string) => {
          const r = cur.rates.find((x) => x.chargeType === ct);
          return r ? String(Number(r.rateValue)) : "";
        };
        setAssignRates({
          active: find("active_energy"),
          demand: find("demand"),
          fixed: find("fixed"),
          reactive: find("reactive_energy"),
        });
        if (cur.profile?.name) setAssignName(cur.profile.name);
      }
    } catch {
      // Best-effort prefill; a blank form is still fine.
    }
  };

  const submitAssign = async () => {
    if (!assignTo) return;
    if (!assignEffFrom) {
      setAssignMsg({ kind: "error", text: "Pick the date the tariff takes effect from." });
      return;
    }
    const decimal = /^\d+(\.\d{1,6})?$/;
    const rates: Array<{ chargeType: string; unit: string; rateValue: string }> = [];
    const add = (raw: string, chargeType: string, unit: string): boolean => {
      const v = raw.trim();
      if (!v) return true;
      if (!decimal.test(v)) {
        setAssignMsg({ kind: "error", text: `"${v}" isn't a valid rate — use a number like 2.20.` });
        return false;
      }
      rates.push({ chargeType, unit, rateValue: v });
      return true;
    };
    if (!add(assignRates.active, "active_energy", "c_per_kwh")) return;
    if (!add(assignRates.demand, "demand", "r_per_kva")) return;
    if (!add(assignRates.fixed, "fixed", "r_per_month")) return;
    if (!add(assignRates.reactive, "reactive_energy", "c_per_kvarh")) return;
    if (rates.length === 0) {
      setAssignMsg({ kind: "error", text: "Enter at least one rate for the landlord tariff." });
      return;
    }
    setAssignBusy(true);
    setAssignMsg(null);
    try {
      const res = await client.admin.assignSiteTariff({
        siteId: assignTo.siteId,
        name: assignName.trim() || "Landlord tariff",
        effectiveFrom: new Date(assignEffFrom),
        rates: rates as Parameters<typeof client.admin.assignSiteTariff>[0]["rates"],
        regenerateBillingPeriodId: assignTo.billingPeriodId ?? undefined,
      });
      setAssignTo(null);
      setQueueMsg(
        res.regenerateError
          ? {
              kind: "error",
              text: `Tariff assigned to ${assignTo.siteName}, but recomputing the reconciliation failed: ${res.regenerateError}`,
            }
          : {
              kind: "success",
              text: res.regenerated
                ? `Landlord tariff assigned to ${assignTo.siteName} and the reconciliation recomputed — the expected side is filled in.`
                : `Landlord tariff assigned to ${assignTo.siteName}.`,
            },
      );
      refetchQueue();
      refetchReviewed();
    } catch (err) {
      setAssignMsg({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to assign the tariff.",
      });
    } finally {
      setAssignBusy(false);
    }
  };

  const randFmt = (cents: number) =>
    `R ${(cents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // listOrganizations is operator-gated; a non-operator gets FORBIDDEN.
  // Heading pinned top-left (matches Sites/Alerts); the denial itself is
  // centered in the remaining space rather than left-aligned under it.
  if (error) {
    return (
      <Stack gap={6} height="100%">
        <Heading level={2}>Operator admin</Heading>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: "100%", maxWidth: 440 }}>
            <EmptyState
              icon={<Building2 size={28} />}
              title="Operators only"
              description="This area is for Sparks platform operators. If you reached it by mistake, head back to your dashboard."
              actions={<Button label="Go to dashboard" variant="secondary" href="/dashboard" />}
            />
          </div>
        </div>
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

  const openManage = (id: string, name: string) => {
    setManageOrg({ id, name });
    setOrgDeleteConfirm("");
    setOrgActionMsg(null);
  };

  const deleteOneSite = async (siteId: string, name: string) => {
    if (!window.confirm(`Delete site "${name}" and all its meters, readings and bills? This can't be undone.`))
      return;
    setOrgActionBusy(true);
    setOrgActionMsg(null);
    try {
      await client.sites.delete({ siteId });
      setOrgActionMsg({ kind: "success", text: `Site "${name}" deleted.` });
      refetchOrgSites();
      refetch();
    } catch (err) {
      setOrgActionMsg({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to delete site.",
      });
    } finally {
      setOrgActionBusy(false);
    }
  };

  const deleteOrg = async () => {
    if (!manageOrg) return;
    if (orgDeleteConfirm.trim() !== manageOrg.name) {
      setOrgActionMsg({ kind: "error", text: "Type the organization name exactly to confirm." });
      return;
    }
    setOrgActionBusy(true);
    setOrgActionMsg(null);
    try {
      const res = await client.admin.deleteOrganization({
        organizationId: manageOrg.id,
        confirmName: orgDeleteConfirm.trim(),
      });
      const deletedName = manageOrg.name;
      setManageOrg(null);
      setOrgDeleteConfirm("");
      setCustMsg({
        kind: "success",
        text: `Deleted "${deletedName}" and its ${res.siteCount} site(s).`,
      });
      refetch();
    } catch (err) {
      setOrgActionMsg({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to delete organization.",
      });
    } finally {
      setOrgActionBusy(false);
    }
  };

  const openHardware = (id: string, name: string) => {
    setManageSite((cur) => (cur?.id === id ? null : { id, name }));
    setDevSerial("");
    setDevModel("rpi");
    setAddMeterFor(null);
    setMeterSerial("");
    setHwMsg(null);
  };

  const provisionDevice = async () => {
    if (!manageSite || !devSerial.trim()) {
      setHwMsg({ kind: "error", text: "Enter a device serial number." });
      return;
    }
    setHwBusy(true);
    setHwMsg(null);
    try {
      await client.admin.provisionDevice({
        siteId: manageSite.id,
        serialNumber: devSerial.trim(),
        hardwareModel: devModel.trim() || "rpi",
      });
      setHwMsg({ kind: "success", text: `Device "${devSerial.trim()}" added. Now add a meter to it.` });
      setDevSerial("");
      refetchHardware();
    } catch (err) {
      setHwMsg({ kind: "error", text: err instanceof Error ? err.message : "Failed to add device." });
    } finally {
      setHwBusy(false);
    }
  };

  const provisionMeter = async (deviceId: string) => {
    if (!meterSerial.trim()) {
      setHwMsg({ kind: "error", text: "Enter a meter serial number." });
      return;
    }
    setHwBusy(true);
    setHwMsg(null);
    try {
      const res = await client.admin.provisionMeter({
        deviceId,
        serialNumber: meterSerial.trim(),
      });
      setHwMsg({
        kind: "success",
        text: `Meter added (meterId ${res.meterId}). Mint its JWT offline and flash it onto the Pi.`,
      });
      setAddMeterFor(null);
      setMeterSerial("");
      refetchHardware();
    } catch (err) {
      setHwMsg({ kind: "error", text: err instanceof Error ? err.message : "Failed to add meter." });
    } finally {
      setHwBusy(false);
    }
  };

  const removeDevice = async (deviceId: string, serial: string) => {
    if (!window.confirm(`Delete device "${serial}" and all its meters + readings? This can't be undone.`))
      return;
    setHwBusy(true);
    try {
      await client.admin.deleteDevice({ deviceId });
      refetchHardware();
    } catch (err) {
      setHwMsg({ kind: "error", text: err instanceof Error ? err.message : "Failed to delete device." });
    } finally {
      setHwBusy(false);
    }
  };

  const removeMeter = async (meterId: string, serial: string) => {
    if (!window.confirm(`Delete meter "${serial}" and its readings? This can't be undone.`)) return;
    setHwBusy(true);
    try {
      await client.admin.deleteMeter({ meterId });
      refetchHardware();
    } catch (err) {
      setHwMsg({ kind: "error", text: err instanceof Error ? err.message : "Failed to delete meter." });
    } finally {
      setHwBusy(false);
    }
  };

  const copyMintCommand = (meterId: string) => {
    const cmd = `bun scripts/mint-device-jwt.ts ${meterId} --key device-signing.private.pem`;
    navigator.clipboard?.writeText(cmd).then(
      () => {
        setCopiedMeter(meterId);
        setTimeout(() => setCopiedMeter(null), 2000);
      },
      () => setHwMsg({ kind: "error", text: "Couldn't copy — command is in the meter row." }),
    );
  };

  return (
    <Stack gap={6}>
      <Stack gap={1}>
        <Heading level={2}>Operator admin</Heading>
        <Text type="supporting">
          Review the bills customers send to Sparks, then track the ones you've finished.
        </Text>
      </Stack>

      {/* Assign a landlord tariff to a site (fills a pending reconciliation's expected side) */}
      {assignTo ? (
        <Card padding={5}>
          <Stack gap={4}>
            <Stack direction="horizontal" gap={2} align="center">
              <span style={{ display: "inline-flex", color: PRIMARY }}>
                <Coins size={16} />
              </span>
              <Text weight="semibold">Assign landlord tariff — {assignTo.siteName}</Text>
            </Stack>
            <Text type="supporting">
              Enter the landlord's stated rates. On save this becomes the site's landlord tariff
              {assignTo.billingPeriodId
                ? " and the bill's reconciliation is recomputed, filling in the pending “expected” side."
                : "."}{" "}
              Leave a charge blank if it doesn't apply.
            </Text>
            {assignMsg ? <Banner status={assignMsg.kind} title={assignMsg.text} /> : null}
            <Grid columns={{ minWidth: 200, repeat: "fit" }} gap={3}>
              <TextInput
                label="Active energy (c/kWh)"
                value={assignRates.active}
                onChange={(v) => setAssignRates((r) => ({ ...r, active: v }))}
                isDisabled={assignBusy}
                width="100%"
              />
              <TextInput
                label="Demand (R/kVA)"
                value={assignRates.demand}
                onChange={(v) => setAssignRates((r) => ({ ...r, demand: v }))}
                isDisabled={assignBusy}
                width="100%"
              />
              <TextInput
                label="Fixed / service (R/month)"
                value={assignRates.fixed}
                onChange={(v) => setAssignRates((r) => ({ ...r, fixed: v }))}
                isDisabled={assignBusy}
                width="100%"
              />
              <TextInput
                label="Reactive energy (c/kVArh)"
                value={assignRates.reactive}
                onChange={(v) => setAssignRates((r) => ({ ...r, reactive: v }))}
                isDisabled={assignBusy}
                width="100%"
              />
            </Grid>
            <Grid columns={{ minWidth: 200, repeat: "fit" }} gap={3}>
              <TextInput
                label="Tariff name"
                value={assignName}
                onChange={setAssignName}
                isDisabled={assignBusy}
                width="100%"
              />
              <Stack gap={1}>
                <Text type="supporting">Effective from</Text>
                <input
                  type="date"
                  value={assignEffFrom}
                  disabled={assignBusy}
                  onChange={(e) => setAssignEffFrom(e.target.value)}
                />
              </Stack>
            </Grid>
            <Stack direction="horizontal" gap={3} wrap="wrap">
              <Button
                label={assignBusy ? "Assigning…" : "Assign tariff & recompute"}
                variant="primary"
                isLoading={assignBusy}
                onClick={submitAssign}
              />
              <Button
                label="Cancel"
                variant="ghost"
                isDisabled={assignBusy}
                onClick={() => setAssignTo(null)}
              />
            </Stack>
          </Stack>
        </Card>
      ) : null}

      {/* Unified work queue — everything awaiting an operator response */}
      <Card padding={5}>
        <Stack gap={3}>
          <Stack direction="horizontal" gap={2} align="center">
            <span style={{ display: "inline-flex", color: PRIMARY }}>
              <ClipboardCheck size={16} />
            </span>
            <Text weight="semibold">Needs review</Text>
            {queue.length > 0 ? <Badge variant="warning" label={`${queue.length}`} /> : null}
          </Stack>
          <Text type="supporting">
            Bills customers have sent to Sparks, waiting on you. Assign a landlord tariff where the
            expected side is still pending, then review &amp; respond — verify to unlock the
            customer's sealed dispute PDF, or send it back for a fix. Responded bills move to Reviewed.
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
                  key: "who",
                  header: "Submitted by",
                  renderCell: (q) => (
                    <Stack gap={0}>
                      <Text weight="medium">{q.customerEmail ?? "Customer"}</Text>
                      <Text type="supporting">{q.organizationName ?? "—"}</Text>
                    </Stack>
                  ),
                },
                {
                  key: "site",
                  header: "Site / period",
                  renderCell: (q) => (
                    <Stack gap={0}>
                      <Text>{q.siteName ?? "Site"}</Text>
                      <Text type="supporting">
                        {new Date(q.billingPeriodStart).toLocaleDateString()} –{" "}
                        {new Date(q.billingPeriodEnd).toLocaleDateString()}
                      </Text>
                    </Stack>
                  ),
                },
                {
                  key: "billed",
                  header: "Billed",
                  renderCell: (q) => <Text weight="medium">{randFmt(q.chargedTotalCents)}</Text>,
                },
                {
                  key: "status",
                  header: "Discrepancy",
                  renderCell: (q) => {
                    // No landlord tariff yet ⇒ the expected side is undetermined. Show a
                    // clear status rather than a misleading R 0.00.
                    if (q.state === "needs_tariff") {
                      return <Badge variant="warning" label="Needs tariff" />;
                    }
                    if (q.expectedLandlordCents == null) {
                      return <Badge variant="warning" label="Expected: pending" />;
                    }
                    const d = q.discrepancyVsLandlordCents ?? 0;
                    return (
                      <Text weight="medium">
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
                    <Stack direction="horizontal" gap={2} wrap="wrap">
                      {q.expectedLandlordCents == null ? (
                        <Button
                          label="Assign tariff"
                          variant={q.reconId ? "secondary" : "primary"}
                          size="sm"
                          icon={<Coins size={14} />}
                          onClick={() =>
                            openAssign({
                              siteId: q.siteId,
                              siteName: q.siteName ?? "the site",
                              billingPeriodId: q.billingPeriodId ?? null,
                              periodStart: q.billingPeriodStart
                                ? new Date(q.billingPeriodStart).toISOString()
                                : null,
                            })
                          }
                        />
                      ) : null}
                      {q.reconId ? (
                        <Button
                          label="Review & respond"
                          variant="primary"
                          size="sm"
                          onClick={() => openRespond(q.reconId as string, q.siteName ?? "the site")}
                        />
                      ) : null}
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
                  Write the description that goes to the customer's Alerts inbox and email, and
                  attach a document if you prepared one. Choose the outcome:{" "}
                  <strong>Reconciliation found</strong> releases their sealed dispute report to
                  download; <strong>No reconciliation</strong> closes the review with no report.
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
                  <Text type="supporting">Attach documents (optional, PDF — you can add several)</Text>
                  <input
                    type="file"
                    accept="application/pdf"
                    multiple
                    disabled={reviewBusy}
                    onChange={(e) => {
                      pickFiles(e.target.files);
                      e.target.value = ""; // allow re-picking the same file / adding more
                    }}
                  />
                  {outFiles.length > 0 ? (
                    <Stack gap={1}>
                      {outFiles.map((f, i) => (
                        <Stack key={`${f.name}-${i}`} direction="horizontal" gap={2} align="center">
                          <Text type="supporting">{f.name}</Text>
                          <Button
                            label="Remove"
                            variant="ghost"
                            size="sm"
                            isDisabled={reviewBusy}
                            onClick={() => removeOutFile(i)}
                          />
                        </Stack>
                      ))}
                    </Stack>
                  ) : null}
                </Stack>
                <Stack direction="horizontal" gap={3} wrap="wrap">
                  <Button
                    label={reviewBusy ? "Sending…" : "Reconciliation found — release report"}
                    variant="primary"
                    isLoading={reviewBusy}
                    onClick={() => sendOutcome("reviewed")}
                  />
                  <Button
                    label="No reconciliation found"
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

      {/* Reviewed history — bills already responded to (searchable, paginated) */}
      <Card padding={5}>
        <Stack gap={3}>
          <Stack direction="horizontal" gap={2} align="center">
            <span style={{ display: "inline-flex", color: PRIMARY }}>
              <History size={16} />
            </span>
            <Text weight="semibold">Reviewed</Text>
            {reviewedTotal > 0 ? <Badge label={`${reviewedTotal}`} /> : null}
          </Stack>
          <Text type="supporting">
            Bills you've responded to — verified or sent back — newest first. Search by site,
            organization or customer.
          </Text>
          <Stack direction="horizontal" gap={2} align="center">
            <span style={{ display: "inline-flex", color: "hsl(215 16% 47%)" }}>
              <Search size={16} />
            </span>
            <TextInput
              label=""
              placeholder="Search reviewed bills…"
              value={reviewedSearch}
              onChange={setReviewedSearch}
              width="100%"
            />
          </Stack>
          {reviewedLoading ? (
            <Stack gap={2}>
              <Skeleton height={40} />
              <Skeleton height={40} />
            </Stack>
          ) : reviewed.length === 0 ? (
            <Text type="supporting">
              {reviewedQuery ? "No reviewed bills match your search." : "No bills reviewed yet."}
            </Text>
          ) : (
            <>
              <Table
                data={reviewed}
                columns={[
                  {
                    key: "who",
                    header: "Submitted by",
                    renderCell: (r) => (
                      <Stack gap={0}>
                        <Text weight="medium">{r.customerEmail ?? "Customer"}</Text>
                        <Text type="supporting">{r.organizationName ?? "—"}</Text>
                      </Stack>
                    ),
                  },
                  {
                    key: "site",
                    header: "Site / period",
                    renderCell: (r) => (
                      <Stack gap={0}>
                        <Text>{r.siteName ?? "Site"}</Text>
                        <Text type="supporting">
                          {new Date(r.billingPeriodStart).toLocaleDateString()} –{" "}
                          {new Date(r.billingPeriodEnd).toLocaleDateString()}
                        </Text>
                      </Stack>
                    ),
                  },
                  {
                    key: "billed",
                    header: "Billed",
                    renderCell: (r) => <Text weight="medium">{randFmt(r.chargedTotalCents)}</Text>,
                  },
                  {
                    key: "discrepancy",
                    header: "Discrepancy",
                    renderCell: (r) => {
                      if (r.expectedLandlordCents == null) return <Text type="supporting">—</Text>;
                      const d = r.discrepancyVsLandlordCents ?? 0;
                      return (
                        <Text weight="medium">
                          <span style={{ color: d > 0 ? "hsl(0 72% 45%)" : "hsl(142 71% 35%)" }}>
                            {d > 0 ? "+" : ""}
                            {randFmt(d)}
                          </span>
                        </Text>
                      );
                    },
                  },
                  {
                    key: "outcome",
                    header: "Outcome",
                    renderCell: (r) =>
                      r.reviewStatus === "reviewed" ? (
                        <Badge variant="success" label="Report released" />
                      ) : (
                        <Badge variant="neutral" label="No reconciliation" />
                      ),
                  },
                  {
                    key: "when",
                    header: "Reviewed",
                    renderCell: (r) => (
                      <Text type="supporting">
                        {r.reviewedAt ? new Date(r.reviewedAt).toLocaleDateString() : "—"}
                      </Text>
                    ),
                  },
                ]}
                density="compact"
                dividers="rows"
              />
              <Stack direction="horizontal" gap={3} align="center" justify="between" wrap="wrap">
                <Text type="supporting">
                  Showing {reviewedOffset + 1}–{Math.min(reviewedOffset + REVIEWED_LIMIT, reviewedTotal)}{" "}
                  of {reviewedTotal}
                </Text>
                <Stack direction="horizontal" gap={2}>
                  <Button
                    label="Previous"
                    variant="secondary"
                    size="sm"
                    isDisabled={reviewedOffset === 0}
                    onClick={() => setReviewedOffset(Math.max(0, reviewedOffset - REVIEWED_LIMIT))}
                  />
                  <Button
                    label="Next"
                    variant="secondary"
                    size="sm"
                    isDisabled={reviewedOffset + REVIEWED_LIMIT >= reviewedTotal}
                    onClick={() => setReviewedOffset(reviewedOffset + REVIEWED_LIMIT)}
                  />
                </Stack>
              </Stack>
            </>
          )}
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
          {schedules.some((s) => s.extractionError) ? (
            <Banner
              status="warning"
              title="LlamaParse is failing"
              description="One or more schedules fell back to pdftotext, so their rate tables are likely missing and exact-rate checks won't work. Check LLAMA_CLOUD_API_KEY and your LlamaCloud quota/status, then re-upload. (We also email this to the Sparks inbox.)"
            />
          ) : null}
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
                  header: "Rates",
                  renderCell: (s) =>
                    s.extractionStatus === "pending" ? (
                      <Badge variant="neutral" label="extracting…" />
                    ) : s.extractionStatus === "failed" ? (
                      <Badge variant="error" label="failed" />
                    ) : s.extractionError ? (
                      // Ready, but LlamaParse broke → we're on rate-table-less fallback.
                      <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
                        <Badge variant="warning" label="LlamaParse failed — pdftotext" />
                        <Text type="supporting">
                          {s.textLength.toLocaleString()} chars · rates likely missing
                        </Text>
                      </span>
                    ) : (
                      <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
                        <Badge variant="success" label={s.extractionEngine ?? "ready"} />
                        <Text type="supporting">{s.textLength.toLocaleString()} chars</Text>
                      </span>
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

      {/* Provisioning & setup — occasional actions, collapsed by default */}
      <Card padding={5}>
        <Stack gap={showProvisioning ? 6 : 0}>
          <button
            type="button"
            onClick={() => setShowProvisioning((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "none",
              border: 0,
              padding: 0,
              cursor: "pointer",
              font: "inherit",
              color: "inherit",
              width: "100%",
              textAlign: "left",
            }}
          >
            <span style={{ display: "inline-flex", color: PRIMARY }}>
              {showProvisioning ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </span>
            <Text weight="semibold">Provisioning &amp; setup</Text>
            <Text type="supporting">— provision customers, add sites, view organizations</Text>
          </button>

          {showProvisioning ? (
            <Stack gap={6}>
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

              {/* Organizations overview + decommissioning */}
              <Stack gap={3}>
                <Text weight="semibold">Organizations</Text>
                {orgActionMsg ? <Banner status={orgActionMsg.kind} title={orgActionMsg.text} /> : null}
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
                      {
                        key: "manage",
                        header: "",
                        renderCell: (o) => (
                          <Button label="Manage" variant="secondary" size="sm" onClick={() => openManage(o.id, o.name)} />
                        ),
                      },
                    ]}
                    density="compact"
                    dividers="rows"
                  />
                )}

                {manageOrg ? (
                  <Card padding={5}>
                    <Stack gap={4}>
                      <Stack direction="horizontal" gap={2} align="center" justify="between" wrap="wrap">
                        <Text weight="semibold">Manage — {manageOrg.name}</Text>
                        <Button
                          label="Close"
                          variant="ghost"
                          size="sm"
                          isDisabled={orgActionBusy}
                          onClick={() => setManageOrg(null)}
                        />
                      </Stack>

                      <Stack gap={2}>
                        <Text type="supporting">Sites</Text>
                        {orgSitesLoading ? (
                          <Skeleton height={36} />
                        ) : orgSites.length === 0 ? (
                          <Text type="supporting">No sites under this organization.</Text>
                        ) : (
                          <Table
                            data={orgSites}
                            columns={[
                              { key: "name", header: "Site", renderCell: (s) => <Text weight="medium">{s.name}</Text> },
                              { key: "city", header: "City", renderCell: (s) => <Text type="supporting">{s.city ?? "—"}</Text> },
                              { key: "status", header: "Status", renderCell: (s) => <Badge label={s.status} /> },
                              {
                                key: "hw",
                                header: "",
                                renderCell: (s) => (
                                  <Button
                                    label={manageSite?.id === s.id ? "Hide hardware" : "Hardware"}
                                    variant="secondary"
                                    size="sm"
                                    icon={<Cpu size={14} />}
                                    onClick={() => openHardware(s.id, s.name)}
                                  />
                                ),
                              },
                              {
                                key: "del",
                                header: "",
                                renderCell: (s) => (
                                  <Button
                                    label="Delete"
                                    variant="ghost"
                                    size="sm"
                                    icon={<Trash2 size={14} />}
                                    isDisabled={orgActionBusy}
                                    onClick={() => deleteOneSite(s.id, s.name)}
                                  />
                                ),
                              },
                            ]}
                            density="compact"
                            dividers="rows"
                          />
                        )}
                      </Stack>

                      {/* Hardware provisioning for the selected site */}
                      {manageSite ? (
                        <Card padding={4}>
                          <Stack gap={3}>
                            <Text weight="semibold">Devices &amp; meters — {manageSite.name}</Text>
                            <Banner
                              status="info"
                              title="How onboarding works"
                              description="Add the device (Pi), then a meter on it. Copy the meter's mint command, run it OFFLINE with your private key to create the JWT, and flash that token onto the Pi. It then streams to /ingest/raw."
                            />
                            {hwMsg ? <Banner status={hwMsg.kind} title={hwMsg.text} /> : null}

                            <Stack direction="horizontal" gap={2} align="end" wrap="wrap">
                              <TextInput label="New device serial" value={devSerial} onChange={setDevSerial} isDisabled={hwBusy} width={200} />
                              <TextInput label="Model" value={devModel} onChange={setDevModel} isDisabled={hwBusy} width={120} />
                              <Button label={hwBusy ? "Adding…" : "Add device"} variant="primary" size="sm" icon={<Plus size={14} />} isLoading={hwBusy} onClick={provisionDevice} />
                            </Stack>

                            {hardwareLoading ? (
                              <Skeleton height={40} />
                            ) : hardwareDevices.length === 0 ? (
                              <Text type="supporting">No devices yet. Add one above.</Text>
                            ) : (
                              <Stack gap={3}>
                                {hardwareDevices.map((d) => (
                                  <Card key={d.id} padding={4}>
                                    <Stack gap={2}>
                                      <Stack direction="horizontal" justify="between" align="center" wrap="wrap" gap={2}>
                                        <Stack direction="horizontal" gap={2} align="center">
                                          <span style={{ display: "inline-flex", color: PRIMARY }}><Cpu size={14} /></span>
                                          <Text weight="medium">{d.serialNumber}</Text>
                                          <Badge label={d.status} />
                                          <Text type="supporting">{d.hardwareModel}</Text>
                                        </Stack>
                                        <Stack direction="horizontal" gap={2}>
                                          <Button label="Add meter" variant="secondary" size="sm" icon={<Plus size={14} />} isDisabled={hwBusy} onClick={() => { setAddMeterFor(d.id); setMeterSerial(""); setHwMsg(null); }} />
                                          <Button label="Remove" variant="ghost" size="sm" icon={<Trash2 size={14} />} isDisabled={hwBusy} onClick={() => removeDevice(d.id, d.serialNumber)} />
                                        </Stack>
                                      </Stack>

                                      {addMeterFor === d.id ? (
                                        <Stack direction="horizontal" gap={2} align="end" wrap="wrap">
                                          <TextInput label="Meter serial" value={meterSerial} onChange={setMeterSerial} isDisabled={hwBusy} width={200} />
                                          <Button label={hwBusy ? "Saving…" : "Save meter"} variant="primary" size="sm" isLoading={hwBusy} onClick={() => provisionMeter(d.id)} />
                                          <Button label="Cancel" variant="ghost" size="sm" isDisabled={hwBusy} onClick={() => setAddMeterFor(null)} />
                                        </Stack>
                                      ) : null}

                                      {d.meters.length === 0 ? (
                                        <Text type="supporting">No meters on this device yet.</Text>
                                      ) : (
                                        <Table
                                          data={d.meters}
                                          columns={[
                                            { key: "serial", header: "Meter", renderCell: (m) => <Text>{m.serialNumber}</Text> },
                                            {
                                              key: "id",
                                              header: "meterId (JWT claim)",
                                              renderCell: (m) => (
                                                <code style={{ fontSize: 11, color: "hsl(215 16% 40%)" }}>{m.id}</code>
                                              ),
                                            },
                                            {
                                              key: "mint",
                                              header: "",
                                              renderCell: (m) => (
                                                <Button
                                                  label={copiedMeter === m.id ? "Copied!" : "Copy mint cmd"}
                                                  variant="secondary"
                                                  size="sm"
                                                  icon={<Copy size={14} />}
                                                  onClick={() => copyMintCommand(m.id)}
                                                />
                                              ),
                                            },
                                            {
                                              key: "del",
                                              header: "",
                                              renderCell: (m) => (
                                                <Button label="Delete" variant="ghost" size="sm" icon={<Trash2 size={14} />} isDisabled={hwBusy} onClick={() => removeMeter(m.id, m.serialNumber)} />
                                              ),
                                            },
                                          ]}
                                          density="compact"
                                          dividers="rows"
                                        />
                                      )}
                                    </Stack>
                                  </Card>
                                ))}
                              </Stack>
                            )}
                          </Stack>
                        </Card>
                      ) : null}

                      <Stack gap={2}>
                        <Banner
                          status="warning"
                          title="Delete this organization"
                          description="Removes the organization and ALL of its sites, meters, readings, bills and reconciliations. This can't be undone — use only when a customer ends their subscription. Their user login is left intact."
                        />
                        <TextInput
                          label={`Type "${manageOrg.name}" to confirm`}
                          value={orgDeleteConfirm}
                          onChange={setOrgDeleteConfirm}
                          isDisabled={orgActionBusy}
                          width="100%"
                        />
                        <div style={{ display: "grid" }}>
                          <Button
                            label={orgActionBusy ? "Deleting…" : "Delete organization"}
                            variant="destructive"
                            isLoading={orgActionBusy}
                            isDisabled={orgDeleteConfirm.trim() !== manageOrg.name}
                            onClick={deleteOrg}
                          />
                        </div>
                      </Stack>
                    </Stack>
                  </Card>
                ) : null}
              </Stack>
            </Stack>
          ) : null}
        </Stack>
      </Card>
    </Stack>
  );
}
