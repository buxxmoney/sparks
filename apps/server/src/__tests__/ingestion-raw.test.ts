import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { db, demandIntervals, devices, meters, rawMeterReadings, readings, sites } from "@sparks/db";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { app } from "../index";
import { verifyDeviceJwt } from "../ingestion";

// An RSA keypair for the test run: the PUBLIC key goes on the "server" (env), the PRIVATE
// key mints tokens the way the offline minter (scripts/mint-device-jwt.ts) does.
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const b64url = (s: string) => Buffer.from(s).toString("base64url");

function mintJwt(claims: Record<string, unknown>, key: string = privateKey): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const sig = signer.sign(key).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

async function postRaw(token: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return app.request("/ingest/raw", { method: "POST", headers, body: JSON.stringify(body) });
}

// The device's real payload shape (from the firmware team's mock).
const samplePayload = (timestamp: string) => ({
  readings: {
    energy_import_kwh: 125678.5,
    energy_export_kwh: 2345.2,
    energy_kvah: 128567.9,
    energy_total_kvarh: 31833.1,
    power_total: 10412.7,
    va_total: 10794.1,
    var_total: 2487.5,
  },
  timestamp,
  units: { energy_import_kwh: "kWh", power_total: "W" },
});

let siteId: string;
let deviceId: string;
let meterId: string;

beforeAll(() => {
  process.env.DEVICE_INGEST_JWT_PUBLIC_KEY = publicKey;
});
afterAll(() => {
  process.env.DEVICE_INGEST_JWT_PUBLIC_KEY = undefined;
});

beforeEach(async () => {
  siteId = randomUUID();
  deviceId = randomUUID();
  meterId = randomUUID();
  await db.insert(sites).values({
    id: siteId,
    organizationId: "raw-org",
    name: "Raw Site",
    timezone: "UTC",
    demandIntervalMinutes: 30,
  });
  await db.insert(devices).values({
    id: deviceId,
    siteId,
    serialNumber: `DEV-${randomUUID()}`,
    hardwareModel: "rpi",
    apiKeyHash: "unused-for-jwt",
    status: "online",
  });
  await db.insert(meters).values({
    id: meterId,
    deviceId,
    siteId,
    serialNumber: `MTR-${randomUUID()}`,
    model: "SDM630MCT",
  });
});

afterEach(async () => {
  await db.delete(rawMeterReadings).where(eq(rawMeterReadings.meterId, meterId));
  await db.delete(meters).where(eq(meters.id, meterId));
  await db.delete(devices).where(eq(devices.id, deviceId));
  await db.delete(sites).where(eq(sites.id, siteId));
});

describe("POST /ingest/raw (JWT + raw landing)", () => {
  it("verifyDeviceJwt round-trips a valid token and rejects tampering", () => {
    const token = mintJwt({ sub: meterId, meterId });
    expect(verifyDeviceJwt(token, publicKey)?.meterId).toBe(meterId);
    // Flip a char in the MIDDLE of the signature → different bytes → invalid. (The very
    // last base64url char has don't-care padding bits for a 256-byte RSA sig, so avoid it.)
    const [h, p, s] = token.split(".");
    const mid = Math.floor(s.length / 2);
    const tampered = `${h}.${p}.${s.slice(0, mid)}${s[mid] === "A" ? "B" : "A"}${s.slice(mid + 1)}`;
    expect(verifyDeviceJwt(tampered, publicKey)).toBeNull();
    // Wrong key (a different keypair) → invalid.
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    expect(verifyDeviceJwt(mintJwt({ meterId }, other.privateKey), publicKey)).toBeNull();
  });

  it("stores a single payload verbatim keyed by meter + device timestamp", async () => {
    const ts = "2026-07-07T15:07:56.123+00:00";
    const res = await postRaw(mintJwt({ meterId }), samplePayload(ts));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1 });

    const rows = await db.select().from(rawMeterReadings).where(eq(rawMeterReadings.meterId, meterId));
    expect(rows).toHaveLength(1);
    expect(rows[0].recordedAt.getTime()).toBe(new Date(ts).getTime());
    // Payload stored raw, unchanged.
    const payload = rows[0].payload as ReturnType<typeof samplePayload>;
    expect(payload.readings.energy_import_kwh).toBe(125678.5);
    expect(payload.units.power_total).toBe("W");
  });

  it("accepts an array (offline-buffer flush) and stores each row", async () => {
    const batch = [
      samplePayload("2026-07-07T15:00:00+00:00"),
      samplePayload("2026-07-07T15:01:00+00:00"),
      samplePayload("2026-07-07T15:02:00+00:00"),
    ];
    const res = await postRaw(mintJwt({ meterId }), batch);
    expect(await res.json()).toEqual({ accepted: 3 });
    const rows = await db.select().from(rawMeterReadings).where(eq(rawMeterReadings.meterId, meterId));
    expect(rows).toHaveLength(3);
  });

  it("is idempotent on replay of the same (meter, timestamp)", async () => {
    const p = samplePayload("2026-07-07T15:05:00+00:00");
    await postRaw(mintJwt({ meterId }), p);
    await postRaw(mintJwt({ meterId }), p); // re-sent after a network blip
    const rows = await db.select().from(rawMeterReadings).where(eq(rawMeterReadings.meterId, meterId));
    expect(rows).toHaveLength(1);
  });

  it("rejects a missing/invalid token", async () => {
    expect((await postRaw(null, samplePayload("2026-07-07T15:00:00+00:00"))).status).toBe(401);
    expect((await postRaw("not-a-jwt", samplePayload("2026-07-07T15:00:00+00:00"))).status).toBe(401);
  });

  it("404s a token whose meter does not exist", async () => {
    const res = await postRaw(mintJwt({ meterId: randomUUID() }), samplePayload("2026-07-07T15:00:00+00:00"));
    expect(res.status).toBe(404);
  });

  it("400s a reading with no timestamp", async () => {
    const res = await postRaw(mintJwt({ meterId }), { readings: { energy_import_kwh: 1 } });
    expect(res.status).toBe(400);
  });

  it("derives structured readings + demand intervals from the raw stream", async () => {
    // Two readings a minute apart in the same demand window: cumulative registers rise.
    const batch = [
      {
        readings: { energy_import_kwh: 1000, energy_kvah: 1000, power_total: 5000, va_total: 5200 },
        timestamp: "2026-07-07T15:00:00+00:00",
      },
      {
        readings: { energy_import_kwh: 1010, energy_kvah: 1012, power_total: 5000, va_total: 5200 },
        timestamp: "2026-07-07T15:01:00+00:00",
      },
    ];
    const res = await postRaw(mintJwt({ meterId }), batch);
    expect(await res.json()).toEqual({ accepted: 2 });

    // Structured readings were derived (power W → kW).
    const rd = await db.select().from(readings).where(eq(readings.meterId, meterId));
    expect(rd).toHaveLength(2);
    expect(Number(rd[0].totalPowerKw)).toBeCloseTo(5, 3);

    // And the demand interval carries the energy DELTA (1010 − 1000 = 10 kWh).
    const di = await db.select().from(demandIntervals).where(eq(demandIntervals.meterId, meterId));
    expect(di.length).toBeGreaterThanOrEqual(1);
    const total = di.reduce((s, r) => s + Number(r.activeEnergyKwh ?? 0), 0);
    expect(total).toBeCloseTo(10, 3);
  });
});
