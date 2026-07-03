"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { setSelectedOrganization } from "@/lib/useOrganizationContext";

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
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          email,
          password,
          name: email.split("@")[0],
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        setError(data.message || "Sign up failed");
        return;
      }

      // Create organization for new user
      const orgResponse = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/rpc/call`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          method: "session.createOrganization",
          params: {
            name: `${email.split("@")[0]}'s Organization`,
          },
        }),
      });

      if (!orgResponse.ok) {
        const data = await orgResponse.json();
        setError(data.error || "Failed to create organization");
        return;
      }

      const orgData = await orgResponse.json();
      setSelectedOrganization(orgData.organizationId);
      router.push("/dashboard");
    } catch (err) {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page-container">
      <div style={{ maxWidth: "400px", margin: "4rem auto" }}>
        <div className="content-card">
          <h1 style={{ textAlign: "center", marginBottom: "2rem" }}>Create Account</h1>

          {error && <div className="alert alert-danger">{error}</div>}

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label">Email Address</label>
              <input
                type="email"
                className="form-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={loading}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Password</label>
              <input
                type="password"
                className="form-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={loading}
              />
              <div style={{ fontSize: "0.875rem", color: "#6c757d", marginTop: "0.25rem" }}>
                At least 8 characters
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Confirm Password</label>
              <input
                type="password"
                className="form-input"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                disabled={loading}
              />
            </div>

            <button type="submit" className="btn btn-primary" style={{ width: "100%", marginTop: "1.5rem" }} disabled={loading}>
              {loading ? "Creating account..." : "Create Account"}
            </button>
          </form>

          <div style={{ marginTop: "1.5rem", textAlign: "center", color: "#6c757d" }}>
            Already have an account?{" "}
            <Link href="/auth/login" style={{ color: "#0066cc", fontWeight: "500" }}>
              Sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
