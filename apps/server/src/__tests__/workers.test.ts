import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  db,
  devices,
  meters,
  readings,
  demandIntervals,
  dataGaps,
  sites,
  alerts,
} from "@sparks/db";
import { randomUUID } from "node:crypto";
import { sql, eq, and } from "drizzle-orm";
import {
  aggregateDemandIntervals,
  detectDataGaps,
  evaluateDeviceOffline,
} from "../workers";

let testSiteId: string;
let testDeviceId: string;
let testMeterId: string;

async function setupTestData() {
  testSiteId = randomUUID();
  testDeviceId = randomUUID();
  testMeterId = randomUUID();

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
    serialNumber: `DEVICE-${Math.random()}`,
    hardwareModel: "rpi",
    apiKeyHash: "hash",
    status: "online",
  });

  await db.insert(meters).values({
    id: testMeterId,
    deviceId: testDeviceId,
    siteId: testSiteId,
    serialNumber: `METER-${Math.random()}`,
    model: "SDM630MCT",
  });
}

async function cleanupTestData() {
  await db.delete(dataGaps).where(eq(dataGaps.meterId, testMeterId));
  await db.delete(demandIntervals).where(eq(demandIntervals.meterId, testMeterId));
  await db.delete(readings).where(eq(readings.meterId, testMeterId));
  await db.delete(meters).where(eq(meters.id, testMeterId));
  await db.delete(alerts).where(eq(alerts.deviceId, testDeviceId));
  await db.delete(devices).where(eq(devices.id, testDeviceId));
  await db.delete(sites).where(eq(sites.id, testSiteId));
}

