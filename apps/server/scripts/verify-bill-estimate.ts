/**
 * Read-only verification of the live current-bill estimate (billing.currentEstimate).
 * Calls the REAL endpoint handler (authz included) as an existing user and prints the
 * resolved period, usage, and priced breakdown per role. Writes NOTHING.
 *
 * Usage (from apps/server):
 *   bun scripts/verify-bill-estimate.ts <userEmail> [siteId]
 *
 * Loads apps/server/.env for DATABASE_URL, so it targets the same DB the dev server uses.
 */
import "dotenv/config";
import { getDb, member, sites, user } from "@sparks/db";
import { asc, eq } from "drizzle-orm";
import { billingCurrentEstimate } from "../src/routers";

const email = process.argv[2];
const argSite = process.argv[3];
if (!email) {
  console.error("Usage: bun scripts/verify-bill-estimate.ts <userEmail> [siteId]");
  process.exit(1);
}

const db = getDb();
const u = await db.query.user.findFirst({ where: eq(user.email, email) });
if (!u) {
  console.error(`✗ No user with email "${email}".`);
  process.exit(1);
}
const memberships = await db.query.member.findMany({ where: eq(member.userId, u.id) });

const site = argSite
  ? await db.query.sites.findFirst({ where: eq(sites.id, argSite) })
  : await db.query.sites.findFirst({ orderBy: [asc(sites.name)] });
if (!site) {
  console.error("✗ No site found.");
  process.exit(1);
}
// Act under the membership that owns the site when there is one (operators pass
// cross-tenant anyway).
const membership =
  memberships.find((m) => m.organizationId === site.organizationId) ?? memberships[0];
console.log(`user: ${email}  site: ${site.name} (${site.id})\n`);

const ctx = {
  userId: u.id,
  sessionId: "verify-script",
  organizationId: membership?.organizationId ?? "",
};

const t0 = Date.now();
const est = await billingCurrentEstimate(ctx, { siteId: site.id });
console.log(`computed in ${Date.now() - t0}ms\n`);

const rand = (c: number | null | undefined) => (c == null ? "—" : `R ${(c / 100).toFixed(2)}`);
console.log(`period: ${est.period.periodStart} → ${est.period.periodEnd}`);
console.log(`basis:  ${est.period.basis}   elapsed: ${(est.elapsedFraction * 100).toFixed(1)}%\n`);
console.log(
  `usage:  ${est.usage.activeEnergyKwh} kWh   peak ${est.usage.maxDemandKva} kVA   ` +
    `${est.usage.reactiveEnergyKvarh} kVArh   (${est.usage.intervalCount} intervals, ` +
    `${est.usage.incompleteIntervals} with gaps)\n`,
);

for (const role of ["landlord", "ceiling"] as const) {
  const r = est[role];
  if (!r) {
    console.log(`${role}: no tariff assigned`);
    continue;
  }
  const p = r.pricing;
  console.log(
    `${role}:  total so far ${rand(p.totalCents)}   projected ${rand(r.projectedTotalCents)}`,
  );
  if (r.demandFloor) {
    const df = r.demandFloor;
    console.log(
      `   ⚠ minimum-demand floor: billed ${df.billedDemandKva} kVA vs measured ${df.measuredDemandKva.toFixed(2)} kVA`,
    );
    console.log(
      `     on actual usage total would be ${rand(df.usageBasedTotalInclVatCents)} incl VAT — the floor adds ${rand(df.extraInclVatCents)}`,
    );
  }
  console.log(
    `   active ${rand(p.activeEnergyCents)}  demand ${rand(p.demandCents)}  ` +
      `reactive ${rand(p.reactiveEnergyCents)}  fixed ${rand(p.fixedCents)}  ancillary ${rand(p.ancillaryCents)}`,
  );
  for (const d of p.details) {
    console.log(
      `     · ${d.chargeType} @ ${d.rateValue} ${d.unit} [${d.season}/${d.touPeriod}] = ${rand(d.amountCents)}`,
    );
  }
}
process.exit(0);
