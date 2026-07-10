"use client";

import { AuthShell } from "@/components/AuthShell";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Link } from "@astryxdesign/core/Link";
import { Stack } from "@astryxdesign/core/Stack";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!email.trim()) {
      setError("Enter the email address for your account.");
      return;
    }
    setLoading(true);
    try {
      // The email link resolves to /auth/set-password?token=… (built server-side by the
      // sendResetPassword hook). We always show success — never reveal whether an account
      // exists for a given email.
      await fetch(`${API}/api/auth/request-password-reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          redirectTo: `${window.location.origin}/auth/set-password`,
        }),
      });
      setSent(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      title="Reset your password"
      subtitle="We'll email you a link to set a new password"
      footer={
        <>
          Remembered it? <Link href="/auth/login">Back to sign in</Link>
        </>
      }
    >
      {sent ? (
        <Stack gap={4}>
          <Banner
            status="success"
            title="Check your email"
            description={`If an account exists for ${email.trim()}, we've sent a link to reset your password. It may take a minute to arrive.`}
          />
          <Button label="Back to sign in" variant="secondary" href="/auth/login" />
        </Stack>
      ) : (
        <form onSubmit={handleSubmit}>
          <Stack gap={5}>
            {error ? <Banner status="error" title={error} /> : null}
            <TextInput
              label="Email address"
              type="email"
              value={email}
              onChange={setEmail}
              isDisabled={loading}
              width="100%"
            />
            <div style={{ display: "grid" }}>
              <Button
                label={loading ? "Sending…" : "Send reset link"}
                type="submit"
                variant="primary"
                isLoading={loading}
              />
            </div>
          </Stack>
        </form>
      )}
    </AuthShell>
  );
}
