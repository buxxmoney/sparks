"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useRPC } from "@/lib/useRPC";

interface Site {
  id: string;
  name: string;
  addressLine1: string;
  city: string;
  province: string;
  supplyZone: string;
  timezone: string;
  status: string;
}

export default function SiteDetailsPage() {
  const params = useParams();
  const siteId = params.siteId as string;

  const { data: site, loading, error } = useRPC<Site>("sites.get", { siteId }, [siteId]);

  if (loading) {
    return (
      <div className="page-container">
        <p>Loading site details...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-container">
        <div className="alert alert-danger">{error}</div>
      </div>
    );
  }

  if (!site) {
    return (
      <div className="page-container">
        <div className="alert alert-danger">Site not found</div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <Link href="/dashboard" style={{ color: "#0066cc", marginBottom: "1rem", display: "inline-block" }}>
        ← Back to Dashboard
      </Link>

      <h1 style={{ marginBottom: "2rem" }}>{site.name}</h1>

      <div className="content-card">
        <h2 style={{ marginBottom: "1rem" }}>Site Information</h2>
        <div className="grid grid-cols-2">
          <div>
            <p style={{ color: "#6c757d", marginBottom: "0.25rem" }}>Address</p>
            <p>
              {site.addressLine1}
              <br />
              {site.city}, {site.province}
            </p>
          </div>
          <div>
            <p style={{ color: "#6c757d", marginBottom: "0.25rem" }}>Supply Zone</p>
            <p>{site.supplyZone}</p>
          </div>
          <div>
            <p style={{ color: "#6c757d", marginBottom: "0.25rem" }}>Timezone</p>
            <p>{site.timezone}</p>
          </div>
          <div>
            <p style={{ color: "#6c757d", marginBottom: "0.25rem" }}>Status</p>
            <span className="badge badge-success">{site.status}</span>
          </div>
        </div>
      </div>

      <div className="content-card">
        <h2 style={{ marginBottom: "1rem" }}>Quick Actions</h2>
        <div className="grid grid-cols-2">
          <Link href={`/sites/${siteId}/invoices`} className="btn btn-primary">
            Manage Invoices
          </Link>
          <Link href={`/sites/${siteId}/reconciliation`} className="btn btn-primary">
            View Reconciliations
          </Link>
        </div>
      </div>
    </div>
  );
}
