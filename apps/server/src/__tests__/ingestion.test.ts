import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  db,
  devices,
  meters,
  readings,
  demandIntervals,
  dataGaps,
  deviceHealthSamples,
  sites,
} from "@sparks/db";
import { randomUUID, createHash } from "node:crypto";
import { eq, asc } from "drizzle-orm";
import { app } from "../index";
import { signDeviceBody } from "../ingestion";

// The device key the edge agent holds; the server stores only sha256(deviceKey).
let testSiteId: string;
let testDeviceId: string;
let testMeterId: string;
let testDeviceKey: string;

function keyHash(deviceKey: string): string {
  return createHash("sha256").update(deviceKey).digest("hex");
}

// POST a JSON body to a mounted route with a valid (or caller-supplied) device signature.
async function postSigned(
  path: string,
  deviceId: string,
  signingKey: string,
  bodyObj: unknown,
  signatureOverride?: string,
): Promise<Response> {
  const rawBody = JSON.stringify(bodyObj);
  const signature = signatureOverride ?? signDeviceBody(signingKey, rawBody);
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-device-id": deviceId,
      "x-signature": signature,
    },
    body: rawBody,
  });
}

async function setupTestData() {
  testSiteId = randomUUID();
  testDeviceId = randomUUID();
  testMeterId = randomUUID();
  testDeviceKey = randomUUID();

  await db.insert(sites).values({
    id: testSiteId,
    organizationId: "test-org",
    name: "Test Site",
    timezone: "UTC",
    demandIntervalMinutes: 30,
  });

  await db.insert(devices).values({
    id: testDeviceId,
    siteId: testSiteId,
    serialNumber: `DEVICE-${randomUUID()}`,
    hardwareModel: "rpi",
    apiKeyHash: keyHash(testDeviceKey),
    status: "online",
  });

  await db.insert(meters).values({
    id: testMeterId,
    siteId: testSiteId,
    serialNumber: `METER-${randomUUID()}`,
    model: "SDM630MCT",
  });
}

async function cleanupMeter(meterId: string) {
  await db.delete(demandIntervals).where(eq(demandIntervals.meterId, meterId));
  await db.delete(dataGaps).where(eq(dataGaps.meterId, meterId));
  await db.delete(readings).where(eq(readings.meterId, meterId));
  await db.delete(meters).where(eq(meters.id, meterId));
}

async function cleanupTestData() {
  await db.delete(deviceHealthSamples).where(eq(deviceHealthSamples.deviceId, testDeviceId));
  await cleanupMeter(testMeterId);
  await db.delete(devices).where(eq(devices.id, testDeviceId));
  await db.delete(sites).where(eq(sites.id, testSiteId));
}

