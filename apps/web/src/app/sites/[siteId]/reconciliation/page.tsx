"use client";

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useEffect } from "react";
import { useRPC } from "@/lib/useRPC";

interface Reconciliation {
  id: string;
  status: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  measuredActiveKwh: string;
  measuredMaxDemandKva: string;
  expectedLandlordCents: number;
  chargedTotalCents: number;
  discrepancyVsLandlordCents: number;
  dataIntegrityStatus: string;
  gapCount: number;
  gapMinutesTotal: number;
}

export default function ReconciliationPage() {
  const params = useParams();
  const router = useRouter();
  const siteId = params.siteId as string;

  const [showGenerateForm, setShowGenerateForm] = useState(false);
  const [selectedPeriodId, setSelectedPeriodId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const { data: reconciliationsData, loading: reconLoading } = useRPC<{
    reconciliations: Reconciliation[];
    total: number;
  }>("reconciliation.list", { siteId }, [siteId]);

  const { data: periodsData, loading: periodsLoading } = useRPC<{
    periods: any[];
    total: number;
  }>("billing.periods.list", { siteId }, [siteId]);

  const handleGenerateReconciliation = async () => {
    if (!selectedPeriodId) {
      setError("Please select a billing period");
      return;
    }

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
            method: "reconciliation.generate",
            params: {
              billingPeriodId: selectedPeriodId,
            },
          }),
        },
      );

      if (!response.ok) {
        const data = await response.json();
        setError(data.error || "Generation failed");
        return;
      }

      const data = await response.json();
      router.push(`/sites/${siteId}/reconciliation/${data.reconId}`);
    } catch (err) {
      setError("Failed to generate reconciliation");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page-container">
      <Link href={`/sites/${siteId}`} style={{ color: "#0066cc", marginBottom: "1rem", display: "inline-block" }}>
        ← Back to Site
      </Link>

      <div className="flex-between" style={{ marginBottom: "2rem" }}>
        <h1>Reconciliations</h1>
        <button onClick={() => setShowGenerateForm(!showGenerateForm)} className="btn btn-primary">
          {showGenerateForm ? "Cancel" : "Generate Reconciliation"}
        </button>
      </div>

      {showGenerateForm && (
        <div className="content-card" style={{ marginBottom: "2rem" }}>
          <h2 style={{ marginBottom: "1rem" }}>Generate Reconciliation</h2>

          {error && <div className="alert alert-danger">{error}</div>}

          <div className="form-group">
            <label className="form-label">Billing Period</label>
            <select
              className="form-select"
              value={selectedPeriodId}
              onChange={(e) => setSelectedPeriodId(e.target.value)}
              disabled={loading}
            >
              <option value="">Select a period...</option>
              {periodsLoading ? (
                <option disabled>Loading periods...</option>
              ) : (
                periodsData?.periods.map((period) => (
                  <option key={period.id} value={period.id}>
                    {new Date(period.periodStart).toLocaleDateString()} -{" "}
                    {new Date(period.periodEnd).toLocaleDateString()}
                  </option>
                ))
              )}
            </select>
          </div>

          <button onClick={handleGenerateReconciliation} className="btn btn-success" disabled={loading}>
            {loading ? "Generating..." : "Generate"}
          </button>
        </div>
      )}

      <div className="content-card">
        <h2 style={{ marginBottom: "1rem" }}>Reconciliation History</h2>

        {reconLoading ? (
          <p>Loading reconciliations...</p>
        ) : reconciliationsData?.reconciliations && reconciliationsData.reconciliations.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Period</th>
                <th>Status</th>
                <th>Measured kWh</th>
                <th>Discrepancy</th>
                <th>Data Integrity</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {reconciliationsData.reconciliations.map((recon) => (
                <tr key={recon.id}>
                  <td>
                    {new Date(recon.billingPeriodStart).toLocaleDateString()} -{" "}
                    {new Date(recon.billingPeriodEnd).toLocaleDateString()}
                  </td>
                  <td>
                    <span className="badge badge-primary">{recon.status}</span>
                  </td>
                  <td>{parseFloat(recon.measuredActiveKwh).toFixed(2)} kWh</td>
                  <td style={{ color: recon.discrepancyVsLandlordCents > 0 ? "#dc3545" : "#28a745" }}>
                    R {(recon.discrepancyVsLandlordCents / 100).toFixed(2)}
                  </td>
                  <td>
                    <span
                      className={`badge ${recon.gapCount > 0 ? "badge-warning" : "badge-success"}`}
                    >
                      {recon.gapCount === 0 ? "OK" : `${recon.gapCount} gaps`}
                    </span>
                  </td>
                  <td>
                    <Link href={`/sites/${siteId}/reconciliation/${recon.id}`} className="btn btn-secondary">
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="alert alert-info">No reconciliations yet.</div>
        )}
      </div>
    </div>
  );
}
