/**
 * How often a meter is expected to REACH us — the one number every "is this meter
 * still alive?" judgement is built from.
 *
 * This is the gateway's SUBMISSION cadence, not its sampling rate. The Pi polls the
 * SDM630 on a wall-clock-aligned 60s tick into local SQLite, but it only pushes those
 * rows to Postgres on its upload cycle: 30 minutes as of Aug 2026 (it used to upload
 * after every single sample, i.e. ~1/min). So a perfectly healthy meter's newest row
 * is anywhere from seconds to one whole upload period old, depending on where in the
 * cycle you look — and any threshold built around the sampling rate reports the fleet
 * as "degraded" for most of every window even though nothing is wrong.
 *
 * Set METER_REPORT_INTERVAL_MINUTES if the fleet's upload cadence changes again.
 */
const parsed = Number.parseInt(process.env.METER_REPORT_INTERVAL_MINUTES || "", 10);
export const METER_REPORT_INTERVAL_MINUTES = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;

/** Slack on top of the cadence for clock skew and one upload retry. */
const GRACE_MINUTES = 5;

/** Newest reading within one upload period (+grace) ⇒ the meter is reporting normally. */
export const METER_ONLINE_WITHIN_MINUTES = METER_REPORT_INTERVAL_MINUTES + GRACE_MINUTES;

/**
 * Missed one upload window ⇒ degraded; past this ⇒ offline. Two consecutive misses is
 * the first point at which a gap can't be explained by a single retried upload.
 */
export const METER_DEGRADED_WITHIN_MINUTES = 2 * METER_REPORT_INTERVAL_MINUTES + GRACE_MINUTES;

/**
 * Classify a meter from the age of its newest reading. Pure, so the boundaries are
 * testable without a database — the whole bug this encodes was an off-by-a-cadence
 * threshold, not a query.
 */
export function meterStatusFromAge(ageMs: number): "online" | "degraded" | "offline" {
  if (ageMs <= METER_ONLINE_WITHIN_MINUTES * 60_000) return "online";
  if (ageMs <= METER_DEGRADED_WITHIN_MINUTES * 60_000) return "degraded";
  return "offline";
}
