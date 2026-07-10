import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { devices, getDb, member, organization, siteAccess, sites, user } from "@sparks/db";
import type { AuthContext } from "../middleware";
import { signDeviceBody } from "../ingestion";
import { devicesGet, devicesList, devicesRotateKey, sitesUpdate } from "../routers";

// Adversarial cross-tenant / privilege tests written for the security audit. Each
// documents a CURRENTLY-FAILING guard: the assertion encodes the SECURE behaviour,
// so these tests FAIL against the vulnerable code and PASS once it is fixed.
const db = getDb();

describe("AUDIT — tenant isolation & privilege", () => {
  const orgA = "adv-orgA";
  const orgB = "adv-orgB";
  const ownerA = "adv-ownerA";
  const memberB = "adv-memberB"; // an ordinary member of a DIFFERENT org
  const viewerA = "adv-viewerA"; // read-only grant on org A's site
  let siteA: string;
  let assignedDeviceId: string;
  let unassignedDeviceId: string;
  const knownDeviceKey = randomBytes(32).toString("hex");
  const knownKeyHash = createHash("sha256").update(knownDeviceKey).digest("hex");

  const ctx = (userId: string, organizationId: string): AuthContext => ({
    userId,
    sessionId: `s-${userId}`,
    organizationId,
  });

  beforeEach(async () => {
    await db.insert(organization).values([
      { id: orgA, name: "Org A", slug: `adv-a-${Date.now()}`, createdAt: new Date() },
      { id: orgB, name: "Org B", slug: `adv-b-${Date.now()}`, createdAt: new Date() },
    ]);
    await db.insert(user).values([
      { id: ownerA, email: `${ownerA}@ex.com`, isPlatformOperator: false },
      { id: memberB, email: `${memberB}@ex.com`, isPlatformOperator: false },
      { id: viewerA, email: `${viewerA}@ex.com`, isPlatformOperator: false },
    ]);
    await db.insert(member).values([
      { id: `m-${ownerA}`, organizationId: orgA, userId: ownerA, role: "owner", createdAt: new Date() },
      { id: `m-${memberB}`, organizationId: orgB, userId: memberB, role: "owner", createdAt: new Date() },
      { id: `m-${viewerA}`, organizationId: orgA, userId: viewerA, role: "member", createdAt: new Date() },
    ]);
    const [s] = await db
      .insert(sites)
      .values({ organizationId: orgA, name: "Site A", timezone: "Africa/Johannesburg", demandIntervalMinutes: 30, status: "active" })
      .returning();
    siteA = s.id;
    await db.insert(siteAccess).values({ siteId: siteA, userId: viewerA, role: "viewer" });

    const [assigned] = await db
      .insert(devices)
      .values({ siteId: siteA, serialNumber: `adv-assigned-${Date.now()}`, apiKeyHash: knownKeyHash, status: "online", simIccid: "8927000000000000001" })
      .returning();
    assignedDeviceId = assigned.id;
    // A freshly-provisioned device has NO site yet (siteId null).
    const [unassigned] = await db
      .insert(devices)
      .values({ serialNumber: `adv-unassigned-${Date.now()}`, apiKeyHash: knownKeyHash, status: "provisioning" })
      .returning();
    unassignedDeviceId = unassigned.id;
  });

  afterEach(async () => {
    await db.delete(devices).where(true as never);
    await db.delete(siteAccess).where(true as never);
    await db.delete(sites).where(true as never);
    await db.delete(member).where(true as never);
    await db.delete(organization).where(true as never);
    await db.delete(user).where(true as never);
  });

  it("F1: devices.list must NOT return another org's devices (or their apiKeyHash)", async () => {
    // memberB belongs to Org B only. Calling devices.list with no siteId currently
    // returns EVERY device on the platform, including Org A's — and the row carries
    // apiKeyHash, which IS the HMAC signing key (see F2b).
    const res = await devicesList(ctx(memberB, orgB), {});
    const leakedIds = res.devices.map((d) => d.id);
    expect(leakedIds).not.toContain(assignedDeviceId);
    expect(leakedIds).not.toContain(unassignedDeviceId);
  });

  it("F2a: devices.get on an unassigned (siteId=null) device must be authorized", async () => {
    // No site → the `if (device.siteId)` guard is skipped entirely, so any logged-in
    // user reads any unassigned device.
    await expect(devicesGet(ctx(memberB, orgB), { deviceId: unassignedDeviceId })).rejects.toThrow();
  });

  it("F2b: devices.rotateKey on an unassigned device must be authorized (key theft)", async () => {
    // A cross-tenant caller rotates the key of an unassigned device and RECEIVES the
    // new plaintext secret — full control of ingestion once the device is deployed.
    await expect(
      devicesRotateKey(ctx(memberB, orgB), { deviceId: unassignedDeviceId }),
    ).rejects.toThrow();
  });

  it("F2c: leaked apiKeyHash is sufficient to forge a valid /ingest/readings signature", async () => {
    // Demonstrates WHY leaking apiKeyHash (F1) is critical: the stored hash is itself
    // the HMAC key, so an attacker who reads it can sign an arbitrary body WITHOUT the
    // device key. Signing keyed by the stored hash alone reproduces the device's sig.
    const { createHmac } = await import("node:crypto");
    const body = JSON.stringify({ readings: [], timestamp: new Date().toISOString() });
    const deviceSig = signDeviceBody(knownDeviceKey, body); // what a real device sends
    const forgedFromStoredHashOnly = createHmac("sha256", knownKeyHash).update(body).digest("hex");
    expect(forgedFromStoredHashOnly).toBe(deviceSig);
  });

  it("F3: a viewer must NOT be able to mutate site settings via sites.update", async () => {
    // viewerA has a read-only grant. sites.update calls requireSiteAccess with no
    // minLevel, so the write currently succeeds.
    await expect(
      sitesUpdate(ctx(viewerA, orgA), { siteId: siteA, name: "HACKED BY VIEWER" }),
    ).rejects.toThrow();
    const after = await db.query.sites.findFirst({ where: (s, { eq }) => eq(s.id, siteA) });
    expect(after?.name).toBe("Site A");
  });
});