describe("Device Ingestion API (mounted route)", () => {
  beforeEach(setupTestData);
  afterEach(cleanupTestData);

  // Regression guard: the route must be wired, not the 501 placeholder. If index.ts
  // ever reverts to the stub, this fails loudly.
  it("mounts POST /ingest/readings (never a 501 stub)", async () => {
    const res = await app.request("/ingest/readings", { method: "POST" });
    expect(res.status).not.toBe(501);
  });

  it("rejects a bad HMAC signature with 401", async () => {
    const body = {
      timestamp: new Date().toISOString(),
      readings: [{ meterId: testMeterId, time: new Date().toISOString(), seq: 1 }],
    };
    // Sign with the wrong key → signature does not verify.
    const res = await postSigned("/ingest/readings", testDeviceId, "wrong-key", body);
    expect(res.status).toBe(401);

    // And a syntactically bogus signature is rejected too (constant-time compare guards length).
    const res2 = await postSigned("/ingest/readings", testDeviceId, testDeviceKey, body, "deadbeef");
    expect(res2.status).toBe(401);
  });

  it("accepts a validly-signed batch and returns the highest seq", async () => {
    const t0 = new Date("2026-07-15T08:00:00Z");
    const body = {
      timestamp: t0.toISOString(),
      readings: [
        { meterId: testMeterId, time: t0.toISOString(), seq: 100, activeEnergyKwh: "1000.000", totalPowerKw: "5.5", totalApparentKva: "6.0", powerFactor: "0.9167" },
        { meterId: testMeterId, time: new Date(t0.getTime() + 60000).toISOString(), seq: 101, activeEnergyKwh: "1001.000", totalPowerKw: "5.4" },
      ],
    };

    const res = await postSigned("/ingest/readings", testDeviceId, testDeviceKey, body);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: number; highestSeq: number };
    expect(json.accepted).toBe(2);
    expect(json.highestSeq).toBe(101);

    const saved = await db.select().from(readings).where(eq(readings.meterId, testMeterId));
    expect(saved.length).toBe(2);
  });

  it("idempotently upserts a re-POSTed batch (no duplicate rows)", async () => {
    const t0 = new Date("2026-07-15T09:00:00Z");
    const body = {
      timestamp: t0.toISOString(),
      readings: [
        { meterId: testMeterId, time: t0.toISOString(), seq: 200, activeEnergyKwh: "2000.000" },
        { meterId: testMeterId, time: new Date(t0.getTime() + 60000).toISOString(), seq: 201, activeEnergyKwh: "2001.000" },
      ],
    };

    const first = await postSigned("/ingest/readings", testDeviceId, testDeviceKey, body);
    expect(first.status).toBe(200);
    const countAfterFirst = (await db.select().from(readings).where(eq(readings.meterId, testMeterId))).length;

    const second = await postSigned("/ingest/readings", testDeviceId, testDeviceKey, body);
    expect(second.status).toBe(200);
    const countAfterSecond = (await db.select().from(readings).where(eq(readings.meterId, testMeterId))).length;

    expect(countAfterFirst).toBe(2);
    expect(countAfterSecond).toBe(2);
  });

  // Golden-file interval alignment (R2): clock-aligned 30-min boundaries; a batch that
  // crosses 23:45→00:00 must split into two intervals ([23:30,00:00) and [00:00,00:30)),
  // never one merged interval. Energy per interval = register delta of its own readings.
  it("aligns demand intervals to clock boundaries across the 23:45→00:00 boundary", async () => {
    const body = {
      timestamp: "2026-07-15T23:45:00Z",
      readings: [
        { meterId: testMeterId, time: "2026-07-15T23:45:00Z", seq: 1, activeEnergyKwh: "200.000" },
        { meterId: testMeterId, time: "2026-07-15T23:55:00Z", seq: 2, activeEnergyKwh: "202.000" },
        { meterId: testMeterId, time: "2026-07-16T00:05:00Z", seq: 3, activeEnergyKwh: "203.000" },
        { meterId: testMeterId, time: "2026-07-16T00:20:00Z", seq: 4, activeEnergyKwh: "206.000" },
      ],
    };

    const res = await postSigned("/ingest/readings", testDeviceId, testDeviceKey, body);
    expect(res.status).toBe(200);

    const intervals = await db
      .select()
      .from(demandIntervals)
      .where(eq(demandIntervals.meterId, testMeterId))
      .orderBy(asc(demandIntervals.intervalStart));

    expect(intervals.length).toBe(2);
    expect(new Date(intervals[0]!.intervalStart).toISOString()).toBe("2026-07-15T23:30:00.000Z");
    expect(intervals[0]!.activeEnergyKwh).toBe("2.000"); // 200 → register at 00:00 (last ≤ 00:00 = 202)
    expect(new Date(intervals[1]!.intervalStart).toISOString()).toBe("2026-07-16T00:00:00.000Z");
    // 202 → 206: the 1 kWh consumed across the 23:55→00:05 boundary is attributed here (the old
    // first/last-within-interval logic dropped it, giving 3.000 and losing energy).
    expect(intervals[1]!.activeEnergyKwh).toBe("4.000");
    // Register-at-boundary conserves energy: Σ deltas = 2 + 4 = 6 = last(206) − first(200).
    const total = intervals.reduce((s, iv) => s + Number.parseFloat(iv.activeEnergyKwh ?? "0"), 0);
    expect(total).toBeCloseTo(6, 3);
  });

  // Golden-file (R1): a dropped mid-interval minute must not bias interval energy —
  // because energy fields are cumulative registers, the interval delta (last − first)
  // is exact regardless of a missing sample.
  it("keeps interval energy correct when a mid-interval minute is dropped", async () => {
    // Interval [00:00,00:30): samples at :00 :05 :10 :20 :25 — the :15 minute is dropped.
    const body = {
      timestamp: "2026-07-15T00:00:00Z",
      readings: [
        { meterId: testMeterId, time: "2026-07-15T00:00:00Z", seq: 1, activeEnergyKwh: "100.000" },
        { meterId: testMeterId, time: "2026-07-15T00:05:00Z", seq: 2, activeEnergyKwh: "101.000" },
        { meterId: testMeterId, time: "2026-07-15T00:10:00Z", seq: 3, activeEnergyKwh: "102.000" },
        { meterId: testMeterId, time: "2026-07-15T00:20:00Z", seq: 5, activeEnergyKwh: "104.000" },
        { meterId: testMeterId, time: "2026-07-15T00:25:00Z", seq: 6, activeEnergyKwh: "105.000" },
      ],
    };

    const res = await postSigned("/ingest/readings", testDeviceId, testDeviceKey, body);
    expect(res.status).toBe(200);

    const intervals = await db
      .select()
      .from(demandIntervals)
      .where(eq(demandIntervals.meterId, testMeterId))
      .orderBy(asc(demandIntervals.intervalStart));

    expect(intervals.length).toBe(1);
    const iv = intervals[0]!;
    // Energy = 105 − 100 = 5 kWh, exact despite the missing minute.
    expect(iv.activeEnergyKwh).toBe("5.000");
    // avg demand = 5 kWh / 0.5 h = 10 kW.
    expect(iv.avgDemandKw).toBe("10.000");
    // Only 5 of 30 expected samples present → flagged incomplete for downstream gap handling.
    expect(iv.sampleCount).toBe(5);
    expect(iv.isComplete).toBe(false);
  });

  // R1 (rollover): a cumulative register that DECREASES across a boundary (meter reset /
  // register wrap) must yield 0 interval energy, never a negative delta.
  it("clamps a rollover/reset (decreasing register) to 0, not negative energy", async () => {
    const body = {
      timestamp: "2026-07-15T00:00:00Z",
      readings: [
        { meterId: testMeterId, time: "2026-07-15T00:00:00Z", seq: 1, activeEnergyKwh: "100.000" },
        { meterId: testMeterId, time: "2026-07-15T00:20:00Z", seq: 2, activeEnergyKwh: "105.000" },
        // Register resets to 50 — the next interval's delta (52 − 105) is negative.
        { meterId: testMeterId, time: "2026-07-15T00:35:00Z", seq: 3, activeEnergyKwh: "50.000" },
        { meterId: testMeterId, time: "2026-07-15T00:50:00Z", seq: 4, activeEnergyKwh: "52.000" },
      ],
    };
    const res = await postSigned("/ingest/readings", testDeviceId, testDeviceKey, body);
    expect(res.status).toBe(200);

    const intervals = await db
      .select()
      .from(demandIntervals)
      .where(eq(demandIntervals.meterId, testMeterId))
      .orderBy(asc(demandIntervals.intervalStart));

    expect(intervals.length).toBe(2);
    expect(intervals[0]!.activeEnergyKwh).toBe("5.000"); // 100 → 105
    expect(intervals[1]!.activeEnergyKwh).toBe("0.000"); // 105 → 52 would be −53; clamped to 0
    expect(Number.parseFloat(intervals[1]!.avgDemandKw ?? "0")).toBeGreaterThanOrEqual(0);
  });

  describe("POST /device/commission", () => {
    let provDeviceId: string;
    let provMeterId: string;
    let provToken: string;

    beforeEach(async () => {
      provDeviceId = randomUUID();
      provMeterId = randomUUID();
      provToken = randomUUID();

      await db.insert(devices).values({
        id: provDeviceId,
        siteId: testSiteId,
        serialNumber: `PROV-${randomUUID()}`,
        hardwareModel: "rpi",
        apiKeyHash: keyHash(provToken), // provisioning token hash, replaced on commission
        status: "provisioning",
      });

      await db.insert(meters).values({
        id: provMeterId,
        siteId: testSiteId,
        serialNumber: `PROV-METER-${randomUUID()}`,
        model: "SDM630MCT",
      });
    });

    afterEach(async () => {
      await cleanupMeter(provMeterId);
      await db.delete(devices).where(eq(devices.id, provDeviceId));
    });

    it("issues a usable device key and rejects reuse of the one-time token", async () => {
      const res = await app.request("/device/commission", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: provDeviceId, provisioningToken: provToken }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { deviceId: string; deviceKey: string };
      expect(json.deviceKey).toBeTruthy();

      // Device is now online and the stored hash matches the issued key (not the token).
      const dev = (await db.select().from(devices).where(eq(devices.id, provDeviceId)))[0]!;
      expect(dev.status).toBe("online");
      expect(dev.apiKeyHash).toBe(keyHash(json.deviceKey));

      // The issued key actually works for signed ingest.
      const ingest = await postSigned(
        "/ingest/readings",
        provDeviceId,
        json.deviceKey,
        {
          timestamp: "2026-07-15T10:00:00Z",
          readings: [{ meterId: provMeterId, time: "2026-07-15T10:00:00Z", seq: 1, activeEnergyKwh: "1.000" }],
        },
      );
      expect(ingest.status).toBe(200);

      // The one-time token cannot be replayed — device already left `provisioning`.
      const replay = await app.request("/device/commission", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: provDeviceId, provisioningToken: provToken }),
      });
      expect(replay.status).toBe(409);
    });

    it("rejects an invalid provisioning token with 401", async () => {
      const res = await app.request("/device/commission", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: provDeviceId, provisioningToken: "not-the-token" }),
      });
      expect(res.status).toBe(401);
    });
  });
});
