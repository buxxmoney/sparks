"use client";

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Logo } from "@/components/Logo";
import { client } from "@/lib/client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/api/auth/sign-in/email`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ email, password }),
        },
      );

      if (!response.ok) {
        const data = await response.json();
        setError(data.message || "Sign in failed");
        return;
      }

      // Persist a phone number the user entered at set-password (that page ends
      // unauthenticated, so it stashed it for the first sign-in). Best-effort.
      try {
        const pendingPhone = localStorage.getItem("sparks_pending_phone");
        if (pendingPhone) {
          await client.profile.setPhone({ phone: pendingPhone }).catch(() => {});
          localStorage.removeItem("sparks_pending_phone");
        }
      } catch {
        // ignore — phone is optional
      }

      // Honor a post-login redirect (e.g. accepting a site invite) if it's a
      // safe in-app path; otherwise go pick an organization.
      const next = new URLSearchParams(window.location.search).get("next");
      router.push(next && next.startsWith("/") ? next : "/auth/org-selector");
    } catch (err) {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
      }}
    >
      <div style={{ width: "100%", maxWidth: 420 }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
            marginBottom: 24,
            gap: 8,
          }}
        >
          <span
            style={{
              display: "inline-flex",
              width: 56,
              height: 56,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 14,
              background: "hsl(222 47% 11%)",
              color: "hsl(217 91% 60%)",
            }}
          >
            <Logo size={32} />
          </span>
          <Heading level={1}>Welcome back</Heading>
          <div style={{ marginTop: 6 }}>
            <Text type="supporting">Sign in to your Sparks account</Text>
          </div>
        </div>

        <Card padding={6}>
          <form onSubmit={handleSubmit}>
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {error ? <Banner status="error" title={error} /> : null}
              <TextInput
                label="Email address"
                type="email"
                value={email}
                onChange={(v) => setEmail(v)}
                isDisabled={loading}
              />
              <TextInput
                label="Password"
                type="password"
                value={password}
                onChange={(v) => setPassword(v)}
                isDisabled={loading}
              />
              <div style={{ display: "grid" }}>
                <Button
                  label={loading ? "Signing in…" : "Sign in"}
                  type="submit"
                  variant="primary"
                  isLoading={loading}
                />
              </div>
            </div>
          </form>
        </Card>

        <div style={{ textAlign: "center", marginTop: 20 }}>
          <Text type="supporting">
            Don&apos;t have an account? <Link href="/auth/signup">Sign up</Link>
          </Text>
        </div>
      </div>
    </div>
  );
}
