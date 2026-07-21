import { eq, sql } from "drizzle-orm";
import { getDb, meters } from "@sparks/db";
import { PreconditionError } from "./middleware";

/**
 * A meter-verified report (and the operator's "verified" sign-off that unlocks it)
 * must be backed by ACTUAL metered data. When no readings fall inside the billing
 * period, every measured figure is 0 and the "discrepancy" is meaningless — the
 * tariff is simply applied to 0 usage, so a real bill reads as a huge false
 * overcharge (see the Feb–Mar invoice against a meter that only started in July).
 *
 * Refuse to verify or seal in that state, with a message that points straight at
 * the mismatch: the billing period vs. the window the meter actually covers.
 * Throws PreconditionError when there's no metered data; returns normally otherwise.
 */
export async function assertMeteredDataInPeriod(recon: {
  siteId: string;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  measuredActiveKwh: string | null;
  measuredMaxDemandKva: string | null;
  measuredReactiveKvarh: string | null;
}): Promise<void> {
  const active = Number(recon.measuredActiveKwh ?? 0);
  const demand = Number(recon.measuredMaxDemandKva ?? 0);
  const reactive = Number(recon.measuredReactiveKvarh ?? 0);
  // Any real metered usage → nothing to guard.
  if (active !== 0 || demand !== 0 || reactive !== 0) return;

  const db = getDb();
  const day = (d: string | Date) => new Date(d).toISOString().slice(0, 10);

  // Best-effort context for the message: how far the meter's readings actually
  // reach. Never let this lookup swallow the block itself — if it fails, we still
  // refuse, just without the coverage hint.
  let coverageHint = "";
  try {
    const meterRows = await db
      .select({ id: meters.id })
      .from(meters)
      .where(eq(meters.siteId, recon.siteId));
    const meterIds = meterRows.map((m) => m.id);
    if (meterIds.length === 0) {
      coverageHint = " This site has no meter on file.";
    } else {
      const idList = sql.join(
        meterIds.map((id) => sql`${id}`),
        sql`, `,
      );
      const res = await db.execute(
        sql`SELECT MIN(measured_at) AS earliest, MAX(measured_at) AS latest FROM readings WHERE meter_id IN (${idList})`,
      );
      const row = res.rows[0] as
        | { earliest: string | Date | null; latest: string | Date | null }
        | undefined;
      coverageHint = row?.earliest
        ? ` The meter's readings only run ${day(row.earliest)} → ${row.latest ? day(row.latest) : "?"}.`
        : " This meter has no readings on file yet.";
    }
  } catch (err) {
    console.error(`[report-guard] coverage-hint lookup failed for site ${recon.siteId}:`, err);
  }

  throw new PreconditionError(
    `No meter readings fall within this billing period (${day(recon.billingPeriodStart)} → ${day(
      recon.billingPeriodEnd,
    )}), so there's nothing to verify against — every measured figure is 0.${coverageHint} Adjust the billing period to a window the meter covers before verifying or generating the report.`,
  );
}
