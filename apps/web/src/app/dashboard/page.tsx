"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useSession } from "@/lib/useSession";
import { useRPC } from "@/lib/useRPC";

interface Site {
  id: string;
  name: string;
  addressLine1: string;
  city: string;
  province: string;
  status: string;
}

export default function DashboardPage() {
  const router = useRouter();
  const { session, loading: sessionLoading, error: sessionError } = useSession();
  const [organizationId, setOrganizationId] = useState<string | null>(null);

  // Fetch sites when we have the organization ID
  const { data: sitesData, loading: sitesLoading, error: sitesError } = useRPC<{
    sites: Site[];
    total: number;
  }>(
    "sites.list",
    organizationId ? { organizationId, limit: 50, offset: 0 } : undefined,
    [organizationId],
  );

  useEffect(() => {
    if (!sessionLoading && !session) {
      router.push("/auth/login");
      return;
    }

    // TODO: Get organization ID from session or user context
    // For now, use a placeholder
    if (session?.user) {
      setOrganizationId("placeholder-org-id");
    }
  }, [session, sessionLoading, router]);

  if (sessionLoading) {
    return (
      <div className="page-container">
        <div style={{ textAlign: "center", marginTop: "4rem" }}>
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return null; // Will redirect
  }

  return (
    <div className="page-container">
      <div className="flex-between" style={{ marginBottom: "2rem" }}>
        <h1>Dashboard</h1>
        <button
          onClick={async () => {
            await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/api/auth/signout`, {
              method: "POST",
              credentials: "include",
            });
            router.push("/auth/login");
          }}
          className="btn btn-secondary"
        >
          Sign Out
        </button>
      </div>

      <div className="content-card">
        <p>Welcome, {session.user.email}</p>
      </div>

      <div className="content-card">
        <div className="flex-between" style={{ marginBottom: "1.5rem" }}>
          <h2>Sites</h2>
          <Link href="/sites/new" className="btn btn-primary">
            Add Site
          </Link>
        </div>

        {sitesError && <div className="alert alert-danger">{sitesError}</div>}

        {sitesLoading ? (
          <p>Loading sites...</p>
        ) : sitesData?.sites && sitesData.sites.length > 0 ? (
          <div className="grid">
            {sitesData.sites.map((site) => (
              <Link
                key={site.id}
                href={`/sites/${site.id}`}
                style={{
                  padding: "1rem",
                  border: "1px solid #ddd",
                  borderRadius: "4px",
                  textDecoration: "none",
                  color: "inherit",
                  transition: "all 0.2s ease",
                  display: "block",
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
                <h3 style={{ marginBottom: "0.5rem" }}>{site.name}</h3>
                <p style={{ color: "#6c757d", marginBottom: "0.5rem" }}>
                  {site.addressLine1}, {site.city}, {site.province}
                </p>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <span className="badge badge-primary">{site.status}</span>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="alert alert-info">
            No sites yet.{" "}
            <Link href="/sites/new" style={{ color: "#0066cc", fontWeight: "500" }}>
              Create your first site
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
