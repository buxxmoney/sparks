"use client";

import { client } from "@/lib/client";
import { useRPC } from "@/lib/useRPC";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { CalendarRange, Check } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Operator-side billing-cycle editor, opened from the site dashboard's settings drawer.
 *
 * Deliberately mirrors the customer's "Billing cycle" card in site settings — same
 * two cycle shapes, same copy — because an operator adjusting the cycle to check a
 * calculation must be exercising the exact path the customer would. The write goes
 * through `admin.setSiteBillingCycle` rather than `billing.policies.set`: operators
 * are read-only on customer sites and mutate only via operator-gated endpoints.
 *
 * `onSaved` lets the dashboard refetch its period-scoped cards so the new window's
 * numbers appear immediately — the point of the whole control.
 */
export function OperatorBillingCycle({
  siteId,
  onSaved,
}: {
  siteId: string;
  onSaved?: () => void;
}) {
  const { data: policy, refetch: refetchPolicy } = useRPC(
    () => client.billing.policies.get({ siteId }),
    [siteId],
  );

  const [cycle, setCycle] = useState<"calendar_month" | "day_of_month">("calendar_month");
  const [anchorDay, setAnchorDay] = useState(1);
  const [msg, setMsg] = useState<"idle" | "saving" | "saved">("idle");
  const [err, setErr] = useState("");

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

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("saving");
    setErr("");
    try {
      await client.admin.setSiteBillingCycle({
        siteId,
        recurrence: cycle,
        ...(cycle === "day_of_month" ? { anchorDay } : {}),
      });
      await refetchPolicy();
      setMsg("saved");
      onSaved?.();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Failed to save billing cycle");
      setMsg("idle");
    }
  };

  return (
    <Card padding={5}>
      <form onSubmit={save}>
        <Stack gap={4}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "hsl(221 83% 53%)", display: "inline-flex" }}>
              <CalendarRange size={16} />
            </span>
            <Text weight="semibold">Billing cycle</Text>
          </span>

          {err ? <Banner status="error" title={err} /> : null}

          {/* Operators are changing the customer's real cycle here, not a private
              preview — say so plainly before they hit save. */}
          <Text type="supporting">
            Sets when this site&apos;s billing period runs. This is the customer&apos;s live
            setting: their dashboard and future invoices and bill checks follow it too.
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
              setMsg("idle");
            }}
            // Fills the drawer rather than the settings page's fixed 320px: the
            // longest option ("Calendar month (1st → month end)") has to fit at
            // phone width, where the drawer is only as wide as the viewport.
            width="100%"
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
                  setMsg("idle");
                }}
                width={200}
                isIntegerOnly
              />
              <Text type="supporting">
                Each period runs from day {anchorDay} to day {anchorDay === 1 ? 31 : anchorDay - 1}{" "}
                of the next month.
                {anchorDay >= 29
                  ? ` Shorter months that don't have a day ${anchorDay} (like February) use their last day instead.`
                  : ""}
              </Text>
            </Stack>
          ) : null}

          <Stack direction="horizontal" align="center" gap={3}>
            <Button
              label={msg === "saving" ? "Saving…" : "Save billing cycle"}
              type="submit"
              variant="primary"
              isLoading={msg === "saving"}
            />
            {msg === "saved" ? (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  color: "hsl(142 71% 40%)",
                }}
              >
                <Check size={16} /> <Text type="supporting">Saved</Text>
              </span>
            ) : null}
          </Stack>
        </Stack>
      </form>
    </Card>
  );
}
