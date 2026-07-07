"use client";

import { PhoneInput } from "@/components/PhoneInput";
import { TeamAccess } from "@/components/team-access";
import { client } from "@/lib/client";
import { useRPC } from "@/lib/useRPC";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ArrowLeft, Building2, CalendarRange, Check, Gauge, Phone } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

function Saved() {
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "hsl(142 71% 40%)" }}
    >
      <Check size={16} /> <Text type="supporting">Saved</Text>
    </span>
  );
}

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{ color: "hsl(221 83% 53%)", display: "inline-flex" }}>{icon}</span>
      <Text weight="semibold">{children}</Text>
    </span>
  );
}

export default function SiteSettingsPage() {
  const params = useParams();
  const siteId = params.siteId as string;

  const { data: site, loading, refetch } = useRPC(() => client.sites.get({ siteId }), [siteId]);
  const { data: policy, refetch: refetchPolicy } = useRPC(
    () => client.billing.policies.get({ siteId }),
    [siteId],
  );

  // ── Site details ──────────────────────────────────────────────
  const [details, setDetails] = useState({
    name: "",
    addressLine1: "",
    city: "",
    province: "",
    status: "active",
  });
  const [detailsMsg, setDetailsMsg] = useState<"idle" | "saving" | "saved">("idle");
  const [detailsErr, setDetailsErr] = useState("");

  useEffect(() => {
    if (site) {
      setDetails({
        name: site.name ?? "",
        addressLine1: site.addressLine1 ?? "",
        city: site.city ?? "",
        province: site.province ?? "",
        status: site.status ?? "active",
      });
    }
  }, [site]);

  const saveDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    setDetailsMsg("saving");
    setDetailsErr("");
    try {
      await client.sites.update({ siteId, ...details });
      await refetch();
      setDetailsMsg("saved");
    } catch (err) {
      setDetailsErr(err instanceof Error ? err.message : "Failed to save");
      setDetailsMsg("idle");
    }
  };

  // ── Contact number (for SMS notifications) ────────────────────
  const { data: me, refetch: refetchMe } = useRPC(() => client.session.me(), []);
  const [phone, setPhone] = useState("");
  const [phoneMsg, setPhoneMsg] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    if (me) setPhone(me.phone ?? "");
  }, [me]);

  const savePhone = async (e: React.FormEvent) => {
    e.preventDefault();
    setPhoneMsg("saving");
    try {
      await client.profile.setPhone({ phone });
      await refetchMe();
      setPhoneMsg("saved");
    } catch {
      setPhoneMsg("idle");
    }
  };

  // ── Metering (demand interval) ────────────────────────────────
  const [interval, setIntervalMin] = useState<15 | 30 | 45 | 60>(30);
  const [meterMsg, setMeterMsg] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    const m = site?.demandIntervalMinutes;
    if (m === 15 || m === 30 || m === 45 || m === 60) {
      setIntervalMin(m);
    }
  }, [site]);

  const saveInterval = async (value: 15 | 30 | 45 | 60) => {
    setIntervalMin(value);
    setMeterMsg("saving");
    try {
      await client.sites.setDefaultDemandInterval({ siteId, demandIntervalMinutes: value });
      await refetch();
      setMeterMsg("saved");
    } catch {
      setMeterMsg("idle");
    }
  };

  // ── Billing cycle ─────────────────────────────────────────────
  const [cycle, setCycle] = useState<"calendar_month" | "day_of_month">("calendar_month");
  const [anchorDay, setAnchorDay] = useState(1);
  const [billingMsg, setBillingMsg] = useState<"idle" | "saving" | "saved">("idle");
  const [billingErr, setBillingErr] = useState("");

  useEffect(() => {
    if (policy) {
      if (policy.recurrence === "day_of_month") {
        setCycle("day_of_month");
        setAnchorDay(policy.anchorDay ?? 1);
      } else if (policy.recurrence === "calendar_month") {
        setCycle("calendar_month");
      }
    }
  }, [policy]);

  const saveBilling = async (e: React.FormEvent) => {
    e.preventDefault();
    setBillingMsg("saving");
    setBillingErr("");
    try {
      await client.billing.policies.set({
        siteId,
        recurrence: cycle,
        ...(cycle === "day_of_month" ? { anchorDay } : {}),
      });
      await refetchPolicy();
      setBillingMsg("saved");
    } catch (err) {
      setBillingErr(err instanceof Error ? err.message : "Failed to save billing cycle");
      setBillingMsg("idle");
    }
  };

  const update = (field: string, value: string) => {
    setDetails((d) => ({ ...d, [field]: value }));
    setDetailsMsg("idle");
  };

  if (loading) {
    return (
      <Stack gap={5}>
        <Skeleton height={32} width={200} />
        <Skeleton height={260} />
        <Skeleton height={160} />
      </Stack>
    );
  }

  return (
    <Stack gap={5}>
      <Stack gap={2}>
        <Link href={`/sites/${siteId}`}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ArrowLeft size={16} /> Back to site
          </span>
        </Link>
        <Heading level={2}>Site settings</Heading>
      </Stack>

      {/* Site details */}
      <Card padding={5}>
        <form onSubmit={saveDetails}>
          <Stack gap={4}>
            <SectionTitle icon={<Building2 size={16} />}>Site details</SectionTitle>
            {detailsErr ? <Banner status="error" title={detailsErr} /> : null}
            <TextInput
              label="Site name"
              value={details.name}
              onChange={(v) => update("name", v)}
              isRequired
              width="100%"
            />
            <TextInput
              label="Address line 1"
              value={details.addressLine1}
              onChange={(v) => update("addressLine1", v)}
              width="100%"
            />
            <Stack direction="horizontal" gap={4} wrap="wrap">
              <TextInput
                label="City"
                value={details.city}
                onChange={(v) => update("city", v)}
                width={200}
              />
              <TextInput
                label="Province"
                value={details.province}
                onChange={(v) => update("province", v)}
                width={200}
              />
              <Selector
                label="Status"
                options={[
                  { value: "active", label: "Active" },
                  { value: "inactive", label: "Inactive" },
                ]}
                value={details.status}
                onChange={(v) => update("status", v)}
                width={200}
              />
            </Stack>
            <Stack direction="horizontal" align="center" gap={3}>
              <Button
                label={detailsMsg === "saving" ? "Saving…" : "Save details"}
                type="submit"
                variant="primary"
                isLoading={detailsMsg === "saving"}
              />
              {detailsMsg === "saved" ? <Saved /> : null}
            </Stack>
          </Stack>
        </form>
      </Card>

      {/* Contact number */}
      <Card padding={5}>
        <form onSubmit={savePhone}>
          <Stack gap={3}>
            <SectionTitle icon={<Phone size={16} />}>Notifications</SectionTitle>
            <Text type="supporting">
              Add a mobile number to get an SMS when Sparks finishes reviewing your bill. Optional —
              outcomes always land in your Alerts inbox and email.
            </Text>
            <PhoneInput label="Mobile number" value={phone} onChange={setPhone} />
            <Stack direction="horizontal" align="center" gap={3}>
              <Button
                label={phoneMsg === "saving" ? "Saving…" : "Save number"}
                type="submit"
                variant="primary"
                isLoading={phoneMsg === "saving"}
              />
              {phoneMsg === "saved" ? <Saved /> : null}
            </Stack>
          </Stack>
        </form>
      </Card>

      {/* Metering */}
      <Card padding={5}>
        <Stack gap={3}>
          <SectionTitle icon={<Gauge size={16} />}>Metering</SectionTitle>
          <Selector
            label="Demand interval"
            options={[
              { value: "15", label: "15 minutes" },
              { value: "30", label: "30 minutes" },
              { value: "45", label: "45 minutes" },
              { value: "60", label: "60 minutes" },
            ]}
            value={String(interval)}
            onChange={(v) => saveInterval(Number(v) as 15 | 30 | 45 | 60)}
            width={280}
          />
          <Text type="supporting">
            The clock-aligned window used to compute maximum demand. Applies to intervals recorded
            from now on.
            {meterMsg === "saved" ? " Saved." : ""}
          </Text>
        </Stack>
      </Card>

      {/* Billing cycle */}
      <Card padding={5}>
        <form onSubmit={saveBilling}>
          <Stack gap={4}>
            <SectionTitle icon={<CalendarRange size={16} />}>Billing cycle</SectionTitle>
            {billingErr ? <Banner status="error" title={billingErr} /> : null}
            <Text type="supporting">
              Tell us exactly when this site&apos;s billing period runs so invoices and
              reconciliations line up with the landlord&apos;s cycle.
            </Text>
            <Selector
              label="Cycle"
              options={[
                { value: "calendar_month", label: "Calendar month (1st → month end)" },
                { value: "day_of_month", label: "Custom day of month" },
              ]}
              value={cycle}
              onChange={(v) => {
                setCycle(v as typeof cycle);
                setBillingMsg("idle");
              }}
              width={320}
            />

            {cycle === "day_of_month" ? (
              <Stack gap={1}>
                <NumberInput
                  label="Billing day"
                  min={1}
                  max={31}
                  value={anchorDay}
                  onChange={(v) => {
                    setAnchorDay(Math.min(31, Math.max(1, v ?? 1)));
                    setBillingMsg("idle");
                  }}
                  width={200}
                  isIntegerOnly
                />
                <Text type="supporting">
                  Each period runs from day {anchorDay} to day{" "}
                  {anchorDay === 1 ? 31 : anchorDay - 1} of the next month. Day 31 clamps to each
                  month&apos;s last day.
                </Text>
              </Stack>
            ) : null}

            <Stack direction="horizontal" align="center" gap={3}>
              <Button
                label={billingMsg === "saving" ? "Saving…" : "Save billing cycle"}
                type="submit"
                variant="primary"
                isLoading={billingMsg === "saving"}
              />
              {billingMsg === "saved" ? <Saved /> : null}
            </Stack>
          </Stack>
        </form>
      </Card>

      {/* Team & access — org owners invite Site Managers to this site. */}
      {site?.myLevel === "org_owner" || site?.myLevel === "site_admin" ? (
        <TeamAccess siteId={siteId} />
      ) : null}
    </Stack>
  );
}
