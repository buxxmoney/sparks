"use client";

import { AuthShell } from "@/components/AuthShell";
import { client } from "@/lib/client";
import { clearSelectedOrganization, setSelectedOrganization } from "@/lib/useOrganizationContext";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Link } from "@astryxdesign/core/Link";
import { Stack } from "@astryxdesign/core/Stack";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/api/auth/sign-up/email`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ email, password, name: email.split("@")[0] }),
        },
      );

      if (!response.ok) {
        const data = await response.json();
        setError(data.message || "Sign up failed");
        return;
      }

      // A brand-new user belongs to no org yet. Clear any stale org id left in
      // localStorage from a previous session, so the createOrganization RPC below
      // doesn't send an x-organization-id the new user isn't a member of (→ 403).
      clearSelectedOrganization();

      const orgData = await client.session.createOrganization({
        name: `${email.split("@")[0]}'s Organization`,
      });
      setSelectedOrganization(orgData.organizationId);
      const next = new URLSearchParams(window.location.search).get("next");
      router.push(next && next.startsWith("/") ? next : "/dashboard");
    } catch (err) {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      title="Create your account"
      subtitle="Start reconciling your electricity bills"
      footer={
        <>
          Already have an account? <Link href="/auth/login">Sign in</Link>
        </>
      }
    >
      <form onSubmit={handleSubmit}>
        <Stack gap={5}>
          {error ? <Banner status="error" title={error} /> : null}
          <TextInput
            label="Email address"
            type="email"
            value={email}
            onChange={(v) => setEmail(v)}
            isDisabled={loading}
            width="100%"
          />
          <TextInput
            label="Password"
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
            value={confirmPassword}
            onChange={(v) => setConfirmPassword(v)}
            isDisabled={loading}
            width="100%"
          />
          <div style={{ display: "grid" }}>
            <Button
              label={loading ? "Creating account…" : "Create account"}
              type="submit"
              variant="primary"
              isLoading={loading}
            />
          </div>
        </Stack>
      </form>
    </AuthShell>
  );
}
