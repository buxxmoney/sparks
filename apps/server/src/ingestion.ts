import { Hono } from "hono";
import { db, devices, meters, readings, deviceHealthSamples, sites } from "@sparks/db";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";

const ingestReadingsBatchInput = z.object({
  readings: z.array(
    z.object({
      meterId: z.string().uuid(),
      time: z.coerce.date(),
      seq: z.number().int().optional(),
      activeEnergyKwh: z.string().optional(),
      reactiveEnergyKvarh: z.string().optional(),
      apparentEnergyKvah: z.string().optional(),
      totalPowerKw: z.string().optional(),
      totalApparentKva: z.string().optional(),
      powerFactor: z.string().optional(),
    })
  ),
  timestamp: z.coerce.date(),
});

const ingestHealthInput = z.object({
  deviceId: z.string().uuid(),
  time: z.coerce.date(),
  connectivityMode: z.enum(["lte", "wifi"]).optional(),
  signalRssi: z.number().optional(),
  upsStatus: z.enum(["on_mains", "charging", "on_battery", "degraded", "unknown"]).optional(),
  batteryPct: z.number().int().min(0).max(100).optional(),
  cpuTempC: z.number().optional(),
  bufferedRecords: z.number().int().optional(),
});

const deviceConfigInput = z.object({
  deviceId: z.string().uuid(),
  provisioningToken: z.string(),
});

async function validateDeviceAuth(deviceId: string, apiKey: string): Promise<boolean> {
  const deviceList = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  const device = deviceList[0];
  if (!device) {
    return false;
  }

  const providedHash = createHash("sha256").update(apiKey).digest("hex");
  return providedHash === device.apiKeyHash;
}

export function createIngestionRouter() {
  const router = new Hono();

  router.post("/readings", async (c) => {
    const deviceId = c.req.header("x-device-id");
    const apiKey = c.req.header("x-device-key");

    if (!deviceId || !apiKey) {
      return c.json({ error: "Missing x-device-id or x-device-key header" }, 400);
    }

    const isValid = await validateDeviceAuth(deviceId, apiKey);
    if (!isValid) {
      return c.json({ error: "Invalid device credentials" }, 401);
    }

    type IngestInput = typeof ingestReadingsBatchInput._output;
    let parsed: IngestInput;
    try {
      const body = await c.req.json();
      parsed = ingestReadingsBatchInput.parse(body);
    } catch (err) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    let highestSeq = 0;

    for (const reading of parsed.readings) {
      const meterList = await db
        .select()
        .from(meters)
        .where(eq(meters.id, reading.meterId))
        .limit(1);

      const meter = meterList[0];
      if (!meter || meter.deviceId !== deviceId) {
        return c.json({ error: `Meter ${reading.meterId} not found or not on device` }, 404);
      }

      const values = {
        meterId: reading.meterId,
        time: reading.time,
        seq: reading.seq || null,
        activeEnergyKwh: reading.activeEnergyKwh || null,
        reactiveEnergyKvarh: reading.reactiveEnergyKvarh || null,
        apparentEnergyKvah: reading.apparentEnergyKvah || null,
        totalPowerKw: reading.totalPowerKw || null,
        totalApparentKva: reading.totalApparentKva || null,
        powerFactor: reading.powerFactor || null,
        source: "live" as const,
      };

      try {
        await db
          .insert(readings)
          .values(values)
          .onConflictDoUpdate({
            target: [readings.meterId, readings.time],
            set: values,
          });

        if (reading.seq && reading.seq > highestSeq) {
          highestSeq = reading.seq;
        }
      } catch (err) {
        return c.json({ error: "Failed to insert reading" }, 500);
      }
    }

    return c.json({
      accepted: parsed.readings.length,
      highestSeq,
    });
  });

  router.post("/health", async (c) => {
    const deviceId = c.req.header("x-device-id");
    const apiKey = c.req.header("x-device-key");

    if (!deviceId || !apiKey) {
      return c.json({ error: "Missing x-device-id or x-device-key header" }, 400);
    }

    const isValid = await validateDeviceAuth(deviceId, apiKey);
    if (!isValid) {
      return c.json({ error: "Invalid device credentials" }, 401);
    }

    type HealthInput = typeof ingestHealthInput._output;
    let parsed: HealthInput;
    try {
      const body = await c.req.json();
      parsed = ingestHealthInput.parse(body);
    } catch (err) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    try {
      await db.insert(deviceHealthSamples).values({
        deviceId: parsed.deviceId,
        time: parsed.time,
        connectivityMode: parsed.connectivityMode || null,
        signalRssi: parsed.signalRssi || null,
        upsStatus: parsed.upsStatus || null,
        batteryPct: parsed.batteryPct || null,
        cpuTempC: parsed.cpuTempC ? parsed.cpuTempC.toFixed(2) : null,
        bufferedRecords: parsed.bufferedRecords || null,
      });

      const now = new Date();
      await db
        .update(devices)
        .set({
          lastSeenAt: now,
          upsStatus: parsed.upsStatus || "unknown",
          upsBatteryPct: parsed.batteryPct || null,
          updatedAt: now,
        })
        .where(eq(devices.id, parsed.deviceId));
    } catch (err) {
      return c.json({ error: "Failed to record health sample" }, 500);
    }

    return c.json({ success: true });
  });

  return router;
}

export function createDeviceRouter() {
  const router = new Hono();

  router.get("/config/:deviceId", async (c) => {
    const { deviceId } = c.req.param();

    const deviceList = await db
      .select()
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);

    const device = deviceList[0];
    if (!device) {
      return c.json({ error: "Device not found" }, 404);
    }

    if (!device.siteId) {
      return c.json({ error: "Device has no assigned site" }, 400);
    }

    const siteList = await db
      .select()
      .from(sites)
      .where(eq(sites.id, device.siteId))
      .limit(1);

    const site = siteList[0];
    if (!site) {
      return c.json({ error: "Device site not found" }, 404);
    }

    return c.json({
      demandIntervalMinutes: site.demandIntervalMinutes,
      pollIntervalSeconds: 60,
    });
  });

  router.post("/commission", async (c) => {
    try {
      const body = await c.req.json();
      deviceConfigInput.parse(body);
    } catch (err) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    return c.json({ error: "Not yet implemented" }, 501);
  });

  return router;
}
