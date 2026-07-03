"use client";

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useEffect } from "react";
import { useRPC } from "@/lib/useRPC";

interface LineItem {
  id: string;
  parsedCategory: string;
  parsedValueCents: number;
  confidence: number;
  confirmedCategory?: string;
  confirmedValueCents?: number;
}

interface Invoice {
  id: string;
  status: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  confirmedActiveCents?: number;
  confirmedDemandCents?: number;
  confirmedReactiveCents?: number;
  confirmedFixedCents?: number;
  confirmedTotalCents?: number;
}

export default function InvoiceDetailPage() {
  const params = useParams();
  const router = useRouter();
  const siteId = params.siteId as string;
  const invoiceId = params.invoiceId as string;

  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [error, setError] = useState("");
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [lockLoading, setLockLoading] = useState(false);

  const { data: invoice, loading: invoiceLoading } = useRPC<Invoice>(
    "invoices.get",
    { invoiceId },
    [invoiceId],
  );

  useEffect(() => {
    if (invoice && invoice.status === "parsed_pending_confirm") {
      const fetchLineItems = async () => {
        try {
          const response = await fetch(
            `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/rpc/call`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                method: "invoices.listLineItems",
                params: { invoiceId },
              }),
            },
          );

          if (response.ok) {
            const data = await response.json();
            setLineItems(data.lineItems || []);
          }
        } catch (err) {
          console.error("Failed to load line items", err);
        }
      };

      fetchLineItems();
    }
  }, [invoice, invoiceId]);

  const handleLineItemChange = (itemId: string, field: string, value: any) => {
    setLineItems((items) =>
      items.map((item) => (item.id === itemId ? { ...item, [field]: value } : item)),
    );
  };

  const handleConfirm = async () => {
    setConfirmLoading(true);
    setError("");

    try {
      // Update all line items
      for (const item of lineItems) {
        if (item.confirmedCategory || item.confirmedValueCents) {
          await fetch(
            `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/rpc/call`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                method: "invoices.updateLineItem",
                params: {
                  lineItemId: item.id,
                  confirmedCategory: item.confirmedCategory,
                  confirmedValueCents: item.confirmedValueCents,
                },
              }),
            },
          );
        }
      }

      // Calculate totals
      let totalCents = 0;
      let activeCents = 0;
      let demandCents = 0;
      let reactiveCents = 0;
      let fixedCents = 0;

      for (const item of lineItems) {
        const value = item.confirmedValueCents || item.parsedValueCents;
        const category = item.confirmedCategory || item.parsedCategory;

        if (category === "active_energy") activeCents += value;
        else if (category === "demand") demandCents += value;
        else if (category === "reactive_energy") reactiveCents += value;
        else if (category === "fixed") fixedCents += value;

        totalCents += value;
      }

      // Confirm invoice
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/rpc/call`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            method: "invoices.confirm",
            params: {
              invoiceId,
              confirmedActiveCents: activeCents,
              confirmedDemandCents: demandCents,
              confirmedReactiveCents: reactiveCents,
              confirmedFixedCents: fixedCents,
              confirmedTotalCents: totalCents,
            },
          }),
        },
      );

      if (!response.ok) {
        const data = await response.json();
        setError(data.error || "Confirmation failed");
        return;
      }

      // Refresh invoice data
      router.refresh();
    } catch (err) {
      setError("Failed to confirm invoice");
    } finally {
      setConfirmLoading(false);
    }
  };

  const handleLock = async () => {
    setLockLoading(true);
    setError("");

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/rpc/call`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            method: "invoices.lock",
            params: { invoiceId },
          }),
        },
      );

      if (!response.ok) {
        const data = await response.json();
        setError(data.error || "Lock failed");
        return;
      }

      router.refresh();
    } catch (err) {
      setError("Failed to lock invoice");
    } finally {
      setLockLoading(false);
    }
  };

  if (invoiceLoading) {
    return (
      <div className="page-container">
        <p>Loading invoice...</p>
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="page-container">
        <div className="alert alert-danger">Invoice not found</div>
      </div>
    );
  }

  const isNeedsReview = invoice.status === "uploaded";
  const isPendingConfirm = invoice.status === "parsed_pending_confirm";
  const isConfirmed = invoice.status === "confirmed";
  const isLocked = invoice.status === "locked";

  return (
    <div className="page-container">
      <Link href={`/sites/${siteId}/invoices`} style={{ color: "#0066cc", marginBottom: "1rem", display: "inline-block" }}>
        ← Back to Invoices
      </Link>

      <div className="flex-between" style={{ marginBottom: "2rem" }}>
        <h1>Invoice Review</h1>
        <span className="badge badge-primary">{invoice.status}</span>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}

      <div className="content-card">
        <h2 style={{ marginBottom: "1rem" }}>Billing Period</h2>
        <p>
          {new Date(invoice.billingPeriodStart).toLocaleDateString()} -{" "}
          {new Date(invoice.billingPeriodEnd).toLocaleDateString()}
        </p>
      </div>

      {isPendingConfirm && (
        <div className="content-card">
          <h2 style={{ marginBottom: "1rem" }}>Review Line Items</h2>

          <div className="alert alert-info">
            Review the parsed line items below. Items with low confidence (&lt; 80%) are highlighted.
          </div>

          {lineItems.length > 0 ? (
            <table style={{ marginTop: "1rem" }}>
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Confidence</th>
                  <th>Value</th>
                  <th>Corrected Category</th>
                  <th>Corrected Value</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((item) => (
                  <tr
                    key={item.id}
                    style={{
                      backgroundColor: item.confidence < 80 ? "#fff3cd" : "transparent",
                    }}
                  >
                    <td>{item.parsedCategory}</td>
                    <td>
                      <div style={{ width: "100px" }}>
                        <div style={{ background: "#ddd", height: "4px", borderRadius: "2px", overflow: "hidden" }}>
                          <div
                            style={{
                              background: item.confidence < 80 ? "#ffc107" : "#28a745",
                              height: "100%",
                              width: `${item.confidence}%`,
                            }}
                          />
                        </div>
                        <small>{item.confidence}%</small>
                      </div>
                    </td>
                    <td>R {(item.parsedValueCents / 100).toFixed(2)}</td>
                    <td>
                      <select
                        className="form-select"
                        value={item.confirmedCategory || ""}
                        onChange={(e) => handleLineItemChange(item.id, "confirmedCategory", e.target.value)}
                        style={{ width: "150px" }}
                      >
                        <option value="">Use parsed</option>
                        <option value="active_energy">Active Energy</option>
                        <option value="demand">Demand</option>
                        <option value="reactive_energy">Reactive Energy</option>
                        <option value="fixed">Fixed</option>
                        <option value="ancillary">Ancillary</option>
                      </select>
                    </td>
                    <td>
                      <input
                        type="number"
                        className="form-input"
                        value={item.confirmedValueCents || ""}
                        onChange={(e) => handleLineItemChange(item.id, "confirmedValueCents", parseInt(e.target.value) || 0)}
                        placeholder="Cents"
                        style={{ width: "100px" }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No line items found.</p>
          )}

          <div style={{ marginTop: "2rem", display: "flex", gap: "1rem" }}>
            <button onClick={handleConfirm} className="btn btn-success" disabled={confirmLoading}>
              {confirmLoading ? "Confirming..." : "Confirm & Lock"}
            </button>
          </div>
        </div>
      )}

      {isConfirmed && (
        <div className="content-card">
          <h2 style={{ marginBottom: "1rem" }}>Confirmed Amounts</h2>
          <div className="grid grid-cols-2">
            <div>
              <p style={{ color: "#6c757d" }}>Active Energy</p>
              <p>R {(invoice.confirmedActiveCents! / 100).toFixed(2)}</p>
            </div>
            <div>
              <p style={{ color: "#6c757d" }}>Demand</p>
              <p>R {(invoice.confirmedDemandCents! / 100).toFixed(2)}</p>
            </div>
            <div>
              <p style={{ color: "#6c757d" }}>Reactive Energy</p>
              <p>R {(invoice.confirmedReactiveCents! / 100).toFixed(2)}</p>
            </div>
            <div>
              <p style={{ color: "#6c757d" }}>Fixed</p>
              <p>R {(invoice.confirmedFixedCents! / 100).toFixed(2)}</p>
            </div>
          </div>

          <div style={{ marginTop: "1.5rem", paddingTop: "1.5rem", borderTop: "1px solid #ddd" }}>
            <p style={{ fontSize: "1.25rem", fontWeight: "600" }}>
              Total: R {(invoice.confirmedTotalCents! / 100).toFixed(2)}
            </p>
          </div>

          <div style={{ marginTop: "2rem", display: "flex", gap: "1rem" }}>
            <button onClick={handleLock} className="btn btn-success" disabled={lockLoading}>
              {lockLoading ? "Locking..." : "Lock Invoice"}
            </button>
          </div>
        </div>
      )}

      {isLocked && (
        <div className="content-card">
          <div className="alert alert-success">Invoice is locked and ready for reconciliation.</div>
          <Link href={`/sites/${siteId}/reconciliation`} className="btn btn-primary">
            View Reconciliation
          </Link>
        </div>
      )}
    </div>
  );
}
