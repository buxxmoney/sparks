"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function NewSitePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);

  const [formData, setFormData] = useState({
    name: "",
    addressLine1: "",
    city: "",
    province: "",
    supplyZone: "",
    timezone: "America/Toronto",
    demandIntervalMinutes: "15",
  });

  // Get organization ID on mount
  useEffect(() => {
    const getOrgId = async () => {
      try {
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/rpc/call`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              method: "session.me",
              params: {},
            }),
          },
        );

        if (!response.ok) {
          throw new Error("Failed to get session");
        }

        const data = await response.json();
        setOrganizationId(data.organizationId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load organization");
      } finally {
        setInitializing(false);
      }
    };

    getOrgId();
  }, []);

  if (initializing) {
    return (
      <div className="page-container">
        <div style={{ textAlign: "center", marginTop: "4rem" }}>
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  if (!organizationId) {
    return (
      <div className="page-container">
        <div style={{ maxWidth: "600px", margin: "2rem auto" }}>
          <div className="content-card">
            <div className="alert alert-danger">
              {error || "Unable to determine organization. Please log in again."}
            </div>
            <button
              onClick={() => router.push("/dashboard")}
              className="btn btn-secondary"
            >
              Back to Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/rpc/call`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            method: "sites.create",
            params: {
              organizationId,
              name: formData.name,
              addressLine1: formData.addressLine1,
              city: formData.city,
              province: formData.province,
              supplyZone: formData.supplyZone,
              timezone: formData.timezone,
              demandIntervalMinutes: parseInt(formData.demandIntervalMinutes),
            },
          }),
        },
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      const result = await response.json();
      if (result.id) {
        router.push("/dashboard");
      } else {
        throw new Error("Site creation failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page-container">
      <div style={{ maxWidth: "600px", margin: "2rem auto" }}>
        <div className="content-card">
          <h1 style={{ marginBottom: "2rem" }}>Create New Site</h1>

          {error && <div className="alert alert-danger" style={{ marginBottom: "1.5rem" }}>{error}</div>}

          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: "1.5rem" }}>
              <label style={{ display: "block", marginBottom: "0.5rem" }}>
                Site Name *
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
                style={{
                  width: "100%",
                  padding: "0.5rem",
                  border: "1px solid #ddd",
                  borderRadius: "4px",
                  fontSize: "1rem",
                }}
              />
            </div>

            <div style={{ marginBottom: "1.5rem" }}>
              <label style={{ display: "block", marginBottom: "0.5rem" }}>
                Address Line 1 *
              </label>
              <input
                type="text"
                value={formData.addressLine1}
                onChange={(e) => setFormData({ ...formData, addressLine1: e.target.value })}
                required
                style={{
                  width: "100%",
                  padding: "0.5rem",
                  border: "1px solid #ddd",
                  borderRadius: "4px",
                  fontSize: "1rem",
                }}
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1.5rem" }}>
              <div>
                <label style={{ display: "block", marginBottom: "0.5rem" }}>
                  City *
                </label>
                <input
                  type="text"
                  value={formData.city}
                  onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                  required
                  style={{
                    width: "100%",
                    padding: "0.5rem",
                    border: "1px solid #ddd",
                    borderRadius: "4px",
                    fontSize: "1rem",
                  }}
                />
              </div>

              <div>
                <label style={{ display: "block", marginBottom: "0.5rem" }}>
                  Province *
                </label>
                <input
                  type="text"
                  value={formData.province}
                  onChange={(e) => setFormData({ ...formData, province: e.target.value })}
                  required
                  style={{
                    width: "100%",
                    padding: "0.5rem",
                    border: "1px solid #ddd",
                    borderRadius: "4px",
                    fontSize: "1rem",
                  }}
                />
              </div>
            </div>

            <div style={{ marginBottom: "1.5rem" }}>
              <label style={{ display: "block", marginBottom: "0.5rem" }}>
                Supply Zone
              </label>
              <input
                type="text"
                value={formData.supplyZone}
                onChange={(e) => setFormData({ ...formData, supplyZone: e.target.value })}
                style={{
                  width: "100%",
                  padding: "0.5rem",
                  border: "1px solid #ddd",
                  borderRadius: "4px",
                  fontSize: "1rem",
                }}
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1.5rem" }}>
              <div>
                <label style={{ display: "block", marginBottom: "0.5rem" }}>
                  Timezone *
                </label>
                <select
                  value={formData.timezone}
                  onChange={(e) => setFormData({ ...formData, timezone: e.target.value })}
                  required
                  style={{
                    width: "100%",
                    padding: "0.5rem",
                    border: "1px solid #ddd",
                    borderRadius: "4px",
                    fontSize: "1rem",
                  }}
                >
                  <option>America/Toronto</option>
                  <option>America/Vancouver</option>
                  <option>America/New_York</option>
                  <option>America/Chicago</option>
                </select>
              </div>

              <div>
                <label style={{ display: "block", marginBottom: "0.5rem" }}>
                  Demand Interval (minutes)
                </label>
                <input
                  type="number"
                  value={formData.demandIntervalMinutes}
                  onChange={(e) => setFormData({ ...formData, demandIntervalMinutes: e.target.value })}
                  min="1"
                  style={{
                    width: "100%",
                    padding: "0.5rem",
                    border: "1px solid #ddd",
                    borderRadius: "4px",
                    fontSize: "1rem",
                  }}
                />
              </div>
            </div>

            <div style={{ display: "flex", gap: "1rem", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => router.push("/dashboard")}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="btn btn-primary"
              >
                {loading ? "Creating..." : "Create Site"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
