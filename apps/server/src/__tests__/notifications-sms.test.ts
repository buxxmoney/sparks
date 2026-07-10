import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  alertDeliveries,
  alerts,
  db,
  member,
  organization,
  sites,
  user,
} from "@sparks/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { dispatchInvoiceParsed, dispatchReviewSubmitted } from "../notifications";

// The customer gets a text at each step (parsed, submitted, outcome) — matching their
// in-app alerts — IF they've saved a number. sendSms itself no-ops under NODE_ENV=test,
// but the dispatcher still records a channel='sms' delivery, which is what we assert.
describe("SMS parity for customer updates", () => {
  const orgId = "sms-org";
  const withPhone = "sms-user-phone";
  const noPhone = "sms-user-nophone";
  let siteId: string;

  beforeEach(async () => {
    await db.insert(user).values([
      { id: withPhone, email: "phone@example.com", phone: "+27821234567" },
      { id: noPhone, email: "nophone@example.com", phone: null },
    ]);
    await db
      .insert(organization)
      .values({ id: orgId, name: "SMS Org", slug: `sms-${Date.now()}`, createdAt: new Date() });
    await db.insert(member).values([
      { id: randomUUID(), organizationId: orgId, userId: withPhone, role: "owner", createdAt: new Date() },
      { id: randomUUID(), organizationId: orgId, userId: noPhone, role: "owner", createdAt: new Date() },
    ]);
    const [site] = await db
      .insert(sites)
      .values({
        organizationId: orgId,
        name: "SMS Site",
        timezone: "UTC",
        demandIntervalMinutes: 30,
        status: "active",
      })
      .returning();
    siteId = site.id;
  });

  afterEach(async () => {
    await db.delete(alertDeliveries).where(true as never);
    await db.delete(alerts).where(true as never);
    await db.delete(member).where(true as never);
    await db.delete(sites).where(true as never);
    await db.delete(organization).where(true as never);
    await db.delete(user).where(true as never);
  });

  const smsDeliveriesFor = (userId: string) =>
    db
      .select({ id: alertDeliveries.id })
      .from(alertDeliveries)
      .where(and(eq(alertDeliveries.recipientUserId, userId), eq(alertDeliveries.channel, "sms")));

  it("texts a 'sent to Sparks' update to recipients with a phone (and only them)", async () => {
    await dispatchReviewSubmitted({
      invoiceId: randomUUID(),
      siteId,
      organizationId: orgId,
      siteName: "SMS Site",
    });
    expect(await smsDeliveriesFor(withPhone)).toHaveLength(1);
    expect(await smsDeliveriesFor(noPhone)).toHaveLength(0);
  });

  it("texts an 'invoice ready' update on parse", async () => {
    await dispatchInvoiceParsed({
      invoiceId: randomUUID(),
      siteId,
      organizationId: orgId,
      siteName: "SMS Site",
      ok: true,
    });
    expect(await smsDeliveriesFor(withPhone)).toHaveLength(1);
    expect(await smsDeliveriesFor(noPhone)).toHaveLength(0);
  });
});
