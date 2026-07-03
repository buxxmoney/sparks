"use client";

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { useRPC } from "@/lib/useRPC";

interface Reconciliation {
  id: string;
  status: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  measuredActiveKwh: string;
  measuredMaxDemandKva: string;
  measuredReactiveKvarh: string;
  expectedLandlordCents: number;
  expectedCeilingCents: number;
  chargedTotalCents: number;
  discrepancyVsLandlordCents: number;
  discrepancyVsCeilingCents: number;
  dataIntegrityStatus: string;
  gapCount: number;
  gapMinutesTotal: number;
  pdfStorageKey?: string;
  pdfHash?: string;
  version: number;
}

export default function ReconciliationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const siteId = params.siteId as string;
  const reconId = params.reconId as string;

  const [finalizeLoading, setFinalizeLoading] = useState(false);
  const [error, setError] = useState("");

  const { data: recon, loading } = useRPC<Reconciliation>("reconciliation.get", { reconId }, [
    reconId,
  ]);

  const handleFinalize = async () => {
    setFinalizeLoading(true);
    setError("");

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/rpc/call`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            method: "reconciliation.finalize",
            params: { reconId },
          }),
        },
      );

      if (!response.ok) {
        const data = await response.json();
        setError(data.error || "Finalize failed");
        return;
      }

      router.refresh();
    } catch (err) {
      setError("Failed to finalize reconciliation");
    } finally {
      setFinalizeLoading(false);
    }
  };

  const handleDownloadPDF = async () => {
    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/rpc/call`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            method: "report.getPdf",
            params: { reconId },
          }),
        },
      );

      if (!response.ok) {
        setError("Failed to get PDF");
        return;
      }

      const data = await response.json();
      // In a real app, use the presignedUrl to download
      window.open(data.presignedUrl, "_blank");
    } catch (err) {
      setError("Failed to download PDF");
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <p>Loading reconciliation...</p>
      </div>
    );
  }

  if (!recon) {
    return (
      <div className="page-container">
        <div className="alert alert-danger">Reconciliation not found</div>
      </div>
    );
  }

  const hasDG = recon.gapCount > 0;
  const discrepancy = recon.discrepancyVsLandlordCents;

  return (
    <div className="page-container">
      <Link href={`/sites/${siteId}/reconciliation`} style={{ color: "#0066cc", marginBottom: "1rem", display: "inline-block" }}>
        ← Back to Reconciliations
      </Link>

      <div className="flex-between" style={{ marginBottom: "2rem" }}>
        <h1>Reconciliation Report</h1>
        <span className="badge badge-primary">{recon.status}</span>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}

      {/* Data Integrity Alert */}
      {hasDG && (
        <div className="alert alert-warning">
          <strong>⚠ Data Gaps Detected</strong>
          <p>
            {recon.gapCount} gap{recon.gapCount > 1 ? "s" : ""} totaling {recon.gapMinutesTotal} minutes
          </p>
          <p style={{ marginBottom: 0, fontSize: "0.875rem" }}>
            Data integrity status: <strong>{recon.dataIntegrityStatus}</strong>
          </p>
        </div>
      )}

      {/* Billing Period */}
      <div className="content-card">
        <h2 style={{ marginBottom: "1rem" }}>Billing Period</h2>
        <p>
          {new Date(recon.billingPeriodStart).toLocaleDateString()} -{" "}
          {new Date(recon.billingPeriodEnd).toLocaleDateString()}
        </p>
      </div>

      {/* Measured Data */}
      <div className="content-card">
        <h2 style={{ marginBottom: "1rem" }}>Measured Data</h2>
        <div className="grid grid-cols-3">
          <div>
            <p style={{ color: "#6c757d", marginBottom: "0.25rem" }}>Active Energy</p>
            <p style={{ fontSize: "1.25rem", fontWeight: "600" }}>
              {parseFloat(recon.measuredActiveKwh).toFixed(2)} kWh
            </p>
          </div>
          <div>
            <p style={{ color: "#6c757d", marginBottom: "0.25rem" }}>Max Demand</p>
            <p style={{ fontSize: "1.25rem", fontWeight: "600" }}>
              {parseFloat(recon.measuredMaxDemandKva).toFixed(2)} kVA
            </p>
          </div>
          <div>
            <p style={{ color: "#6c757d", marginBottom: "0.25rem" }}>Reactive Energy</p>
            <p style={{ fontSize: "1.25rem", fontWeight: "600" }}>
              {parseFloat(recon.measuredReactiveKvarh).toFixed(2)} kVArh
            </p>
          </div>
        </div>
      </div>

      {/* Tariff Comparison */}
      <div className="content-card">
        <h2 style={{ marginBottom: "1rem" }}>Tariff Comparison</h2>
        <div className="grid grid-cols-3">
          <div>
            <p style={{ color: "#6c757d", marginBottom: "0.25rem" }}>Expected (Landlord)</p>
            <p style={{ fontSize: "1.25rem", fontWeight: "600" }}>
              R {(recon.expectedLandlordCents / 100).toFixed(2)}
            </p>
          </div>
          <div>
            <p style={{ color: "#6c757d", marginBottom: "0.25rem" }}>Charged</p>
            <p style={{ fontSize: "1.25rem", fontWeight: "600" }}>
              R {(recon.chargedTotalCents / 100).toFixed(2)}
            </p>
          </div>
          <div>
            <p style={{ color: "#6c757d", marginBottom: "0.25rem" }}>Discrepancy</p>
            <p
              style={{
                fontSize: "1.25rem",
                fontWeight: "600",
                color: discrepancy > 0 ? "#dc3545" : "#28a745",
              }}
            >
              {discrepancy > 0 ? "+" : ""}R {(discrepancy / 100).toFixed(2)}
            </p>
          </div>
        </div>

        {recon.expectedCeilingCents > 0 && (
          <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid #ddd" }}>
            <p style={{ color: "#6c757d", marginBottom: "0.5rem" }}>Legal Ceiling Comparison</p>
            <p style={{ marginBottom: "0" }}>
              Expected: R {(recon.expectedCeilingCents / 100).toFixed(2)}
              {" | "}
              Discrepancy: R {(recon.discrepancyVsCeilingCents / 100).toFixed(2)}
            </p>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="content-card">
        <h2 style={{ marginBottom: "1rem" }}>Actions</h2>
        <div className="flex" style={{ gap: "1rem" }}>
          {recon.status === "draft" && (
            <button onClick={handleFinalize} className="btn btn-success" disabled={finalizeLoading}>
              {finalizeLoading ? "Finalizing..." : "Finalize Reconciliation"}
            </button>
          )}
          {recon.pdfHash && (
            <button onClick={handleDownloadPDF} className="btn btn-primary">
              Download PDF Report
            </button>
          )}
        </div>
      </div>

      {/* Metadata */}
      <div className="content-card">
        <h2 style={{ marginBottom: "1rem" }}>Metadata</h2>
        <div className="grid grid-cols-2">
          <div>
            <p style={{ color: "#6c757d", marginBottom: "0.25rem" }}>Status</p>
            <p>{recon.status}</p>
          </div>
          <div>
            <p style={{ color: "#6c757d", marginBottom: "0.25rem" }}>Version</p>
            <p>{recon.version}</p>
          </div>
          <div>
            <p style={{ color: "#6c757d", marginBottom: "0.25rem" }}>Data Integrity</p>
            <p>{recon.dataIntegrityStatus}</p>
          </div>
          <div>
            <p style={{ color: "#6c757d", marginBottom: "0.25rem" }}>Data Gaps</p>
            <p>
              {recon.gapCount} gap{recon.gapCount > 1 ? "s" : ""} ({recon.gapMinutesTotal} min)
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
