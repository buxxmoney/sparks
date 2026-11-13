"use client";

import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { FileDown, FileText } from "lucide-react";
import { useRPC } from "@/lib/useRPC";
import { client } from "@/lib/client";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { CHARGE_GLOSSARY, REPORT, cellBase, numericCell, SectionHeading } from "./report-style";

const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

/**
 * True only when `url` is served by our own API.
 *
 * The approved schedule is evidence a customer may rely on to question a charge,
 * so it must come from us: a link to the utility's own website can rot, move, or
 * quietly change content, and a stale or altered document is worse than none at
 * all. The server already signs these from our storage — this is the client-side
 * half of that guarantee, so a bad value can never render as an off-site link.
 */
function isOwnDocument(url: string): boolean {
  try {
    return new URL(url, API_ORIGIN).origin === new URL(API_ORIGIN).origin;
  } catch {
    return false;
  }
}

/** One published rate in the tariff, whether or not it cost anything this period. */
interface TariffRateRow {
  chargeType: string;
  label: string;
  source: string | null;
  unit: string;
  rateValue: number;
  rateDisplay: string;
  season: string;
  touPeriod: string;
  blockThresholdKwh: number | null;
}

/**
 * The complete published rate card for the site's tariff.
 *
 * Deliberately shows EVERY line the tariff defines, including those that cost
 * nothing this period. A customer asking "what can I be charged for?" cannot
 * answer it from a bill alone — a charge that does not apply to them and one they
 * simply have not incurred yet look identical there. This is the full menu, with
 * the approved schedule document behind it one click away.
 */
