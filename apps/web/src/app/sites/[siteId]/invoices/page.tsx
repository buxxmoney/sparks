"use client";

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useEffect } from "react";
import { useRPC } from "@/lib/useRPC";

interface BillingPeriod {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: string;
}

interface Invoice {
  id: string;
  status: string;
  uploadedAt: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
}

export default function InvoicesPage() {
  const params = useParams();
  const router = useRouter();
  const siteId = params.siteId as string;

  const [showUploadForm, setShowUploadForm] = useState(false);
  const [selectedPeriodId, setSelectedPeriodId] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [uploadLoading, setUploadLoading] = useState(false);

  const { data: invoicesData, loading: invoicesLoading } = useRPC<{
    invoices: Invoice[];
    total: number;
  }>("invoices.list", { siteId }, [siteId]);

  const { data: periodsData, loading: periodsLoading } = useRPC<{
    periods: BillingPeriod[];
    total: number;
  }>("billing.periods.list", { siteId }, [siteId]);

  const handleUploadClick = async () => {
    if (!selectedPeriodId) {
      setUploadError("Please select a billing period");
      return;
    }

    setUploadLoading(true);
    setUploadError("");

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/rpc/call`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({
            method: "invoices.createUpload",
            params: {
              siteId,
              billingPeriodId: selectedPeriodId,
            },
          }),
        },
      );

      if (!response.ok) {
        const data = await response.json();
        setUploadError(data.error || "Upload failed");
        return;
      }

      const data = await response.json();
      // In a real app, we'd use the presigned URL to upload the file
      // For now, just redirect to the invoice review page
      router.push(`/sites/${siteId}/invoices/${data.invoiceId}`);
    } catch (err) {
      setUploadError("Failed to create invoice upload");
    } finally {
      setUploadLoading(false);
    }
  };

  return (
    <div className="page-container">
      <Link href={`/sites/${siteId}`} style={{ color: "#0066cc", marginBottom: "1rem", display: "inline-block" }}>
        ← Back to Site
      </Link>

      <div className="flex-between" style={{ marginBottom: "2rem" }}>
        <h1>Invoices</h1>
        <button onClick={() => setShowUploadForm(!showUploadForm)} className="btn btn-primary">
          {showUploadForm ? "Cancel" : "Upload Invoice"}
        </button>
      </div>

      {showUploadForm && (
        <div className="content-card" style={{ marginBottom: "2rem" }}>
          <h2 style={{ marginBottom: "1rem" }}>Upload Invoice</h2>

          {uploadError && <div className="alert alert-danger">{uploadError}</div>}

          <div className="form-group">
            <label className="form-label">Billing Period</label>
            <select
              className="form-select"
              value={selectedPeriodId}
              onChange={(e) => setSelectedPeriodId(e.target.value)}
              disabled={uploadLoading}
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

          <button onClick={handleUploadClick} className="btn btn-success" disabled={uploadLoading}>
            {uploadLoading ? "Processing..." : "Create Upload"}
          </button>
        </div>
      )}

      <div className="content-card">
        <h2 style={{ marginBottom: "1rem" }}>Invoice History</h2>

        {invoicesLoading ? (
          <p>Loading invoices...</p>
        ) : invoicesData?.invoices && invoicesData.invoices.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Period</th>
                <th>Status</th>
                <th>Uploaded</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {invoicesData.invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td>
                    {new Date(invoice.billingPeriodStart).toLocaleDateString()} -{" "}
                    {new Date(invoice.billingPeriodEnd).toLocaleDateString()}
                  </td>
                  <td>
                    <span className="badge badge-primary">{invoice.status}</span>
                  </td>
                  <td>{new Date(invoice.uploadedAt).toLocaleDateString()}</td>
                  <td>
                    <Link href={`/sites/${siteId}/invoices/${invoice.id}`} className="btn btn-secondary">
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="alert alert-info">No invoices yet.</div>
        )}
      </div>
    </div>
  );
}