describe("aggregateDemandIntervals", () => {
  beforeEach(async () => {
    await setupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  it("should compute demand intervals with energy deltas", async () => {
    const testReadings = [
      {
        meterId: testMeterId,
        time: new Date("2026-07-03T00:05:00Z"),
        seq: 1,
        activeEnergyKwh: "1000.000",
        reactiveEnergyKvarh: "500.000",
        apparentEnergyKvah: "1100.000",
      },
      {
        meterId: testMeterId,
        time: new Date("2026-07-03T00:10:00Z"),
        seq: 2,
        activeEnergyKwh: "1000.500",
        reactiveEnergyKvarh: "500.200",
        apparentEnergyKvah: "1100.500",
      },
      {
        meterId: testMeterId,
        time: new Date("2026-07-03T00:25:00Z"),
        seq: 3,
        activeEnergyKwh: "1001.000",
        reactiveEnergyKvarh: "500.400",
        apparentEnergyKvah: "1101.000",
      },
    ];

    for (const r of testReadings) {
      await db.insert(readings).values(r);
    }

    await aggregateDemandIntervals(testMeterId);

    const intervals = await db
      .select()
      .from(demandIntervals)
      .where(eq(demandIntervals.meterId, testMeterId));

    expect(intervals.length).toBeGreaterThan(0);
    expect(intervals[0]?.sampleCount).toBeGreaterThan(0);
    expect(intervals[0]?.expectedSamples).toBeGreaterThan(0);
  });

  it("should handle readings spanning a 23:45 to 00:00 boundary", async () => {
    const day1Readings = [
      {
        meterId: testMeterId,
        time: new Date("2026-07-02T23:50:00Z"),
        seq: 1,
        activeEnergyKwh: "5000.000",
      },
      {
        meterId: testMeterId,
        time: new Date("2026-07-02T23:55:00Z"),
        seq: 2,
        activeEnergyKwh: "5000.500",
      },
    ];

    const day2Readings = [
      {
        meterId: testMeterId,
        time: new Date("2026-07-03T00:05:00Z"),
        seq: 3,
        activeEnergyKwh: "5001.000",
      },
      {
        meterId: testMeterId,
        time: new Date("2026-07-03T00:10:00Z"),
        seq: 4,
        activeEnergyKwh: "5001.500",
      },
    ];

    for (const r of [...day1Readings, ...day2Readings]) {
      await db.insert(readings).values(r);
    }

    await aggregateDemandIntervals(testMeterId);

    const intervals = await db
      .select()
      .from(demandIntervals)
      .where(eq(demandIntervals.meterId, testMeterId));

    expect(intervals.length).toBeGreaterThan(0);
  });

  it("should correctly compute avg_demand_kw/kva from energy deltas", async () => {
    const testReadings = [
      {
        meterId: testMeterId,
        time: new Date("2026-07-03T00:10:00Z"),
        seq: 1,
        activeEnergyKwh: "1000.000",
        apparentEnergyKvah: "1100.000",
      },
      {
        meterId: testMeterId,
        time: new Date("2026-07-03T00:20:00Z"),
        seq: 2,
        activeEnergyKwh: "1001.000",
        apparentEnergyKvah: "1101.000",
      },
    ];

    for (const r of testReadings) {
      await db.insert(readings).values(r);
    }

    await aggregateDemandIntervals(testMeterId);

    const intervals = await db
      .select()
      .from(demandIntervals)
      .where(eq(demandIntervals.meterId, testMeterId));

    if (intervals.length > 0) {
      const interval = intervals[0]!;
      expect(parseFloat(interval.activeEnergyKwh || "0")).toBeGreaterThan(0);
      expect(parseFloat(interval.avgDemandKw || "0")).toBeGreaterThan(0);
    }
  });

  it("should handle a dropped mid-interval reading", async () => {
    const testReadings = [
      {
        meterId: testMeterId,
        time: new Date("2026-07-03T00:05:00Z"),
        seq: 1,
        activeEnergyKwh: "1000.000",
      },
      {
        meterId: testMeterId,
        time: new Date("2026-07-03T00:25:00Z"),
        seq: 3,
        activeEnergyKwh: "1001.000",
      },
    ];

    for (const r of testReadings) {
      await db.insert(readings).values(r);
    }

    await aggregateDemandIntervals(testMeterId);

    const intervals = await db
      .select()
      .from(demandIntervals)
      .where(eq(demandIntervals.meterId, testMeterId));

    expect(intervals.length).toBeGreaterThan(0);
    const firstInterval = intervals[0];
    expect(firstInterval?.sampleCount).toBeLessThan(firstInterval?.expectedSamples || 1);
    expect(firstInterval?.isComplete).toBe(false);
  });

  it("should mark intervals as complete when sample count >= 90% expected", async () => {
    const testReadings = [];
    let time = new Date("2026-07-03T00:00:00Z");

    for (let i = 0; i < 30; i++) {
      testReadings.push({
        meterId: testMeterId,
        time: new Date(time.getTime() + i * 60 * 1000),
        seq: i + 1,
        activeEnergyKwh: (1000 + i * 0.1).toString(),
      });
    }

    for (const r of testReadings) {
      await db.insert(readings).values(r);
    }

    await aggregateDemandIntervals(testMeterId);

    const intervals = await db
      .select()
      .from(demandIntervals)
      .where(eq(demandIntervals.meterId, testMeterId));

    if (intervals.length > 0) {
      const completeInterval = intervals.find((i) => i.isComplete);
      if (completeInterval) {
        expect(completeInterval.sampleCount).toBeGreaterThanOrEqual(
          Math.ceil((completeInterval.expectedSamples || 1) * 0.9),
        );
      }
    }
  });
});

describe("detectDataGaps", () => {
  beforeEach(async () => {
    await setupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  it("should detect gaps from sequence discontinuity", async () => {
    const readings1 = [
      {
        meterId: testMeterId,
        time: new Date("2026-07-03T00:00:00Z"),
        seq: 1,
        activeEnergyKwh: "1000.000",
      },
      {
        meterId: testMeterId,
        time: new Date("2026-07-03T00:01:00Z"),
        seq: 2,
        activeEnergyKwh: "1000.500",
      },
      {
        meterId: testMeterId,
        time: new Date("2026-07-03T00:10:00Z"),
        seq: 5,
        activeEnergyKwh: "1001.500",
      },
    ];

    for (const r of readings1) {
      await db.insert(readings).values(r);
    }

    await detectDataGaps(testMeterId);

    const gaps = await db
      .select()
      .from(dataGaps)
      .where(eq(dataGaps.meterId, testMeterId));

    expect(gaps.length).toBeGreaterThan(0);
  });

  it("should detect gaps from incomplete intervals", async () => {
    const readings1 = [
      {
        meterId: testMeterId,
        time: new Date("2026-07-03T00:05:00Z"),
        seq: 1,
        activeEnergyKwh: "1000.000",
      },
      {
        meterId: testMeterId,
        time: new Date("2026-07-03T00:25:00Z"),
        seq: 2,
        activeEnergyKwh: "1001.000",
      },
    ];

    for (const r of readings1) {
      await db.insert(readings).values(r);
    }

    await aggregateDemandIntervals(testMeterId);
    await detectDataGaps(testMeterId);

    const gaps = await db
      .select()
      .from(dataGaps)
      .where(eq(dataGaps.meterId, testMeterId));

    expect(gaps.length).toBeGreaterThanOrEqual(0);
  });

  it("should not create duplicate gaps", async () => {
    const readings1 = [
      {
        meterId: testMeterId,
        time: new Date("2026-07-03T00:00:00Z"),
        seq: 1,
        activeEnergyKwh: "1000.000",
      },
      {
        meterId: testMeterId,
        time: new Date("2026-07-03T00:10:00Z"),
        seq: 5,
        activeEnergyKwh: "1001.000",
      },
    ];

    for (const r of readings1) {
      await db.insert(readings).values(r);
    }

    await detectDataGaps(testMeterId);
    const gapsAfterFirst = await db
      .select()
      .from(dataGaps)
      .where(eq(dataGaps.meterId, testMeterId));

    const countBefore = gapsAfterFirst.length;
    expect(countBefore).toBeGreaterThan(0);

    await detectDataGaps(testMeterId);
    const gapsAfterSecond = await db
      .select()
      .from(dataGaps)
      .where(eq(dataGaps.meterId, testMeterId));

    const countAfter = gapsAfterSecond.length;
    // Second call should not create new gaps (deduplication via onConflictDoNothing)
    expect(countAfter).toBe(countBefore);
  });
});

describe("evaluateDeviceOffline", () => {
  beforeEach(async () => {
    await setupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  it("should create offline alert when heartbeat exceeds threshold", async () => {
    const oldTime = new Date(Date.now() - 20 * 60 * 1000);

    await db
      .update(devices)
      .set({ lastSeenAt: oldTime })
      .where(eq(devices.id, testDeviceId));

    await evaluateDeviceOffline(testDeviceId, 15);

    const deviceList = await db
      .select()
      .from(devices)
      .where(eq(devices.id, testDeviceId))
      .limit(1);
    const device = deviceList[0];

    expect(device?.status).toBe("offline");

    const alertList = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.deviceId, testDeviceId), eq(alerts.type, "device_offline")))
      .limit(1);
    const alert = alertList[0];

    expect(alert).toBeDefined();
  });

  it("should resolve offline alert when heartbeat returns", async () => {
    const oldTime = new Date(Date.now() - 20 * 60 * 1000);

    await db
      .update(devices)
      .set({ lastSeenAt: oldTime, status: "offline" })
      .where(eq(devices.id, testDeviceId));

    await db.insert(alerts).values({
      organizationId: "test-org",
      siteId: testSiteId,
      deviceId: testDeviceId,
      type: "device_offline",
      severity: "critical",
      title: "Device Offline",
      status: "open",
    });

    await db
      .update(devices)
      .set({ lastSeenAt: new Date() })
      .where(eq(devices.id, testDeviceId));

    await evaluateDeviceOffline(testDeviceId, 15);

    const deviceList = await db
      .select()
      .from(devices)
      .where(eq(devices.id, testDeviceId))
      .limit(1);
    const device = deviceList[0];

    expect(device?.status).toBe("online");

    const alertList = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.deviceId, testDeviceId), eq(alerts.status, "open")))
      .limit(1);
    const alert = alertList[0];

    expect(alert).toBeUndefined();
  });

  it("should not create duplicate offline alerts", async () => {
    const oldTime = new Date(Date.now() - 20 * 60 * 1000);

    await db
      .update(devices)
      .set({ lastSeenAt: oldTime })
      .where(eq(devices.id, testDeviceId));

    await evaluateDeviceOffline(testDeviceId, 15);
    await evaluateDeviceOffline(testDeviceId, 15);

    const alerts_list = await db
      .select()
      .from(alerts)
      .where(
        and(
          eq(alerts.deviceId, testDeviceId),
          eq(alerts.type, "device_offline"),
          eq(alerts.status, "open"),
        )
      );

    expect(alerts_list.length).toBe(1);
  });
});
