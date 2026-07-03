"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { setSelectedOrganization } from "@/lib/useOrganizationContext";

interface Membership {
  organizationId: string;
  organizationName: string;
  role: string;
}

export default function OrgSelectorPage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selecting, setSelecting] = useState(false);

  useEffect(() => {
    const loadMemberships = async () => {
      try {
        // First check if user is authenticated
        const sessionResponse = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/api/auth/get-session`,
          {
            credentials: "include",
          },
        );

        if (!sessionResponse.ok) {
          router.push("/auth/login");
          return;
        }

        // Fetch user's organization memberships
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/rpc/call`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            credentials: "include",
            body: JSON.stringify({
              method: "session.listMemberships",
              params: {},
            }),
          },
        );

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to load organizations");
        }

        const data = await response.json();
        setMemberships(data);

        // If only one organization, auto-select it
        if (data.length === 1) {
          setSelectedOrganization(data[0].organizationId);
          router.push("/dashboard");
          return;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load organizations");
      } finally {
        setLoading(false);
      }
    };

    loadMemberships();
  }, [router]);

  const handleSelectOrg = async (orgId: string) => {
    setSelecting(true);
    try {
      setSelectedOrganization(orgId);
      router.push("/dashboard");
    } catch (err) {
      setError("Failed to select organization");
      setSelecting(false);
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div style={{ textAlign: "center", marginTop: "4rem" }}>
          <p>Loading organizations...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-container">
        <div style={{ maxWidth: "400px", margin: "4rem auto" }}>
          <div className="content-card">
            <div className="alert alert-danger">{error}</div>
            <button onClick={() => router.push("/auth/login")} className="btn btn-secondary">
              Back to Login
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (memberships.length === 0) {
    return (
      <div className="page-container">
        <div style={{ maxWidth: "400px", margin: "4rem auto" }}>
          <div className="content-card">
            <h1 style={{ marginBottom: "2rem" }}>No Organizations</h1>
            <div className="alert alert-info">
              You don't have access to any organizations yet. Please contact an administrator.
            </div>
            <button onClick={() => router.push("/auth/login")} className="btn btn-secondary">
              Back to Login
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <div style={{ maxWidth: "600px", margin: "4rem auto" }}>
        <div className="content-card">
          <h1 style={{ marginBottom: "2rem" }}>Select Organization</h1>

          <div className="grid grid-cols-1">
            {memberships.map((membership) => (
              <button
                key={membership.organizationId}
                onClick={() => handleSelectOrg(membership.organizationId)}
                disabled={selecting}
                style={{
                  padding: "1rem",
                  border: "1px solid #ddd",
                  borderRadius: "4px",
                  textAlign: "left",
                  cursor: selecting ? "not-allowed" : "pointer",
                  transition: "all 0.2s ease",
                  opacity: selecting ? 0.6 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!selecting) {
                    e.currentTarget.style.borderColor = "#0066cc";
                    e.currentTarget.style.backgroundColor = "#f0f4ff";
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "#ddd";
                  e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                <h3 style={{ marginBottom: "0.25rem" }}>{membership.organizationName}</h3>
                <p style={{ marginBottom: "0", color: "#6c757d", fontSize: "0.875rem" }}>
                  Role: {membership.role}
                </p>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
