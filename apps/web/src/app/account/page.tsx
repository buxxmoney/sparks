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
import { TextInput } from "@astryxdesign/core/TextInput";
import { KeyRound, MessageSquare } from "lucide-react";
import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export default function AccountPage() {
  const { data: me, loading, refetch } = useRPC(() => client.session.me(), []);

  // ── Text (SMS) updates ──────────────────────────────────────────────
  const [phone, setPhone] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    if (me) setPhone(me.phone ?? "");
  }, [me]);

  const savePhone = async (e: React.FormEvent) => {
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

  // ── Change password ─────────────────────────────────────────────────
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwStatus, setPwStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [pwError, setPwError] = useState("");

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError("");
    if (newPw.length < 8) {
      setPwError("Your new password must be at least 8 characters.");
      return;
    }
    if (newPw !== confirmPw) {
      setPwError("The new passwords don't match.");
      return;
    }
    setPwStatus("saving");
    try {
      const res = await fetch(`${API}/api/auth/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPwError(data.message || "Couldn't change your password. Check your current password.");
        setPwStatus("idle");
        return;
      }
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
      setPwStatus("saved");
      setTimeout(() => setPwStatus("idle"), 2500);
    } catch {
      setPwError("Something went wrong. Please try again.");
      setPwStatus("idle");
    }
  };

  return (
    <Stack gap={5} maxWidth={640}>
      <Stack gap={1}>
        <Heading level={2}>Account</Heading>
        <Text type="supporting">Manage how Sparks contacts you and your sign-in password.</Text>
      </Stack>

      {/* Text (SMS) updates */}
      <Card padding={6}>
        {loading ? (
          <Stack gap={3}>
            <Skeleton height={20} width={200} />
            <Skeleton height={40} />
          </Stack>
        ) : (
          <form onSubmit={savePhone}>
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

      {/* Change password */}
      <Card padding={6}>
        <form onSubmit={changePassword}>
          <Stack gap={4}>
            <Stack direction="horizontal" gap={2} align="center">
              <span style={{ display: "inline-flex", color: "hsl(221 83% 53%)" }}>
                <KeyRound size={16} />
              </span>
              <Text weight="semibold">Change password</Text>
            </Stack>

            {pwError ? <Banner status="error" title={pwError} /> : null}
            {pwStatus === "saved" ? <Banner status="success" title="Your password has been changed." /> : null}

            <TextInput
              label="Current password"
              type="password"
              value={currentPw}
              onChange={setCurrentPw}
              isDisabled={pwStatus === "saving"}
              width="100%"
            />
            <TextInput
              label="New password"
              type="password"
              description="At least 8 characters"
              value={newPw}
              onChange={setNewPw}
              isDisabled={pwStatus === "saving"}
              width="100%"
            />
            <TextInput
              label="Confirm new password"
              type="password"
              value={confirmPw}
              onChange={setConfirmPw}
              isDisabled={pwStatus === "saving"}
              width="100%"
            />
            <div style={{ display: "grid" }}>
              <Button
                label={pwStatus === "saving" ? "Saving…" : "Change password"}
                type="submit"
                variant="primary"
                isLoading={pwStatus === "saving"}
              />
            </div>
          </Stack>
        </form>
      </Card>
    </Stack>
  );
}
