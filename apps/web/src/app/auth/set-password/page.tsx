"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Stack } from "@astryxdesign/core/Stack";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import { AuthShell } from "@/components/AuthShell";
import { PhoneInput } from "@/components/PhoneInput";

function SetPasswordForm() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!token) {
      setError("This link is missing its token. Please use the link from your email.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/api/auth/reset-password`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ newPassword: password, token }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.message || "This link is invalid or has expired. Ask Sparks to resend it.");
        return;
      }
      // Stash the optional phone; the first sign-in persists it to the profile
      // (this page finishes unauthenticated, so we can't set it directly here).
      const trimmed = phone.trim();
      if (trimmed) {
        try {
          localStorage.setItem("sparks_pending_phone", trimmed);
        } catch {
          // ignore storage failures — phone is optional
        }
      }
      setDone(true);
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <Stack gap={4}>
        <Banner status="success" title="Password set. You can now sign in." />
        <Button label="Go to sign in" variant="primary" href="/auth/login" />
      </Stack>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <Stack gap={5}>
        {error ? <Banner status="error" title={error} /> : null}
        <TextInput
          label="New password"
          type="password"
          description="At least 8 characters"
          value={password}
          onChange={(v) => setPassword(v)}
          isDisabled={loading}
          width="100%"
        />
        <TextInput
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={(v) => setConfirm(v)}
          isDisabled={loading}
          width="100%"
        />
        <PhoneInput
          label="Mobile number (optional)"
          description="For SMS updates when your bill review is ready"
          value={phone}
          onChange={setPhone}
          isDisabled={loading}
        />
        <div style={{ display: "grid" }}>
          <Button
            label={loading ? "Saving…" : "Set password"}
            type="submit"
            variant="primary"
            isLoading={loading}
          />
        </div>
      </Stack>
    </form>
  );
}

export default function SetPasswordPage() {
  return (
    <AuthShell
      title="Set your password"
      subtitle="Choose a password to finish setting up your Sparks account"
      footer={
        <>
          Already set up? <Link href="/auth/login">Sign in</Link>
        </>
      }
    >
      <Suspense fallback={<Text type="supporting">Loading…</Text>}>
        <SetPasswordForm />
      </Suspense>
    </AuthShell>
  );
}
