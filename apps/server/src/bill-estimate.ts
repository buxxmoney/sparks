/**
 * Pure helpers for the LIVE "current bill so far" estimate: what the tenant would
 * owe for the in-progress billing period if it ended right now, priced from the
 * meter's raw readings and the site's assigned tariffs. No DB, no clock — the
 * router fetches, these compute.
 */
import { type BillingPeriodPolicy, resolveCurrentPeriod } from "./billing";
import type { PricingBreakdown } from "./tariffs";

/** How the current period's window was decided — surfaced so the UI can caption
 * the estimate ("your billing period" vs "calendar month until one is set"). */
export type EstimatePeriodBasis =
  | "billing_period" // a materialized billing_periods row contains now
  | "policy" // derived from the site's saved billing-cycle policy
  | "inferred_from_invoice" // projected forward from the latest invoice's period
  | "calendar_month"; // no policy or invoice to go on

export interface EstimatePeriod {
  periodStart: Date;
  periodEnd: Date;
  basis: EstimatePeriodBasis;
}

/**
 * Resolve the in-progress billing window for the estimate. Precedence:
 *  1. a concrete `billing_periods` row containing `now` (authored by an invoice,
 *     a human, or policy materialization) — the site's real period;
 *  2. the active billing-cycle policy (settings);
 *  3. the latest invoice-authored period, projected forward — its end day-of-month
 *     becomes the anchor of a day_of_month cycle (an invoice for Jun 25–Jul 24
 *     implies the current period started Jul 25);
 *  4. the calendar month.
 */
export function resolveEstimatePeriod(
  now: Date,
  sources: {
    containingPeriod?: { periodStart: Date; periodEnd: Date } | null;
    policy?: Pick<BillingPeriodPolicy, "recurrence" | "anchorDay"> | null;
    latestInvoicePeriodEnd?: Date | null;
  },
): EstimatePeriod {
  const { containingPeriod, policy, latestInvoicePeriodEnd } = sources;
  if (containingPeriod) {
    return {
      periodStart: containingPeriod.periodStart,
      periodEnd: containingPeriod.periodEnd,
      basis: "billing_period",
    };
  }
  if (policy) {
    return { ...resolveCurrentPeriod(policy, now), basis: "policy" };
  }
  if (latestInvoicePeriodEnd && latestInvoicePeriodEnd.getTime() <= now.getTime()) {
    const window = resolveCurrentPeriod(
      { recurrence: "day_of_month", anchorDay: latestInvoicePeriodEnd.getUTCDate() },
      now,
    );
    return { ...window, basis: "inferred_from_invoice" };
  }
  return {
    ...resolveCurrentPeriod({ recurrence: "calendar_month" }, now),
    basis: "calendar_month",
  };
}

/** The slice of an interval the estimate needs — satisfied both by
 * `demand_intervals` rows and by live intervals bucketed from raw readings. */
export interface EstimateInterval {
  intervalStart: Date;
  activeEnergyKwh: string | null;
  reactiveEnergyKvarh: string | null;
  avgDemandKva: string | null;
  isComplete: boolean;
}

export interface EstimateUsageSummary {
  activeEnergyKwh: string;
  reactiveEnergyKvarh: string;
  /** Peak of the COMPLETE intervals only — an interval missing a boundary reading
   * yields a bogus demand, so it may inform energy but never the peak. */
  maxDemandKva: string;
  intervalCount: number;
  incompleteIntervals: number;
}

export function usageFromIntervals(intervals: EstimateInterval[]): EstimateUsageSummary {
  let active = 0;
  let reactive = 0;
  let peak = 0;
  let incomplete = 0;
  for (const iv of intervals) {
    if (iv.activeEnergyKwh) active += Number(iv.activeEnergyKwh);
    if (iv.reactiveEnergyKvarh) reactive += Number(iv.reactiveEnergyKvarh);
    if (!iv.isComplete) incomplete++;
    else if (iv.avgDemandKva) peak = Math.max(peak, Number(iv.avgDemandKva));
  }
  return {
    activeEnergyKwh: active.toFixed(3),
    reactiveEnergyKvarh: reactive.toFixed(3),
    maxDemandKva: peak.toFixed(3),
    intervalCount: intervals.length,
    incompleteIntervals: incomplete,
  };
}

/** Fraction of the period elapsed at `now`, clamped to [0, 1]. */
export function elapsedFraction(period: { periodStart: Date; periodEnd: Date }, now: Date): number {
  const total = period.periodEnd.getTime() - period.periodStart.getTime();
  if (total <= 0) return 1;
  const elapsed = now.getTime() - period.periodStart.getTime();
  return Math.min(1, Math.max(0, elapsed / total));
}

/** Fraction below which extrapolating is noise, not a projection. */
const MIN_PROJECTION_FRACTION = 0.05;

/**
 * Project a period-end (ex-VAT) total from a to-date breakdown: consumption
 * charges (active + reactive energy + per-kWh ancillary riders) scale linearly
 * with the remaining time; demand (already at its floor/peak), fixed charges and
 * flat ancillary charges are period-level and held — so this is a FLOOR whenever
 * the peak still rises later in the period. A percent-of-subtotal surcharge is
 * recomputed on the projected base. null in the first days of a period, where
 * extrapolation is meaningless.
 */
export function projectedTotalCents(breakdown: PricingBreakdown, fraction: number): number | null {
  if (fraction < MIN_PROJECTION_FRACTION) return null;
  const scaledActive = Math.round(breakdown.activeEnergyCents / fraction);
  const scaledReactive = Math.round(breakdown.reactiveEnergyCents / fraction);
  // Ancillary splits by unit: per-kWh riders (e.g. 6c/kWh network surcharge)
  // grow with consumption; flat/monthly ancillary charges don't.
  const perKwhAncillary = breakdown.details
    .filter((d) => d.chargeType === "ancillary" && d.unit === "c_per_kwh")
    .reduce((s, d) => s + d.amountCents, 0);
  const scaledAncillary =
    Math.round(perKwhAncillary / fraction) + (breakdown.ancillaryCents - perKwhAncillary);
  // The percent surcharge tracks its base (which excludes ancillary).
  const surchargeFraction =
    breakdown.details.find((d) => d.chargeType === "surcharge")?.rateValue ?? 0;
  const projectedBase =
    scaledActive + scaledReactive + breakdown.demandCents + breakdown.fixedCents;
  const projectedSurcharge = surchargeFraction ? Math.round(projectedBase * surchargeFraction) : 0;
  return projectedBase + scaledAncillary + projectedSurcharge;
}
