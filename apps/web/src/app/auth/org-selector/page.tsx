"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Org {
  id: string;
  name: string;
}

export default function OrgSelectorPage() {
  const router = useRouter();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [session, setSession] = useState<any>(null);

  useEffect(() => {
    const loadSession = async () => {
      try {
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/api/auth/get-session`,
          {
            credentials: "include",
          },
        );

        if (!response.ok) {
          router.push("/auth/login");
          return;
        }

        const sessionData = await response.json();
        setSession(sessionData);

        // For now, if user is logged in, redirect to dashboard
        // TODO: Implement org selection based on user's memberships
        if (sessionData.user) {
          // If only one org, redirect directly
          // Otherwise show selector
          router.push("/dashboard");
        }
      } catch (err) {
        setError("Failed to load session");
        router.push("/auth/login");
      } finally {
        setLoading(false);
      }
    };

    loadSession();
  }, [router]);

  if (loading) {
    return (
      <div className="page-container">
        <div style={{ textAlign: "center", marginTop: "4rem" }}>
          <p>Loading...</p>
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

          {orgs.length === 0 ? (
            <div className="alert alert-info">
              No organizations found. Please create or join an organization.
            </div>
          ) : (
            <div className="grid grid-cols-1">
              {orgs.map((org) => (
                <button
                  key={org.id}
                  onClick={() => {
                    // TODO: Set selected org in session/context
                    router.push("/dashboard");
                  }}
                  style={{
                    padding: "1rem",
                    border: "1px solid #ddd",
                    borderRadius: "4px",
                    textAlign: "left",
                    cursor: "pointer",
                    transition: "all 0.2s ease",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "#0066cc";
                    e.currentTarget.style.backgroundColor = "#f0f4ff";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "#ddd";
                    e.currentTarget.style.backgroundColor = "transparent";
                  }}
                >
                  <h3 style={{ marginBottom: "0" }}>{org.name}</h3>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
