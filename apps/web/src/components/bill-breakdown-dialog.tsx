"use client";

import { useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Stack } from "@astryxdesign/core/Stack";
import { AlertTriangle, ListTree } from "lucide-react";
import { BillSankey } from "./bill-sankey";
import { useMediaQuery } from "@/lib/useMediaQuery";
import {
  CHARGE_GLOSSARY,
  REPORT,
  SectionHeading,
  cellBase,
  numericCell,
} from "./report-style";

/** One priced charge, exactly as the server itemised it. */
export interface BillLine {
  key: string;
  group: "active_energy" | "demand" | "reactive_energy" | "fixed" | "ancillary";
  label: string;
  quantity: number | null;
  quantityUnit: string | null;
  rateValue: number;
  rateUnit: string;
  rateDisplay: string;
  amountCents: number;
  source: string | null;
  season: string;
  touPeriod: string;
}

function formatRand(cents: number): string {
  const r = cents / 100;
  const [whole, frac] = Math.abs(r).toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${r < 0 ? "-" : ""}R ${grouped}.${frac}`;
}

/** Quantities with thousands grouping, mirroring the report tables. */
function formatQuantity(value: number, unit: string | null): string {
  const decimals = unit === "kVA" ? 1 : unit === "kVArh" ? 3 : 0;
  const [whole, frac] = value.toFixed(decimals).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return frac ? `${grouped}.${frac}` : grouped;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

/**
 * One sentence explaining what a specific charge line is and how it was arrived
 * at — built from the line's own facts (season, TOU period, block bound, whether
 * it is flat) rather than from a fixed lookup, so it stays true for any tariff.
 */
function describeLine(line: BillLine): string {
  const when =
    line.season === "high"
      ? "in the winter season (June-August)"
      : line.season === "low"
        ? "in the summer season (September-May)"
        : null;
  const band =
    line.touPeriod === "peak"
      ? "during peak hours"
      : line.touPeriod === "standard"
        ? "during standard hours"
        : line.touPeriod === "offpeak"
          ? "during off-peak hours"
          : null;

  switch (line.group) {
    case "active_energy": {
      const isBlock = /block/i.test(line.label);
      const head = isBlock
        ? "Electricity used within this consumption block"
        : "Electricity used";
      return `${[head, band, when].filter(Boolean).join(" ")}, charged per unit consumed.`;
    }
    case "demand":
      return "Based on the highest half-hourly demand recorded this period, not total usage.";
    case "reactive_energy":
      return "The portion of reactive energy above the tariff's free allowance.";
    case "fixed":
      return "A flat charge for the billing period. It does not change with how much you use.";
    default:
      return "A charge defined by your tariff.";
  }
}

/**
 * The numeric part of a formatted rate ("468.69 c/kWh" -> "468.69"). The unit is
 * printed once in the group header, so repeating it on every row is noise that
 * pushes the figures apart and makes the column harder to scan.
 */
function stripUnit(rateDisplay: string): string {
  return rateDisplay.replace(/^R\s*/, "").replace(/\s*(c\/kWh|c\/kVArh|\/kVA|\/month|\/day)$/, "");
}

/** The unit a group's rates are quoted in, e.g. "R/kWh" — shown once per group. */
function unitLabel(rateUnit: string): string {
  switch (rateUnit) {
    // Energy and reactive rates are published — and displayed — in CENTS, so the
    // heading must say c/kWh. Labelling the column "R/kWh" over a figure like
    // 242.42 would misstate the rate by a factor of 100.
    case "c_per_kwh":
      return "c/kWh";
    case "c_per_kvarh":
      return "c/kVArh";
    case "r_per_kva":
      return "R/kVA";
    case "r_per_month":
      return "R/month";
    case "r_per_day":
      return "R/day";
    default:
      return "—";
  }
}

/**
 * Full itemisation of the live cost-to-date figure, presented as the generated
 * PDF report presents it.
 *
 * The premise: a customer should be able to account for every cent without phoning
 * anyone. Each row states its own arithmetic — measured quantity, published rate,
 * and the resulting fee — and every rate is traced to the document it was read
 * from. Nothing here is computed in the browser; the amounts, labels and rates are
 * the server's own priced lines, so what is displayed cannot drift from what was
 * charged.
 *
 * Charges the tariff defines but the pricer does NOT apply are listed too, under
 * "Not included". Hiding them would leave the total quietly understated — the exact
 * failure this dialog exists to prevent.
 */
export function BillBreakdownDialog({
  isOpen,
  onOpenChange,
  tariffName,
  periodStart,
  asOf,
  totalCents,
  vatCents,
  lines,
  notApplied,
  onShowTariffSheet,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  tariffName: string | null;
  periodStart: string;
  asOf: string;
  totalCents: number;
  /** VAT on the charge subtotal; omitted or zero when the tariff carries none. */
  vatCents?: number | null;
  lines: BillLine[];
  notApplied: Array<{ rule: string; effect: string }>;
  /** Opens the full published rate card for this tariff. */
  onShowTariffSheet: () => void;
}) {
  // The report table wants horizontal room: six columns of figures read as a grid
  // on a laptop and as a cramped stack on a phone. Below the breakpoint the dialog
  // goes full-screen and the table scrolls inside its own container.
  const isWide = useMediaQuery("(min-width: 1024px)");
  const [showNotes, setShowNotes] = useState(false);
  // Flow first, figures on request. The diagram answers "where is my money
  // going"; the table answers "is this exact charge right". Both are the same
  // server-priced lines, so they cannot disagree — and the table is also the
  // non-visual alternative the diagram needs to be accessible.
  const [view, setView] = useState<"flow" | "table">("flow");
  const isDark = useMediaQuery("(prefers-color-scheme: dark)");

  // Summed from the lines themselves rather than trusting the transmitted total, so
  // the figure shown is arithmetically the one the itemisation adds up to.
  const linesTotal = lines.reduce((sum, l) => sum + l.amountCents, 0);
  // Two independent paths to the same number (the server's sum of charge categories
  // vs. the sum of the lines it sent). They agree by construction, so a mismatch
  // means a line failed to reach this screen — the one thing a breakdown promising
  // "no unsourceable charges" must never hide.
  const unreconciledCents = totalCents - linesTotal;

  const sources = Array.from(
    new Set(lines.map((l) => l.source).filter((s): s is string => Boolean(s))),
  );

  const presentGroups = CHARGE_GLOSSARY.filter((g) => lines.some((l) => l.group === g.key));

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      purpose="info"
      // Near-full-bleed on desktop: this is a report, and the table is its point.
      variant={isWide ? "standard" : "fullscreen"}
      width="min(1180px, 94vw)"
      maxHeight="92vh"
      padding={0}
    >
      {/* The dialog is a flex column with overflow:hidden, so the body only
          scrolls if it is allowed to shrink: minHeight 0 on both this wrapper and
          the scroller, and flex:1 so the scroller takes the leftover height. */}
      <Stack gap={0} style={{ minHeight: 0, flex: 1 }}>
        <DialogHeader
          title="Cost breakdown"
          subtitle={`${shortDate(periodStart)} — ${shortDate(asOf)}`}
          onOpenChange={onOpenChange}
          hasDivider
          // The dialog is padding={0} so the body can run edge-to-edge; that also
          // strips the header's inherited padding, leaving the title jammed into
          // the corner. Re-apply it here, matching the body's horizontal inset so
          // the title lines up with the table beneath it.
          style={{
            padding: isWide ? "22px 40px 18px" : "18px 18px 16px",
          }}
        />

        <div style={{ overflowY: "auto", minHeight: 0, flex: 1, background: "#fff" }}>
          <div style={{ padding: isWide ? "24px 40px 40px" : "18px 18px 28px" }}>
            {/* ── Report masthead: the tariff every rate below derives from ────
                Mirrors the PDF's header rule — a heavy bottom border under the
                document identity, brand green marking the accent. */}
            <div
              style={{
                borderBottom: `2px solid ${REPORT.ruleStrong}`,
                paddingBottom: 16,
                marginBottom: 20,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-end",
                  gap: 24,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ minWidth: 240 }}>
                  <div
                    style={{
                      fontSize: 11,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      color: REPORT.brand,
                      fontWeight: 600,
                      marginBottom: 6,
                    }}
                  >
                    Tariff applied
                  </div>
                  <div
                    style={{
                      fontSize: isWide ? 25 : 20,
                      fontWeight: 600,
                      lineHeight: 1.15,
                      letterSpacing: "-0.015em",
                      color: REPORT.ink,
                    }}
                  >
                    {tariffName ?? "Unnamed tariff"}
                  </div>
                  <div style={{ fontSize: 12, color: REPORT.inkMuted, marginTop: 6 }}>
                    Priced from this site's metered readings for the period shown.
                  </div>
                </div>

                {/* The metered quantities used to sit here as three tiles. They
                    now repeat what the breakdown itself states line by line —
                    energy in the energy rows, demand on the demand row — so they
                    were removed rather than shown twice in different words. */}
              </div>
            </div>

            {/* ── What a bill is made of ──────────────────────────────────────
                One orienting sentence, then the figures. A customer opening a
                cost breakdown wants the numbers — the explanation of how tariffs
                work belongs behind the link, for those who go looking. */}
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 13.5, color: REPORT.ink, lineHeight: 1.6 }}>
                Your bill is made up of separate charges, each with its own rate. Here is
                every one that makes up this period's cost.
              </div>
              <button
                type="button"
                onClick={onShowTariffSheet}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  marginTop: 9,
                  padding: 0,
                  border: "none",
                  background: "none",
                  color: REPORT.brand,
                  font: "inherit",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  textDecoration: "underline",
                  textUnderlineOffset: 3,
                }}
              >
                <ListTree size={15} />
                See all charges this tariff can levy
              </button>
            </div>

            {/* ── View switch ─────────────────────────────────────────────────
                Two readings of one dataset, not two datasets. */}
            <div
              style={{
                display: "flex",
                gap: 2,
                marginBottom: 16,
                border: `1px solid ${REPORT.rule}`,
                borderRadius: 3,
                padding: 2,
                width: "fit-content",
              }}
            >
              {([
                ["flow", "Flow"],
                ["table", "Itemised"],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setView(key)}
                  aria-pressed={view === key}
                  style={{
                    padding: "5px 14px",
                    border: "none",
                    borderRadius: 2,
                    background: view === key ? REPORT.brand : "transparent",
                    color: view === key ? "#fff" : REPORT.inkMuted,
                    font: "inherit",
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {view === "flow" ? (
              <div
                style={{
                  // Theme-aware tokens for the SVG's own labels and canvas.
                  ["--sankey-ink" as string]: REPORT.ink,
                  ["--sankey-ink-muted" as string]: REPORT.inkMuted,
                  ["--sankey-total" as string]: REPORT.ruleStrong,
                  ["--sankey-surface" as string]: "#fff",
                  ["--sankey-rule" as string]: REPORT.rule,
                  border: `1px solid ${REPORT.rule}`,
                  // No padding or overflow here: the canvas owns its own viewport
                  // and clips internally, so an outer scroller would fight it.
                  marginBottom: 20,
                }}
              >
                <BillSankey lines={lines} totalCents={linesTotal} isDark={isDark} />
              </div>
            ) : null}

            <div style={{ display: view === "table" ? "block" : "none" }}>
            {/* ── The charge table ─────────────────────────────────────────────
                Column-for-column the PDF's layout: Charge Type / Charge / Unit /
                Consumption / Rate / Fee, with the category label spanning its
                rows. Wrapped in its own scroller so a narrow viewport scrolls the
                table rather than the page. */}
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  minWidth: 760,
                }}
              >
                <caption
                  style={{
                    captionSide: "top",
                    textAlign: "left",
                    paddingBottom: 8,
                  }}
                >
                  <span
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 16,
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontSize: 12, color: REPORT.inkMuted }}>
                      {`${lines.length} ${lines.length === 1 ? "charge" : "charges"} this period`}
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowNotes((v) => !v)}
                      aria-pressed={showNotes}
                      style={{
                        padding: 0,
                        border: "none",
                        background: "none",
                        color: REPORT.brand,
                        font: "inherit",
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: "pointer",
                        textDecoration: "underline",
                        textUnderlineOffset: 3,
                      }}
                    >
                      {showNotes ? "Hide explanations" : "Explain each charge"}
                    </button>
                  </span>
                </caption>
                <thead>
                  <tr style={{ background: REPORT.headerFill }}>
                    {[
                      { label: "Charge type", align: "left" as const, width: "14%" },
                      { label: "Charge", align: "left" as const, width: "36%" },
                      { label: "Consumption", align: "right" as const, width: "16%" },
                      { label: "Rate", align: "right" as const, width: "16%" },
                      { label: "Fee", align: "right" as const, width: "18%" },
                    ].map((col) => (
                      <th
                        key={col.label}
                        scope="col"
                        style={{
                          ...cellBase,
                          width: col.width,
                          textAlign: col.align,
                          fontWeight: 600,
                          fontSize: 12,
                          color: REPORT.ink,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>

                {presentGroups.map((group) => {
                  const groupLines = lines.filter((l) => l.group === group.key);
                  const groupTotal = groupLines.reduce((sum, l) => sum + l.amountCents, 0);
                  // Every line in a group shares its units, so they belong in the
                  // group's header once rather than repeated down every row.
                  const qtyUnit = groupLines.find((l) => l.quantityUnit)?.quantityUnit ?? null;
                  const rateUnit = unitLabel(groupLines[0].rateUnit);

                  return (
                    <tbody key={group.key}>
                      <tr>
                        <td
                          colSpan={2}
                          style={{
                            ...cellBase,
                            background: REPORT.groupFill,
                            fontWeight: 600,
                            fontSize: 12,
                          }}
                        >
                          {group.title}
                        </td>
                        <td
                          style={{
                            ...numericCell,
                            background: REPORT.groupFill,
                            fontSize: 11.5,
                            fontWeight: 500,
                            color: REPORT.inkMuted,
                          }}
                        >
                          {qtyUnit ?? ""}
                        </td>
                        <td
                          style={{
                            ...numericCell,
                            background: REPORT.groupFill,
                            fontSize: 11.5,
                            fontWeight: 500,
                            color: REPORT.inkMuted,
                          }}
                        >
                          {rateUnit}
                        </td>
                        {/* The group's own total, on EVERY group — including
                            single-line ones. Showing it only where a group had
                            several lines meant Demand and Reactive never appeared
                            in this column at all, so a reader adding up the
                            category figures came up short of the total and could
                            not see why. */}
                        <td
                          style={{
                            ...numericCell,
                            background: REPORT.groupFill,
                            fontWeight: 700,
                          }}
                        >
                          {formatRand(groupTotal)}
                        </td>
                      </tr>
                      {groupLines.map((line) => (
                        <tr key={line.key}>
                          {/* The group header above names the category, so the rows
                              beneath it only need an empty gutter to sit under. */}
                          <td style={cellBase} />

                          <td style={{ ...cellBase, paddingLeft: 22 }}>
                            {line.label}
                            {/* Explanations sit on the row they explain — but OFF by
                                default. Shown for everyone, they double the height of
                                every row and turn a scannable table into a wall of
                                prose; the reader who wants them turns them on once. */}
                            {showNotes ? (
                              <span
                                style={{
                                  display: "block",
                                  fontSize: 11.5,
                                  color: REPORT.inkMuted,
                                  lineHeight: 1.45,
                                  marginTop: 3,
                                }}
                              >
                                {describeLine(line)}
                              </span>
                            ) : null}
                          </td>
                          <td style={numericCell}>
                            {line.quantity !== null && line.quantityUnit
                              ? formatQuantity(line.quantity, line.quantityUnit)
                              : // A flat charge bills the same amount whatever the
                                // usage, so it has no consumption figure at all.
                                <span style={{ color: REPORT.inkMuted }}>—</span>}
                          </td>
                          <td style={{ ...numericCell, color: REPORT.inkMuted }}>
                            {stripUnit(line.rateDisplay)}
                          </td>
                          {/* Lighter than the group figure above: these are its
                              components. The bold figures running down this column
                              are then exactly the ones that add up to the total. */}
                          <td style={{ ...numericCell, color: REPORT.inkMuted }}>
                            {formatRand(line.amountCents)}
                          </td>
                        </tr>
                      ))}

                    </tbody>
                  );
                })}

                <tfoot>
                  <tr>
                    <td
                      colSpan={5}
                      style={{
                        ...cellBase,
                        textAlign: "right",
                        fontWeight: 600,
                        borderTop: `2px solid ${REPORT.ruleStrong}`,
                      }}
                    >
                      Subtotal
                      <span style={{ color: REPORT.inkMuted, fontWeight: 400 }}> · excludes VAT</span>
                    </td>
                    <td
                      style={{
                        ...numericCell,
                        fontWeight: 700,
                        fontSize: 15,
                        borderTop: `2px solid ${REPORT.ruleStrong}`,
                      }}
                    >
                      {formatRand(linesTotal)}
                    </td>
                  </tr>
                  {/* VAT is levied on the charge subtotal, not on any single line,
                      so it sits below the rule as its own row. Shown only when the
                      tariff actually carries VAT. */}
                  {vatCents && vatCents > 0 ? (
                    <>
                      <tr>
                        <td colSpan={5} style={{ ...cellBase, textAlign: "right", fontWeight: 500 }}>
                          VAT
                        </td>
                        <td style={{ ...numericCell, fontWeight: 600 }}>{formatRand(vatCents)}</td>
                      </tr>
                      <tr>
                        <td
                          colSpan={5}
                          style={{
                            ...cellBase,
                            textAlign: "right",
                            fontWeight: 700,
                            borderTop: `1px solid ${REPORT.ruleStrong}`,
                          }}
                        >
                          Total payable
                          <span style={{ color: REPORT.inkMuted, fontWeight: 400 }}> · incl. VAT</span>
                        </td>
                        <td
                          style={{
                            ...numericCell,
                            fontWeight: 700,
                            fontSize: 15,
                            borderTop: `1px solid ${REPORT.ruleStrong}`,
                          }}
                        >
                          {formatRand(linesTotal + vatCents)}
                        </td>
                      </tr>
                    </>
                  ) : null}
                </tfoot>
              </table>
            </div>
            </div>

            {unreconciledCents !== 0 ? (
              <div
                style={{
                  marginTop: 14,
                  padding: "12px 14px",
                  border: `1px solid ${REPORT.rule}`,
                  borderLeft: "4px solid #e65100",
                  background: "#fff8f2",
                  display: "flex",
                  gap: 10,
                }}
              >
                <span style={{ display: "inline-flex", color: "#e65100", marginTop: 1 }}>
                  <AlertTriangle size={15} />
                </span>
                <span style={{ fontSize: 13, color: REPORT.ink, lineHeight: 1.5 }}>
                  {`The charges listed come to ${formatRand(linesTotal)}, but the priced total for this period is ${formatRand(totalCents)} — a difference of ${formatRand(Math.abs(unreconciledCents))} this breakdown cannot account for. Please report this, as it is a fault on our side.`}
                </span>
              </div>
            ) : null}

            {/* ── Charges knowingly NOT applied ───────────────────────────────
                The honest counterpart to the itemisation: defined by the published
                tariff but absent from the figure above, so the customer learns it
                here rather than from a larger municipal invoice. */}
            {notApplied.length > 0 ? (
              <div style={{ marginTop: 28 }}>
                <SectionHeading>Not included in this estimate</SectionHeading>
                <div style={{ fontSize: 12.5, color: REPORT.inkMuted, margin: "8px 0 12px", lineHeight: 1.55 }}>
                  The tariff defines these charges, but they depend on information this
                  estimate does not yet apply. A final municipal bill may differ because of
                  them.
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
                    <thead>
                      <tr style={{ background: REPORT.headerFill }}>
                        <th
                          scope="col"
                          style={{ ...cellBase, width: "26%", fontWeight: 600, fontSize: 12, textAlign: "left" }}
                        >
                          Charge
                        </th>
                        <th
                          scope="col"
                          style={{ ...cellBase, fontWeight: 600, fontSize: 12, textAlign: "left" }}
                        >
                          Effect on this estimate
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {notApplied.map((rule) => (
                        <tr key={rule.rule}>
                          <td style={{ ...cellBase, fontWeight: 500, textTransform: "capitalize" }}>
                            {rule.rule.replace(/_/g, " ")}
                          </td>
                          <td style={{ ...cellBase, color: REPORT.inkMuted, lineHeight: 1.5 }}>
                            {rule.effect}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {/* ── Sources, as the report's own sources section ────────────────── */}
            {sources.length > 0 ? (
              <div style={{ marginTop: 28 }}>
                <SectionHeading>Sources</SectionHeading>
                <div style={{ marginTop: 8 }}>
                  {sources.map((source) => (
                    <div
                      key={source}
                      style={{ fontSize: 12.5, color: REPORT.inkMuted, lineHeight: 1.6 }}
                    >
                      {source}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div
              style={{
                marginTop: 24,
                paddingTop: 14,
                borderTop: `1px solid ${REPORT.rule}`,
                fontSize: 11.5,
                color: REPORT.inkMuted,
                lineHeight: 1.6,
              }}
            >
              Consumption figures are this site's own metered readings for the period.
              Rates are the published figures for the tariff shown. Nothing on this screen
              is estimated or apportioned unless it says so.
            </div>
          </div>
        </div>
      </Stack>
    </Dialog>
  );
}
