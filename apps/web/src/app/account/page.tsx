"use client";

import { client } from "@/lib/client";
import { useRPC } from "@/lib/useRPC";
import { PhoneInput } from "@/components/PhoneInput";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { MessageSquare } from "lucide-react";
import { useEffect, useState } from "react";

export default function AccountPage() {
  const { data: me, loading, refetch } = useRPC(() => client.session.me(), []);
  const [phone, setPhone] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState("");

  // Hydrate the field from the saved number once `me` loads.
  useEffect(() => {
    if (me) setPhone(me.phone ?? "");
  }, [me]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("saving");
    setError("");
    try {
      const res = await client.profile.setPhone({ phone });
      setPhone(res.phone ?? "");
      await refetch();
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your number. Please try again.");
      setStatus("idle");
    }
  };

  return (
    <Stack gap={5} maxWidth={640}>
      <Stack gap={1}>
        <Heading level={2}>Account</Heading>
        <Text type="supporting">Manage how Sparks contacts you.</Text>
      </Stack>

      <Card padding={6}>
        {loading ? (
          <Stack gap={3}>
            <Skeleton height={20} width={200} />
            <Skeleton height={40} />
          </Stack>
        ) : (
          <form onSubmit={save}>
            <Stack gap={4}>
              <Stack direction="horizontal" gap={2} align="center">
                <span style={{ display: "inline-flex", color: "hsl(221 83% 53%)" }}>
                  <MessageSquare size={16} />
                </span>
                <Text weight="semibold">Text (SMS) updates</Text>
              </Stack>
              <Text type="supporting">
                Add your mobile number to get a text message when Sparks finishes reviewing one of
                your bills. You'll still get email and in-app alerts either way — leave the number
                blank to turn texts off.
              </Text>

              {error ? <Banner status="error" title={error} /> : null}
              {status === "saved" ? (
                <Banner
                  status="success"
                  title={phone ? "Saved — you'll get text updates at this number." : "Saved — text updates are off."}
                />
              ) : null}

              <PhoneInput
                label="Mobile number"
                description="Include your country — e.g. South Africa +27"
                value={phone}
                onChange={setPhone}
                isDisabled={status === "saving"}
              />

              <div style={{ display: "grid" }}>
                <Button
                  label={status === "saving" ? "Saving…" : "Save number"}
                  type="submit"
                  variant="primary"
                  isLoading={status === "saving"}
                />
              </div>
            </Stack>
          </form>
        )}
      </Card>
    </Stack>
  );
}
