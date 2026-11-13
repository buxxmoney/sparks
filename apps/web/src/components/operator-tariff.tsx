"use client";

import { client } from "@/lib/client";
import { useRPC } from "@/lib/useRPC";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Check, Receipt } from "lucide-react";
import { useState } from "react";

/**
 * Operator-side tariff switch, in the site dashboard's settings drawer.
 *
 * Moves the site onto a tariff picked from the published schedule — the rates come
 * from the schedule, so there is nothing to type and nothing to mistype. The
 * hand-entered "assign landlord tariff" form on the operator console stays for
 * tariffs that are not in a published schedule.
 *
 * `onSaved` lets the dashboard re-price its cost card under the new tariff.
 */
export function OperatorTariff({ siteId, onSaved }: { siteId: string; onSaved?: () => void }) {
  const { data: current, refetch: refetchCurrent } = useRPC(
    () => client.admin.siteTariffGet({ siteId }),
    [siteId],
  );
  const { data: catalogue } = useRPC(() => client.admin.tariffCatalogue(), []);

  const [tariffId, setTariffId] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<"idle" | "saving" | "saved">("idle");
  const [err, setErr] = useState("");

  const tariffs = catalogue?.tariffs ?? [];
  const selected = tariffs.find((t) => t.tariffId === tariffId);
  const currentName = current?.profile?.name ?? null;
  const isCurrent = selected !== undefined && selected.name === currentName;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tariffId) return;
    setMsg("saving");
    setErr("");
    try {
      await client.admin.switchSiteTariff({
        siteId,
        tariffId,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      await refetchCurrent();
      setMsg("saved");
      setNote("");
      onSaved?.();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Failed to switch tariff");
      setMsg("idle");
    }
  };

  return (
    <Card padding={5}>
      <form onSubmit={save}>
        <Stack gap={4}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "hsl(221 83% 53%)", display: "inline-flex" }}>
              <Receipt size={16} />
            </span>
            <Text weight="semibold">Tariff</Text>
          </span>

          {err ? <Banner status="error" title={err} /> : null}

          <Text type="supporting">
            {currentName
              ? `Currently on ${currentName}.`
              : "No tariff is assigned to this site yet."}{" "}
            A site has one tariff: switching re-prices every period&apos;s estimated cost, past
            and current, and future bill checks under the new one.
          </Text>

          <Selector
            label="Move to"
            placeholder="Choose a published tariff"
            options={tariffs.map((t) => ({ value: t.tariffId, label: t.name }))}
            value={tariffId}
            onChange={(v) => {
              setTariffId(v as string);
              setMsg("idle");
            }}
            width="100%"
          />

          {/* Rules the schedule defines but the pricer does not apply yet. Shown
              before the switch, because they mean the estimate will be incomplete. */}
          {selected && selected.notApplied.length > 0 ? (
            <Banner
              status="warning"
              title="Some charges on this tariff are not priced yet"
              description={selected.notApplied.map((n) => n.effect).join(" ")}
            />
          ) : null}

          <TextInput
            label="Reason (optional)"
            value={note}
            onChange={setNote}
            isDisabled={msg === "saving"}
            width="100%"
          />

          <Stack direction="horizontal" align="center" gap={3}>
            <Button
              label={msg === "saving" ? "Switching…" : "Switch tariff"}
              type="submit"
              variant="primary"
              isLoading={msg === "saving"}
              isDisabled={!tariffId || isCurrent}
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
                <Check size={16} /> <Text type="supporting">Switched</Text>
              </span>
            ) : null}
          </Stack>
        </Stack>
      </form>
    </Card>
  );
}
