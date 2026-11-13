"use client";

import { useEffect, useState } from "react";
import { Receipt } from "lucide-react";
import { Stack } from "@astryxdesign/core/Stack";
import { Card } from "@astryxdesign/core/Card";
import { Text } from "@astryxdesign/core/Text";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Button } from "@astryxdesign/core/Button";
import { Selector } from "@astryxdesign/core/Selector";
import { useRPC } from "@/lib/useRPC";
import { client } from "@/lib/client";
import { InfoLabel } from "@/components/metric";
import { type BillLine, BillBreakdownDialog } from "@/components/bill-breakdown-dialog";
import { TariffSheetDialog } from "@/components/tariff-sheet-dialog";
import { LoadingVeil } from "@/components/loading-veil";

const MUTED_INK = "var(--color-text-secondary, hsl(215 16% 47%))";
const HAIRLINE = "1px solid var(--color-border, #ebebeb)";

/**
 * Rand from integer cents, grouped for readability: `R 184 302.55`. Cents are the
 * server's unit of account, so no floating-point money ever crosses the wire.
 *
 * Grouped with thin spaces and a DOT decimal. en-ZA would render "369 238,90"
 * (comma decimal), which contradicts the dot-decimal energy figures `formatReading`
 * puts on the same screen — one page must not use two decimal conventions.
 */
