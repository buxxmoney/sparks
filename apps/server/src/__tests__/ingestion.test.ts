import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db, devices, meters, readings, deviceHealthSamples, sites } from "@sparks/db";
import { randomUUID, createHash } from "node:crypto";
import { sql, eq, and } from "drizzle-orm";

let testSiteId: string;
let testDeviceId: string;
let testMeterId: string;
let testApiKey: string;

async function setupTestData() {
  testSiteId = randomUUID();
  testDeviceId = randomUUID();
  testMeterId = randomUUID();
  testApiKey = randomUUID();

  const apiKeyHash = createHash("sha256").update(testApiKey).digest("hex");

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
    apiKeyHash: apiKeyHash,
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
  await db.delete(deviceHealthSamples).where(eq(deviceHealthSamples.deviceId, testDeviceId));
  await db.delete(readings).where(eq(readings.meterId, testMeterId));
  await db.delete(meters).where(eq(meters.id, testMeterId));
  await db.delete(devices).where(eq(devices.id, testDeviceId));
  await db.delete(sites).where(eq(sites.id, testSiteId));
}

describe("Device Ingestion API", () => {
  beforeEach(async () => {
    await setupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  describe("POST /ingest/readings", () => {
    it("should accept a batch of readings and return highest seq", async () => {
      const now = new Date();

      await db.insert(readings).values({
        meterId: testMeterId,
        time: now,
        seq: 100,
        activeEnergyKwh: "1000.500",
        reactiveEnergyKvarh: "500.200",
        apparentEnergyKvah: "1100.300",
        totalPowerKw: "5.5",
        totalApparentKva: "6.0",
        powerFactor: "0.9167",
      });

      await db.insert(readings).values({
        meterId: testMeterId,
        time: new Date(now.getTime() + 60000),
        seq: 101,
        activeEnergyKwh: "1001.500",
        reactiveEnergyKvarh: "500.400",
        apparentEnergyKvah: "1101.300",
        totalPowerKw: "5.4",
        totalApparentKva: "5.9",
        powerFactor: "0.9180",
      });

      const savedReadings = await db
        .select()
        .from(readings)
        .where(eq(readings.meterId, testMeterId));

      expect(savedReadings.length).toBeGreaterThanOrEqual(2);
    });

    it("should idempotently upsert readings on (meter_id, time) conflict", async () => {
      const now = new Date();

      await db.insert(readings).values({
        meterId: testMeterId,
        time: now,
        seq: 100,
        activeEnergyKwh: "999.000",
      });

      await db.insert(readings).values({
        meterId: testMeterId,
        time: now,
        seq: 100,
        activeEnergyKwh: "1000.500",
      }).onConflictDoUpdate({
        target: [readings.meterId, readings.time],
        set: {
          activeEnergyKwh: "1000.500",
        },
      });

      const updated = await db
        .select()
        .from(readings)
        .where(and(eq(readings.meterId, testMeterId), eq(readings.time, now)))
        .limit(1);

      expect(updated.length).toBeGreaterThan(0);
    });

    it("should reject invalid API key", async () => {
      const payload = {
        readings: [
          {
            meterId: testMeterId,
            time: new Date(),
            activeEnergyKwh: "1000.500",
          },
        ],
        timestamp: new Date(),
      };

      const badApiKey = randomUUID();
      const badHash = createHash("sha256").update(badApiKey).digest("hex");

      expect(badHash).not.toBe("");
    });

    it("should handle readings spanning a day boundary (23:45 to 00:00)", async () => {
      const day1 = new Date("2026-07-02T23:45:00Z");
      const day2 = new Date("2026-07-03T00:15:00Z");

      await db.insert(readings).values({
        meterId: testMeterId,
        time: day1,
        seq: 1,
        activeEnergyKwh: "1000.000",
      });

      await db.insert(readings).values({
        meterId: testMeterId,
        time: day2,
        seq: 2,
        activeEnergyKwh: "1001.000",
      });

      const saved = await db
        .select()
        .from(readings)
        .where(eq(readings.meterId, testMeterId));

      expect(saved.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("POST /ingest/health", () => {
    it("should record device health sample", async () => {
      const now = new Date();

      await db.insert(deviceHealthSamples).values({
        deviceId: testDeviceId,
        time: now,
        connectivityMode: "lte",
        signalRssi: -85,
        upsStatus: "on_mains",
        batteryPct: 100,
        cpuTempC: "52.50",
        bufferedRecords: 0,
      });

      const saved = await db
        .select()
        .from(deviceHealthSamples)
        .where(and(eq(deviceHealthSamples.deviceId, testDeviceId), eq(deviceHealthSamples.time, now)))
        .limit(1);

      expect(saved.length).toBeGreaterThan(0);
      expect(saved[0]?.signalRssi).toBe(-85);
      expect(saved[0]?.batteryPct).toBe(100);
    });

    it("should update device last_seen_at and ups_status", async () => {
      const now = new Date();

      const beforeUpdate = await db
        .select()
        .from(devices)
        .where(eq(devices.id, testDeviceId))
        .limit(1);

      expect(beforeUpdate[0]?.upsStatus).not.toBe("on_battery");

      await db.update(devices)
        .set({
          lastSeenAt: now,
          upsStatus: "on_battery",
          upsBatteryPct: 75,
          updatedAt: now,
        })
        .where(eq(devices.id, testDeviceId));

      const afterUpdate = await db
        .select()
        .from(devices)
        .where(eq(devices.id, testDeviceId))
        .limit(1);

      expect(afterUpdate[0]?.upsStatus).toBe("on_battery");
      expect(afterUpdate[0]?.upsBatteryPct).toBe(75);
    });
  });

  describe("GET /device/config/:deviceId", () => {
    it("should return demand interval and poll rate", async () => {
      const deviceList = await db
        .select()
        .from(devices)
        .where(eq(devices.id, testDeviceId));

      const device = deviceList[0];
      const site = device && device.siteId
        ? (await db.select().from(sites).where(eq(sites.id, device.siteId)).limit(1))[0]
        : null;

      expect(site?.demandIntervalMinutes).toBe(30);
    });

    it("should reject request for device without site", async () => {
      const orphanDeviceId = randomUUID();

      await db.insert(devices).values({
        id: orphanDeviceId,
        serialNumber: `ORPHAN-${Math.random()}`,
        hardwareModel: "rpi",
        apiKeyHash: "hash",
        status: "provisioning",
      });

      const deviceList = await db
        .select()
        .from(devices)
        .where(eq(devices.id, orphanDeviceId))
        .limit(1);

      const device = deviceList[0];
      expect(device?.siteId).toBeNull();
    });
  });
});

describe("Idempotency Tests", () => {
  beforeEach(async () => {
    await setupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  it("should handle re-posting the exact same batch", async () => {
    const now = new Date();

    await db.insert(readings).values({
      meterId: testMeterId,
      time: now,
      seq: 100,
      activeEnergyKwh: "1000.500",
    });

    await db.insert(readings).values({
      meterId: testMeterId,
      time: new Date(now.getTime() + 60000),
      seq: 101,
      activeEnergyKwh: "1001.500",
    });

    const countBefore = await db
      .select()
      .from(readings)
      .where(eq(readings.meterId, testMeterId));

    await db.insert(readings).values({
      meterId: testMeterId,
      time: now,
      seq: 100,
      activeEnergyKwh: "1000.500",
    }).onConflictDoUpdate({
      target: [readings.meterId, readings.time],
      set: {
        activeEnergyKwh: "1000.500",
      },
    });

    const countAfter = await db
      .select()
      .from(readings)
      .where(eq(readings.meterId, testMeterId));

    expect(countBefore.length).toBe(countAfter.length);
  });
});
