"use client";

import { METRIC_HINTS, MetricStat, formatReading } from "@/components/metric";
import { client } from "@/lib/client";
import { useRPC } from "@/lib/useRPC";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Stack } from "@astryxdesign/core/Stack";
import { Table } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { ArrowLeft } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

function fmtRand(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `R ${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("en-ZA", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// One calculation line as the engine reports it (pricing.details rows).
interface CalcDetail {
  chargeType: string;
  rateValue: number;
  unit: string;
  season: string;
  touPeriod: string;
  amountCents: number;
  quantity?: number;
  quantityUnit?: string;
  note?: string;
}

const CHARGE_LABEL: Record<string, string> = {
  active_energy: "Active energy",
  demand: "Demand",
  reactive_energy: "Reactive energy",
  ancillary: "Per-kWh surcharge",
  fixed: "Fixed charge",
  surcharge: "Business surcharge",
};

function detailLabel(d: CalcDetail): string {
  const label = CHARGE_LABEL[d.chargeType] ?? d.chargeType;
  const tags = [
    d.season !== "all" ? (d.season === "high" ? "winter" : "summer") : null,
    d.touPeriod !== "all" ? d.touPeriod : null,
  ].filter(Boolean);
  return tags.length > 0 ? `${label} (${tags.join(", ")})` : label;
}

// "10,223.157 kWh × R2.6141 = R26,724.35" — mirrors how the landlord's bill
// prints each line, so the two can be compared side by side.
function detailFormula(d: CalcDetail): string {
  const amount = fmtRand(d.amountCents);
  if (d.chargeType === "surcharge") {
    return `${(d.rateValue * 100).toFixed(2).replace(/\.?0+$/, "")}% × ${fmtRand(Math.round((d.quantity ?? 0) * 100))} = ${amount}`;
  }
  if (d.quantityUnit === "month") {
    return `${amount} per month`;
  }
  const qty =
    d.quantity != null ? d.quantity.toLocaleString("en-US", { maximumFractionDigits: 3 }) : "—";
  // Rates are stored as published (cents for c_per_* units); display in Rand so
  // the formula reads like the landlord's bill (e.g. "× R2.6141").
  const rateRand = d.unit.startsWith("c_per_") ? d.rateValue / 100 : d.rateValue;
  const rateStr = Number(rateRand.toFixed(6)).toString();
  return `${qty} ${d.quantityUnit ?? ""} × R${rateStr} = ${amount}`;
}

// Plain-language caption for how the current period's dates were decided.
const BASIS_CAPTION: Record<string, string> = {
  billing_period: "your site's billing period",
  policy: "the billing cycle saved in Settings",
  inferred_from_invoice: "the cycle on your last invoice",
  calendar_month: "the calendar month — set your billing cycle in Settings for exact dates",
};

export default function CurrentBillPage() {
  const params = useParams();
  const siteId = params.siteId as string;

  const [showCalc, setShowCalc] = useState(false);
  // The estimate moves as readings arrive (~1/min); refresh on a slow poll.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const { data, loading, error } = useRPC(
    () => client.billing.currentEstimate({ siteId }),
    [siteId, tick],
  );

  const landlord = data?.landlord ?? null;
  const ceiling = data?.ceiling ?? null;
  // The landlord tariff is what the tenant actually pays; the legal ceiling is
  // the comparison bound. Lead with landlord when it's on file.
  const primary = landlord ?? ceiling;

  // When the tariff's minimum-demand floor (City Power LPU LV: 70 kVA) bills more
  // than the meter actually recorded, the server prices the "on your actual demand"
  // scenario too — so we can show the realistic bill AND quantify what the reserved-
  // capacity minimum is costing (the single most actionable number on the page).
  const demandFloor = primary?.demandFloor ?? null;

  // The basis of each charge, taken from the primary role's priced detail lines, so
  // every amount in the table shows where it came from (quantity × rate) — otherwise
  // the demand line (billed at a fixed minimum, not the measured peak) looks wrong.
  const details = primary?.pricing.details ?? [];
  const basisFor = (chargeType: string): string | null => {
    const matches = details.filter((d) => d.chargeType === chargeType);
    if (matches.length === 0) return null;
    if (matches.length > 1) return `${matches.length} charges combined`;
    const d = matches[0];
    if (d.quantity == null) return null;
    const rateRand = d.unit.startsWith("c_per_") ? d.rateValue / 100 : d.rateValue;
    const qty = d.quantity.toLocaleString("en-US", { maximumFractionDigits: 3 });
    return `${qty} ${d.quantityUnit ?? ""} × R${Number(rateRand.toFixed(6))}`;
  };
  const measuredPeak = data ? Number.parseFloat(data.usage.maxDemandKva) : 0;

  // One row per bill line the SA tariffs produce; rows that are zero for both
  // roles are dropped so a simple tariff shows a simple table.
  const allRows = primary
    ? [
        {
          key: "active",
          label: "Active energy",
          basis: basisFor("active_energy"),
          landlordCents: landlord ? landlord.pricing.activeEnergyCents : null,
          ceilingCents: ceiling ? ceiling.pricing.activeEnergyCents : null,
        },
        {
          key: "demand",
          label: "Demand",
          // Demand bills on the tariff's minimum when it exceeds the measured peak,
          // so spell out the billed kVA and flag that it isn't the metered peak.
          basis: demandFloor
            ? `${demandFloor.billedDemandKva} kVA tariff minimum × R${primary.pricing.details.find((d) => d.chargeType === "demand")?.rateValue ?? ""} (your peak was only ${measuredPeak.toFixed(2)} kVA)`
            : basisFor("demand"),
          landlordCents: landlord ? landlord.pricing.demandCents : null,
          ceilingCents: ceiling ? ceiling.pricing.demandCents : null,
        },
        {
          key: "reactive",
          label: "Reactive energy",
          basis: basisFor("reactive_energy"),
          landlordCents: landlord ? landlord.pricing.reactiveEnergyCents : null,
          ceilingCents: ceiling ? ceiling.pricing.reactiveEnergyCents : null,
        },
        {
          key: "riders",
          label: "Per-kWh surcharges",
          basis: basisFor("ancillary"),
          landlordCents: landlord ? landlord.pricing.ancillaryCents : null,
          ceilingCents: ceiling ? ceiling.pricing.ancillaryCents : null,
        },
        {
          key: "fixed",
          label: "Fixed / service",
          basis: "Flat monthly charges",
          landlordCents: landlord ? landlord.pricing.fixedCents : null,
          ceilingCents: ceiling ? ceiling.pricing.fixedCents : null,
        },
        {
          key: "surcharge",
          label: "Business surcharge",
          basis: primary.pricing.surchargeCents
            ? "2% levy on energy, demand, reactive & fixed"
            : null,
          landlordCents: landlord ? landlord.pricing.surchargeCents : null,
          ceilingCents: ceiling ? ceiling.pricing.surchargeCents : null,
        },
        {
          key: "vat",
          label: "VAT",
          basis: primary.pricing.vatCents ? `15% of ${fmtRand(primary.pricing.totalCents)}` : null,
          landlordCents: landlord ? landlord.pricing.vatCents : null,
          ceilingCents: ceiling ? ceiling.pricing.vatCents : null,
        },
        {
          key: "total",
          label: "Total",
          basis: null,
          landlordCents: landlord ? landlord.pricing.totalInclVatCents : null,
          ceilingCents: ceiling ? ceiling.pricing.totalInclVatCents : null,
        },
      ]
    : [];
  const breakdownRows = allRows.filter(
    (r) => r.key === "total" || (r.landlordCents ?? 0) > 0 || (r.ceilingCents ?? 0) > 0,
  );

  return (
    <Stack gap={5}>
      <Stack gap={2}>
        <Link href={`/sites/${siteId}`}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ArrowLeft size={16} /> Back to site
          </span>
        </Link>
        <Heading level={2}>Current bill</Heading>
        {data ? (
          <Text type="supporting">
            {fmtDate(data.period.periodStart)} – {fmtDate(data.period.periodEnd)}, based on{" "}
            {BASIS_CAPTION[data.period.basis] ?? "the calendar month"}.
          </Text>
        ) : null}
      </Stack>

      {error ? <Banner status="error" title={error} /> : null}

      {loading && !data ? (
        <Stack gap={2}>
          <Skeleton height={120} />
          <Skeleton height={80} />
        </Stack>
      ) : data ? (
        <>
          {demandFloor ? (
            <Banner
              status="info"
              title={`This tariff bills demand on a ${demandFloor.billedDemandKva} kVA minimum. Your metered peak this period was ${demandFloor.measuredDemandKva.toFixed(0)} kVA, so about ${fmtRand(demandFloor.extraInclVatCents)} of this estimate is the demand minimum rather than your measured usage.`}
            />
          ) : null}

          {primary ? (
            <Card padding={5}>
              <Stack gap={4}>
                {primary.tariff ? (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "baseline",
                      gap: "4px 10px",
                      paddingBottom: 12,
                      borderBottom: "1px solid var(--color-border, #e5e5e5)",
                    }}
                  >
                    <Text type="supporting">Priced on the tariff</Text>
                    <Text weight="semibold">{primary.tariff.name}</Text>
                    {primary.tariff.distributor ? (
                      <Text type="supporting">· {primary.tariff.distributor}</Text>
                    ) : null}
                    <Text type="supporting">
                      · effective {fmtDate(primary.tariff.effectiveFrom)}
                    </Text>
                  </div>
                ) : null}

                <div style={{ display: "flex", flexWrap: "wrap", gap: 32, alignItems: "flex-end" }}>
                  <MetricStat
                    label={landlord ? "Charges so far" : "Legal maximum so far"}
                    hint={
                      landlord
                        ? "What your usage this period costs so far under the tariff your landlord charges, computed live from your meter. The same calculation we use to check your invoice later."
                        : "No landlord tariff is on file yet, so this shows the most you can legally be charged for the usage so far under the regulated ceiling tariff."
                    }
                    value={fmtRand(primary.pricing.totalInclVatCents)}
                    size="lg"
                  />
                  {primary.projectedTotalInclVatCents != null ? (
                    <MetricStat
                      label="Projected at period end"
                      hint="Energy charges extended at your current rate of use to the end of the period. Demand and fixed charges are already committed, so treat this as a floor — the peak can still rise."
                      value={fmtRand(primary.projectedTotalInclVatCents)}
                      size="md"
                    />
                  ) : null}
                  {landlord && ceiling ? (
                    <MetricStat
                      label="Legal ceiling"
                      hint="The most you could legally be charged for the same usage under the regulated ceiling tariff."
                      value={fmtRand(ceiling.pricing.totalInclVatCents)}
                      size="md"
                    />
                  ) : null}
                </div>

                <Table
                  data={breakdownRows}
                  columns={[
                    {
                      key: "label",
                      header: "Charge",
                      renderCell: (r) => (
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <Text weight="medium">{r.label}</Text>
                          {r.basis ? <Text type="supporting">{r.basis}</Text> : null}
                        </div>
                      ),
                    },
                    ...(landlord
                      ? [
                          {
                            key: "landlord",
                            header: "So far",
                            renderCell: (r: (typeof breakdownRows)[number]) =>
                              r.key === "total" ? (
                                <Text weight="semibold">{fmtRand(r.landlordCents)}</Text>
                              ) : (
                                <Text>{fmtRand(r.landlordCents)}</Text>
                              ),
                          },
                        ]
                      : []),
                    ...(ceiling
                      ? [
                          {
                            key: "ceiling",
                            header: landlord ? "Legal ceiling" : "So far",
                            renderCell: (r: (typeof breakdownRows)[number]) =>
                              r.key === "total" ? (
                                <Text weight="semibold">{fmtRand(r.ceilingCents)}</Text>
                              ) : (
                                <Text>{fmtRand(r.ceilingCents)}</Text>
                              ),
                          },
                        ]
                      : []),
                  ]}
                  density="compact"
                  dividers="rows"
                />

                <Text type="supporting">
                  Estimate from your meter and the tariff on file. Line items your landlord adds
                  outside the tariff (e.g. rooftop-solar recovery) are not included, so the invoice
                  total can differ slightly.
                </Text>

                <div>
                  <Button
                    label={showCalc ? "Hide the calculation" : "How we calculated this"}
                    variant="secondary"
                    size="sm"
                    onClick={() => setShowCalc((v) => !v)}
                  />
                </div>

                {showCalc ? (
                  <Stack gap={4}>
                    <Stack gap={2}>
                      <Text weight="semibold">The arithmetic, line by line</Text>
                      {primary.pricing.details.map((d, i) => (
                        <div
                          key={`${d.chargeType}-${d.season}-${d.touPeriod}-${i}`}
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                            borderTop: "1px solid var(--color-border, #e5e5e5)",
                            paddingTop: 12,
                          }}
                        >
                          <Text weight="medium">{detailLabel(d)}</Text>
                          <Text type="supporting">{detailFormula(d)}</Text>
                          {d.note ? <Text type="supporting">{d.note}</Text> : null}
                        </div>
                      ))}
                      {primary.pricing.vatCents > 0 ? (
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                            borderTop: "1px solid var(--color-border, #e5e5e5)",
                            paddingTop: 12,
                          }}
                        >
                          <Text weight="medium">VAT</Text>
                          <Text type="supporting">
                            15% × {fmtRand(primary.pricing.totalCents)} ={" "}
                            {fmtRand(primary.pricing.vatCents)}
                          </Text>
                        </div>
                      ) : null}
                      <div
                        style={{
                          borderTop: "1px solid var(--color-border, #e5e5e5)",
                          paddingTop: 8,
                        }}
                      >
                        <Text weight="semibold">
                          Total: {fmtRand(primary.pricing.totalInclVatCents)}
                        </Text>
                      </div>
                    </Stack>

                    {primary.sources.length > 0 ? (
                      <Stack gap={2}>
                        <Text weight="semibold">Where these rules come from</Text>
                        {primary.sources.map((s, i) => (
                          <div
                            key={`${s.title}-${i}`}
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: 4,
                              borderLeft: "2px solid var(--color-border, #d4d4d4)",
                              paddingLeft: 12,
                            }}
                          >
                            <Text weight="medium">
                              {s.title}
                              {s.page ? `, ${s.page}` : ""}
                            </Text>
                            <Text type="supporting">
                              <em>“{s.quote}”</em>
                            </Text>
                          </div>
                        ))}
                        <Text type="supporting">
                          The cited documents are stored as reference tariff schedules; ask Sparks
                          for a copy any time.
                        </Text>
                      </Stack>
                    ) : null}
                  </Stack>
                ) : null}
              </Stack>
            </Card>
          ) : (
            <Banner
              status="info"
              title="No tariff is assigned to this site yet, so usage can't be priced. Your usage below is still live; charges appear once Sparks assigns your tariff."
            />
          )}

          {demandFloor ? (
            <Card padding={5}>
              <Stack gap={4}>
                <Text weight="semibold">How your demand is billed</Text>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 32, alignItems: "flex-end" }}>
                  <MetricStat
                    label="Your peak demand this period"
                    hint="The highest half-hourly demand your meter recorded this period."
                    value={demandFloor.measuredDemandKva.toFixed(1)}
                    unit="kVA"
                    size="md"
                  />
                  <MetricStat
                    label="Demand you're billed for"
                    hint="This tariff bills demand on a fixed minimum. When your measured peak is below it, demand is charged at the minimum."
                    value={String(demandFloor.billedDemandKva)}
                    unit="kVA"
                    size="md"
                  />
                  <MetricStat
                    label="Difference on this bill"
                    hint="The gap between this bill and one where demand is charged on your measured peak instead of the minimum."
                    value={fmtRand(demandFloor.extraInclVatCents)}
                    size="md"
                  />
                </div>
                <Text type="supporting">
                  This tariff bills demand on a minimum of {demandFloor.billedDemandKva} kVA. Your
                  meter's highest half-hourly demand this period was{" "}
                  {demandFloor.measuredDemandKva.toFixed(1)} kVA, which is below that minimum, so
                  demand is billed at {demandFloor.billedDemandKva} kVA. Priced on your measured
                  peak instead, this period would come to{" "}
                  {fmtRand(demandFloor.usageBasedTotalInclVatCents)} — a difference of{" "}
                  {fmtRand(demandFloor.extraInclVatCents)}.
                </Text>
              </Stack>
            </Card>
          ) : null}

          {/* Compare-with-history placeholder until past bills are uploaded. Once a
              customer uploads past landlord bills, Sparks prices each against the meter
              so any differences can be seen here. */}
          <Card padding={5}>
            <Stack gap={2}>
              <Text weight="semibold">Compare with your past bills</Text>
              <Text type="supporting">
                Upload your past landlord bills and Sparks will price each one against your meter
                for the same period, so you can see how each bill compares line by line.
              </Text>
              <div>
                <Button
                  label="Upload past bills"
                  variant="secondary"
                  size="sm"
                  href={`/sites/${siteId}/invoices`}
                />
              </div>
            </Stack>
          </Card>

          <Card padding={5}>
            <Stack gap={3}>
              <Text weight="semibold">Usage this period</Text>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 32 }}>
                <MetricStat
                  label="Active energy"
                  hint={METRIC_HINTS.activeEnergy}
                  value={formatReading(data.usage.activeEnergyKwh)}
                  unit="kWh"
                />
                <MetricStat
                  label="Peak demand"
                  hint={METRIC_HINTS.peakDemand}
                  value={formatReading(data.usage.maxDemandKva)}
                  unit="kVA"
                />
                <MetricStat
                  label="Reactive energy"
                  hint={METRIC_HINTS.reactiveEnergy}
                  value={formatReading(data.usage.reactiveEnergyKvarh)}
                  unit="kVArh"
                />
              </div>
            </Stack>
          </Card>
        </>
      ) : null}
    </Stack>
  );
}