function formatRand(cents: number): string {
  const r = cents / 100;
  const [whole, frac] = Math.abs(r).toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
  return `${r < 0 ? "-" : ""}R ${grouped}.${frac}`;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Names a billing period the way a customer would say it out loud: "23 Jul – 22 Aug".
 *
 * The year is stated only when the period does not sit in the current one, so the
 * common case stays short and the ambiguous case stays unambiguous.
 *
 * `periodEnd` is EXCLUSIVE — the instant the next period opens — so the label
 * shows the day before it. A period running to midnight on the 23rd reads as
 * ending on the 22nd, which is what the customer's own bill says.
 */
function periodLabel(periodStart: string, periodEnd: string): string {
  const start = new Date(periodStart);
  const lastDay = new Date(new Date(periodEnd).getTime() - 1);
  // Period boundaries are UTC instants, so they must be READ in UTC. Formatting
  // them in the viewer's zone shifts them: midnight UTC on the 23rd less one
  // millisecond is the 22nd in UTC but still the 23rd in SAST (UTC+2), which
  // would print an end date a day later than the period actually runs to.
  const fmt = (d: Date, withYear: boolean) =>
    d.toLocaleDateString("en-ZA", {
      timeZone: "UTC",
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
    });
  const thisYear = new Date().getUTCFullYear();
  const spansOtherYear =
    start.getUTCFullYear() !== thisYear || lastDay.getUTCFullYear() !== thisYear;
  // Only the tail carries the year when both ends share one — "23 Jul – 22 Aug 2025",
  // not "23 Jul 2025 – 22 Aug 2025".
  const sameYear = start.getUTCFullYear() === lastDay.getUTCFullYear();
  return `${fmt(start, spansOtherYear && !sameYear)} – ${fmt(lastDay, spansOtherYear)}`;
}

// Two different claims, so two different explanations. An open period reports a
// running total that is explicitly NOT a forecast; a closed one reports the whole
// period, which is a complete figure and should not be hedged as if it might grow.
/**
 * States how VAT is treated in the headline figure, e.g. " · incl. R 9 231.49 VAT".
 *
 * Named explicitly rather than left as "incl. VAT" because the whole point of the
 * card is that no figure is unaccountable: a customer comparing it against a
 * municipal invoice needs the VAT component itself, not just the assurance that
 * some VAT is in there. Falls back to the old "excludes VAT" wording when the
 * server reports no VAT for the tariff, so nothing claims VAT that wasn't charged.
 */
function vatSuffix(data: { vatCents?: number | null }): string {
  const vat = data.vatCents;
  if (typeof vat !== "number" || vat <= 0) return " · excludes VAT";
  return ` · incl. ${formatRand(vat)} VAT`;
}

const BILL_HINT_OPEN =
  "What your electricity has cost so far in this billing period, priced against your tariff using your meter's own readings and shown with VAT included. It counts only usage measured up to now — it is not a forecast of your final bill.";
const BILL_HINT_CLOSED =
  "What your electricity cost over this complete billing period, priced against the tariff that applied at the time using your meter's own readings, and shown with VAT included.";

// Summary rows shown on the card itself: one per charge category that cost
// something this period. `key` matches the server's breakdown field. The full
// per-rate itemisation lives in the breakdown dialog — the card states what the
// money went on, the dialog proves it.
const CHARGE_LINES = [
  { key: "activeEnergyCents", label: "Energy" },
  { key: "demandCents", label: "Demand" },
  { key: "reactiveEnergyCents", label: "Reactive energy" },
  { key: "fixedCents", label: "Fixed charges" },
  { key: "ancillaryCents", label: "Other charges" },
] as const;

/**
 * Live "cost so far this billing period" card.
 *
 * Shows what has ACTUALLY accrued — deliberately not a projected period-end total.
 * Demand bills the single highest interval (today's peak is a floor, not the final
 * figure) and fixed charges apply in full regardless of elapsed time, so any
 * projection would rest on assumptions the customer can't see. The card summarises
 * by charge category; the full per-rate itemisation — quantity, published rate and
 * source document for every line — opens in {@link BillBreakdownDialog}, so the
 * total is traceable to the schedule rather than magic.
 *
 * Renders nothing when the site has no tariff assigned, unless the viewer is a
 * Sparks operator — an unassigned tariff is a provisioning gap only they can close.
 */
/** What the cost card is currently showing, for a sibling card to stay in step with. */
export interface BillPeriodView {
  periodStart: string;
  periodEnd: string;
  isClosed: boolean;
  /** Energy the shown period was priced on; null when it has no tariff or no data. */
  activeEnergyKwh: string | null;
  /** True while a newly selected period is still loading. */
  pending: boolean;
}

export function BillToDate({
  siteId,
  isOperator,
  tick,
  onPeriod,
}: {
  siteId: string;
  isOperator: boolean;
  tick: number;
  /** Reports the period on show, so the energy card beside this one matches it. */
  onPeriod?: (view: BillPeriodView | null) => void;
}) {
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [tariffSheetOpen, setTariffSheetOpen] = useState(false);
  // Which period the card is showing, as the `asOf` instant that selects it.
  // Null means "the current one" — the server's own default — so the card renders
  // its first figure without waiting on the period list to arrive.
  const [selectedAsOf, setSelectedAsOf] = useState<string | null>(null);

  const { data: periodData } = useRPC(() => client.readings.billPeriods({ siteId }), [siteId]);
  const periods = periodData?.periods ?? [];

  const { data, loading } = useRPC(
    // The period list hands back ISO instants; the procedure's input is a Date.
    () =>
      client.readings.billToDate({
        siteId,
        ...(selectedAsOf ? { asOf: new Date(selectedAsOf) } : {}),
      }),
    // `tick` is the dashboard's live-refresh pulse. It only matters for the open
    // period: a closed one cannot change, so re-pricing it on every pulse would be
    // work that can never alter the answer.
    [siteId, selectedAsOf, selectedAsOf === null ? tick : 0],
  );

  // The card keeps showing the previous period until the newly chosen one
  // arrives. Compare the period the data is FOR with the period selected, so the
  // wait is visible — and so the 30-second background refresh of the current
  // period, which changes nothing the reader chose, does not flash a spinner.
  const wanted = selectedAsOf
    ? periods.find((p) => p.asOf === selectedAsOf)
    : periods.find((p) => p.isCurrent);
  const switching = !!data && wanted !== undefined && wanted.periodStart !== data.periodStart;

  useEffect(() => {
    if (!onPeriod) return;
    onPeriod(
      data
        ? {
            periodStart: data.periodStart,
            periodEnd: data.periodEnd,
            isClosed: data.isClosed === true,
            activeEnergyKwh: data.usage?.activeEnergyKwh ?? null,
            pending: switching,
          }
        : null,
    );
  }, [data, switching, onPeriod]);

  if (loading && !data) return <Skeleton height={150} />;
  if (!data) return null;

  // No tariff on file: invisible to customers, explained to operators.
  if (data.status === "no_tariff") {
    if (!isOperator) return null;
    return (
      <Card padding={5}>
        <Stack gap={3}>
          <Stack direction="horizontal" gap={2} align="center">
            <span style={{ display: "inline-flex", color: MUTED_INK }}>
              <Receipt size={16} />
            </span>
            <Text weight="semibold">Estimated cost</Text>
          </Stack>
          <Text type="supporting">
            No tariff is assigned to this site, so no bill estimate can be produced. Assign one from
            the operator console to turn on live cost estimation for this customer.
          </Text>
        </Stack>
      </Card>
    );
  }

  const noData = data.status === "no_data" || data.totalCents === null;
  // The server is the authority on whether the priced window has closed: it
  // clamps a closed period to its own end, so a stale `selectedAsOf` cannot make
  // an open period look finished or vice versa.
  const isClosed = data.isClosed === true;

  return (
    <Card padding={5} height="100%">
      <Stack gap={4}>
        <Stack direction="horizontal" justify="between" align="center" gap={2} wrap="wrap">
          <Stack direction="horizontal" gap={2} align="center">
            <span style={{ display: "inline-flex", color: MUTED_INK }}>
              <Receipt size={16} />
            </span>
            <Text weight="semibold">Estimated cost</Text>
          </Stack>
          {/* The period control. Offered only when there is more than one period
              to choose from — a site one month old gets the plain date line it
              had before, not a dropdown with a single entry in it. */}
          {periods.length > 1 ? (
            <Selector
              label=""
              aria-label="Billing period"
              options={periods.map((p) => ({
                value: p.asOf,
                label: `${periodLabel(p.periodStart, p.periodEnd)}${p.isCurrent ? " · current" : ""}`,
              }))}
              value={selectedAsOf ?? periods.find((p) => p.isCurrent)?.asOf ?? periods[0].asOf}
              // Picking the current period clears the override rather than
              // pinning its `asOf`. A pinned instant goes stale as the period
              // runs on, and the live-refresh guard below keys off null — so
              // storing one here would quietly freeze the running total.
              onChange={(v) =>
                setSelectedAsOf(periods.find((p) => p.asOf === v)?.isCurrent ? null : (v as string))
              }
              width="260px"
            />
          ) : (
            <Text type="supporting" size="sm">since {shortDate(data.periodStart)}</Text>
          )}
        </Stack>

        <LoadingVeil active={switching} label="Pricing this period…">
        <Stack gap={4}>
        {noData ? (
          <Text type="supporting">
            {isClosed
              ? "No metered data was recorded for this billing period, so no cost can be shown for it."
              : "No metered data yet for this billing period. The estimate appears once your meter reports its first full interval."}
          </Text>
        ) : (
          <>
            {/* Hero figure left, the metered inputs behind it right — the card is
                full-width, so a lone number would leave a large empty gutter, and
                these two values are exactly what a reader checks it against. */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-end",
                gap: 24,
                flexWrap: "wrap",
              }}
            >
              <Stack gap={1}>
                <InfoLabel
                  label={isClosed ? "Total cost" : "Cost to date"}
                  hint={isClosed ? BILL_HINT_CLOSED : BILL_HINT_OPEN}
                />
                <span
                  style={{
                    fontSize: 38,
                    fontWeight: 600,
                    lineHeight: 1.1,
                    letterSpacing: "-0.02em",
                    color: "var(--color-text-primary, inherit)",
                  }}
                >
                  {formatRand((data.totalInclVatCents ?? data.totalCents) as number)}
                </span>
                {/* The boundaries of the figure, stated rather than implied: it's a
                    running total, not a forecast, and excludes VAT. */}
                <Text type="supporting" size="sm">
                  {isClosed
                    ? `Full period, ${periodLabel(data.periodStart, data.periodEnd)}${vatSuffix(data)}`
                    : `Accrued so far this billing period${vatSuffix(data)}`}
                </Text>
              </Stack>

              {data.usage ? (
                <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
                  {/* Energy used and peak demand were shown here too. They are
                      already their own tiles on the dashboard directly above this
                      card, so repeating them said the same thing twice in the
                      same viewport. Only the tariff — stated nowhere else — stays. */}
                  {data.tariffName ? (
                    <Stack gap={1}>
                      <Text type="supporting" size="sm">Tariff</Text>
                      <Text weight="medium">{data.tariffName}</Text>
                    </Stack>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div style={{ borderTop: HAIRLINE }} />

            {/* Category summary on the card — what the money went on, at a glance.
                Categories costing nothing this period are omitted, so a flat tariff
                doesn't show four empty rows. */}
            {data.breakdown ? (
              <Stack gap={0}>
                {CHARGE_LINES.filter(
                  (line) => (data.breakdown as Record<string, number>)[line.key] > 0,
                ).map((line) => (
                  <div
                    key={line.key}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      gap: 16,
                      padding: "9px 0",
                      borderTop: HAIRLINE,
                    }}
                  >
                    <Text size="sm">{line.label}</Text>
                    <span style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                      <Text size="sm" weight="medium">
                        {formatRand((data.breakdown as Record<string, number>)[line.key])}
                      </Text>
                    </span>
                  </div>
                ))}
              </Stack>
            ) : null}

            {/* The card summarises; the dialog itemises. Every rate, quantity and
                source sits one click away, so no figure here is unaccountable. */}
            <Stack direction="horizontal" justify="between" align="center" gap={3} wrap="wrap">
              <Button
                variant="secondary"
                size="sm"
                label="View full breakdown"
                onClick={() => setBreakdownOpen(true)}
              />
              <Text type="supporting" size="sm">
                Every charge, rate and source itemised
              </Text>
            </Stack>

            <BillBreakdownDialog
              isOpen={breakdownOpen}
              onOpenChange={setBreakdownOpen}
              tariffName={data.tariffName}
              periodStart={data.periodStart}
              asOf={data.asOf}
              totalCents={data.totalCents as number}
              vatCents={data.vatCents}
              lines={(data.lines ?? []) as BillLine[]}
              notApplied={data.notApplied ?? []}
              onShowTariffSheet={() => setTariffSheetOpen(true)}
            />

            <TariffSheetDialog
              siteId={siteId}
              isOpen={tariffSheetOpen}
              onOpenChange={setTariffSheetOpen}
            />
          </>
        )}
        </Stack>
        </LoadingVeil>
      </Stack>
    </Card>
  );
}