export function TariffSheetDialog({
  siteId,
  isOpen,
  onOpenChange,
}: {
  siteId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isWide = useMediaQuery("(min-width: 1024px)");
  // Only fetched once opened — the rate card is a detail view, not dashboard chrome.
  const { data, loading } = useRPC(
    () => (isOpen ? client.readings.tariffSheet({ siteId }) : Promise.resolve(null)),
    [siteId, isOpen],
  );

  const rates = data?.status === "ok" ? data.rates : [];
  // Group the card the way the bill groups its charges, so the two read alike.
  const groups = CHARGE_GLOSSARY.filter((g) => rates.some((r) => r.chargeType === g.key));

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      purpose="info"
      variant={isWide ? "standard" : "fullscreen"}
      width="min(1080px, 94vw)"
      maxHeight="92vh"
      padding={0}
    >
      {/* The dialog is a flex column with overflow:hidden, so the body only
          scrolls if it is allowed to shrink: minHeight 0 on both this wrapper and
          the scroller, and flex:1 so the scroller takes the leftover height. */}
      <Stack gap={0} style={{ minHeight: 0, flex: 1 }}>
        <DialogHeader
          title="Your tariff's full rate card"
          subtitle={data?.tariffName ?? undefined}
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
            {loading && !data ? (
              <Skeleton height={320} />
            ) : data?.status !== "ok" ? (
              <Text type="supporting">
                No tariff is assigned to this site yet, so there is no rate card to show.
              </Text>
            ) : (
              <>
                <div style={{ fontSize: 13, color: REPORT.inkMuted, lineHeight: 1.6, marginBottom: 18 }}>
                  These are every charge your tariff is allowed to levy, at the rates
                  published by your supplier. A charge only appears on your bill when you
                  actually incur it — so seeing a line here does not mean you are paying it.
                </div>

                {/* The approved source document, offered for download. The whole
                    point of the rate card is that it is checkable against the
                    utility's own published schedule. */}
                {data.document && isOwnDocument(data.document.url) ? (
                  <a
                    href={data.document.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "13px 15px",
                      border: `1px solid ${REPORT.rule}`,
                      borderLeft: `4px solid ${REPORT.brand}`,
                      background: REPORT.groupFill,
                      textDecoration: "none",
                      color: "inherit",
                      marginBottom: 22,
                    }}
                  >
                    <span style={{ display: "inline-flex", color: REPORT.brand }}>
                      <FileDown size={18} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span
                        style={{ display: "block", fontSize: 13.5, fontWeight: 600, color: REPORT.ink }}
                      >
                        {data.document.name}
                      </span>
                      <span style={{ display: "block", fontSize: 12, color: REPORT.inkMuted, marginTop: 2 }}>
                        {/* The edition matters: rates are re-approved annually, so a
                            customer checking a charge needs to know the document they
                            are opening covers the period they were billed for. */}
                        {`${data.document.provider} · in force from ${new Date(
                          data.document.effectiveFrom,
                        ).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" })}`}
                      </span>
                      {/* Stated because it is the point: this is the copy we priced
                          against, held by us. A link to the utility's site could
                          change or disappear, leaving a customer unable to check the
                          rate they were actually billed at. */}
                      <span style={{ display: "block", fontSize: 11.5, color: REPORT.inkMuted, marginTop: 2 }}>
                        Served from Sparks — the copy these rates were taken from
                      </span>
                    </span>
                    <span style={{ display: "inline-flex", color: REPORT.inkMuted }}>
                      <FileText size={15} />
                    </span>
                  </a>
                ) : (
                  <div
                    style={{
                      padding: "12px 14px",
                      border: `1px solid ${REPORT.rule}`,
                      background: REPORT.groupFill,
                      fontSize: 12.5,
                      color: REPORT.inkMuted,
                      marginBottom: 22,
                    }}
                  >
                    The approved schedule document for this tariff is not on file yet, so it
                    cannot be downloaded here. The rates below still cite their source.
                  </div>
                )}

                {groups.map((group) => {
                  const groupRates = rates.filter((r) => r.chargeType === group.key);
                  return (
                    <div key={group.key} style={{ marginBottom: 26 }}>
                      <SectionHeading>{group.title}</SectionHeading>
                      <div
                        style={{
                          fontSize: 12.5,
                          color: REPORT.inkMuted,
                          lineHeight: 1.55,
                          margin: "8px 0 10px",
                          maxWidth: 760,
                        }}
                      >
                        {group.blurb}
                      </div>
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
                          <thead>
                            <tr style={{ background: REPORT.headerFill }}>
                              <th
                                scope="col"
                                style={{ ...cellBase, textAlign: "left", fontWeight: 600, fontSize: 12, width: "55%" }}
                              >
                                Line item
                              </th>
                              <th
                                scope="col"
                                style={{ ...cellBase, textAlign: "left", fontWeight: 600, fontSize: 12, width: "20%" }}
                              >
                                When it applies
                              </th>
                              <th
                                scope="col"
                                style={{ ...cellBase, textAlign: "right", fontWeight: 600, fontSize: 12, width: "25%" }}
                              >
                                Published rate
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {groupRates.map((rate) => (
                              <tr key={`${rate.label}:${rate.season}:${rate.touPeriod}:${rate.rateValue}`}>
                                <td style={cellBase}>{rate.label}</td>
                                <td style={{ ...cellBase, color: REPORT.inkMuted, fontSize: 12.5 }}>
                                  {appliesWhen(rate)}
                                </td>
                                <td style={{ ...numericCell, fontWeight: 600 }}>{rate.rateDisplay}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })}

                <SourcesBlock rates={rates} />
              </>
            )}
          </div>
        </div>
      </Stack>
    </Dialog>
  );
}

/** Plain-language statement of the conditions under which a rate is charged. */
function appliesWhen(rate: TariffRateRow): string {
  const parts: string[] = [];
  if (rate.season === "high") parts.push("Winter (Jun–Aug)");
  else if (rate.season === "low") parts.push("Summer (Sep–May)");
  if (rate.touPeriod === "peak") parts.push("peak hours");
  else if (rate.touPeriod === "standard") parts.push("standard hours");
  else if (rate.touPeriod === "offpeak") parts.push("off-peak hours");
  if (parts.length === 0) return "Always";
  return parts.join(", ");
}

function SourcesBlock({ rates }: { rates: TariffRateRow[] }) {
  const sources = Array.from(
    new Set(rates.map((r) => r.source).filter((s): s is string => Boolean(s))),
  );
  if (sources.length === 0) return null;
  return (
    <div style={{ marginTop: 6, paddingTop: 14, borderTop: `1px solid ${REPORT.rule}` }}>
      <SectionHeading>Sources</SectionHeading>
      <div style={{ marginTop: 8 }}>
        {sources.map((source) => (
          <div key={source} style={{ fontSize: 12.5, color: REPORT.inkMuted, lineHeight: 1.6 }}>
            {source}
          </div>
        ))}
      </div>
    </div>
  );
}
