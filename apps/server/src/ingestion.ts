import { Hono } from "hono";
import {
  db,
  devices,
  meters,
  rawMeterReadings,
  readings,
  deviceHealthSamples,
  sites,
} from "@sparks/db";
import { eq } from "drizzle-orm";
import { createHash, createHmac, createVerify, timingSafeEqual, randomBytes } from "node:crypto";
import { z } from "zod";
import { deriveReadings } from "./derivation";
import { aggregateDemandIntervals, detectDataGaps } from "./workers";

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

const commissionInput = z.object({
  deviceId: z.string().uuid(),
  provisioningToken: z.string().min(1),
});

/* ────────────────────────── Device HMAC auth (docs/02 §4.2, R7) ──────────────────────────
 * The edge agent signs the *raw request body* with its device key and sends the hex
 * signature in `x-signature`. Per spec the server stores ONLY a hash of the device key
 * (`devices.api_key_hash`), never the key itself — so the HMAC key on both ends is the
 * SHA-256 of the device key:
 *
 *   deviceKey (K)  ──issued once at commission, held only by the device──▶  never stored
 *   apiKeyHash     = sha256(K)                                          ──▶  stored server-side
 *   signature      = HMAC-SHA256(key = sha256(K), message = rawBody)     (device derives sha256(K))
 *
 * The server recomputes HMAC-SHA256 keyed by the stored `apiKeyHash` and constant-time
 * compares. This keeps the store-only-a-hash property while giving per-request body
 * integrity (a bearer token would not detect a tampered body). Keys are rotatable.
 * ------------------------------------------------------------------------------------------ */

/** SHA-256 of a device key, hex. This is what's persisted in `devices.api_key_hash`. */
function hashDeviceKey(deviceKey: string): string {
  return createHash("sha256").update(deviceKey).digest("hex");
}

/**
 * Sign a raw request body the way the edge agent must. Exported so tests and the edge
 * reference implementation share one canonical definition of the wire contract.
 */
export function signDeviceBody(deviceKey: string, rawBody: string): string {
  return createHmac("sha256", hashDeviceKey(deviceKey)).update(rawBody).digest("hex");
}

/** Constant-time verify of a hex signature against the stored key hash. */
function verifyDeviceSignature(storedKeyHash: string, rawBody: string, providedHex: string): boolean {
  const expected = createHmac("sha256", storedKeyHash).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "hex");
  let b: Buffer;
  try {
    b = Buffer.from(providedHex, "hex");
  } catch {
    return false;
  }
  // timingSafeEqual throws on length mismatch — guard first (length is not secret).
  if (a.length === 0 || a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Authenticate a signed device request. Returns the raw body (needed by the caller to
 * parse) plus the resolved device, or an HTTP error tuple. The signature is verified over
 * the exact bytes the device signed, so the caller must NOT re-read the body.
 */
async function authenticateSignedRequest(
  c: import("hono").Context,
): Promise<
  | { ok: true; rawBody: string; deviceId: string }
  | { ok: false; status: 400 | 401; error: string }
> {
  const deviceId = c.req.header("x-device-id");
  const signature = c.req.header("x-signature");

  if (!deviceId || !signature) {
    return { ok: false, status: 400, error: "Missing x-device-id or x-signature header" };
  }

  const deviceList = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  const device = deviceList[0];
  if (!device) {
    return { ok: false, status: 401, error: "Invalid device credentials" };
  }

  const rawBody = await c.req.text();
  if (!verifyDeviceSignature(device.apiKeyHash, rawBody, signature)) {
    return { ok: false, status: 401, error: "Invalid signature" };
  }

  return { ok: true, rawBody, deviceId };
}

/* ────────────────────────── Device JWT auth (RS256, asymmetric) ──────────────────────────
 * The NEW raw-ingestion path (`POST /ingest/raw`) authenticates with a JWT the device
 * carries as `Authorization: Bearer <jwt>`. The tokens are minted OFFLINE with an RSA
 * private key that never touches the server; the server holds ONLY the PUBLIC key
 * (`DEVICE_INGEST_JWT_PUBLIC_KEY`, PEM/SPKI) and verifies the signature per request. The
 * token's `meterId` (or `sub`) claim says which meter the payload came from.
 * ------------------------------------------------------------------------------------------ */

interface DeviceJwtClaims {
  meterId?: string;
  sub?: string;
  deviceId?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  [k: string]: unknown;
}

function decodeJwtSegment(seg: string): unknown {
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
}

/**
 * Verify a compact RS256 JWT against a PEM public key. Returns the claims, or null on any
 * failure. The algorithm is PINNED to RS256 and always verified with an RSA public key, so
 * a token can't downgrade to HS256/"none" (algorithm-confusion). `exp`/`nbf` are honored
 * when present. Exported for tests. PURE apart from the clock.
 */
export function verifyDeviceJwt(token: string, publicKeyPem: string): DeviceJwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string };
  try {
    header = decodeJwtSegment(headerB64) as { alg?: string };
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureB64, "base64url");
  } catch {
    return null;
  }

  let signatureOk = false;
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();
    signatureOk = verifier.verify(publicKeyPem, signature);
  } catch {
    return null; // malformed key or signature bytes
  }
  if (!signatureOk) return null;

  let claims: DeviceJwtClaims;
  try {
    claims = decodeJwtSegment(payloadB64) as DeviceJwtClaims;
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && now >= claims.exp) return null;
  if (typeof claims.nbf === "number" && now < claims.nbf) return null;
  return claims;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createIngestionRouter() {
  const router = new Hono();

  // NEW: raw telemetry landing. The device streams its meter payload (the exact JSON it
  // produces) — a single object OR an array (a flush of its offline buffer). We store each
  // verbatim as (meter_id, recorded_at, payload); NOTHING is parsed into structured tables
  // here. Auth is the device JWT (RS256, verified with the public key).
  router.post("/raw", async (c) => {
    const publicKey = process.env.DEVICE_INGEST_JWT_PUBLIC_KEY;
    if (!publicKey) {
      console.error("[ingest/raw] DEVICE_INGEST_JWT_PUBLIC_KEY is not set — cannot verify devices");
      return c.json({ error: "Ingestion is not configured" }, 503);
    }

    const authz = c.req.header("authorization") ?? "";
    const token = /^bearer\s+/i.test(authz) ? authz.replace(/^bearer\s+/i, "").trim() : "";
    if (!token) {
      return c.json({ error: "Missing bearer token" }, 401);
    }

    const claims = verifyDeviceJwt(token, publicKey);
    if (!claims) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    const meterId = (claims.meterId ?? claims.sub ?? "").toString();
    if (!UUID_RE.test(meterId)) {
      return c.json({ error: "Token is missing a valid meterId claim" }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const items = Array.isArray(body) ? body : [body];
    if (items.length === 0) {
      return c.json({ accepted: 0 });
    }

    // The meter must exist (the raw row FKs it). One lookup for the whole batch.
    const meterList = await db.select({ id: meters.id }).from(meters).where(eq(meters.id, meterId)).limit(1);
    if (!meterList[0]) {
      return c.json({ error: "Unknown meter" }, 404);
    }

    const rows: { meterId: string; recordedAt: Date; payload: unknown }[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return c.json({ error: "Each reading must be a JSON object" }, 400);
      }
      const ts = (item as { timestamp?: unknown }).timestamp;
      const recordedAt =
        typeof ts === "string" || typeof ts === "number" || ts instanceof Date ? new Date(ts) : null;
      if (!recordedAt || Number.isNaN(recordedAt.getTime())) {
        return c.json({ error: "Each reading needs a valid `timestamp`" }, 400);
      }
      rows.push({ meterId, recordedAt, payload: item });
    }

    try {
      // Idempotent on (meter_id, recorded_at): a replayed offline buffer can't double-insert.
      await db
        .insert(rawMeterReadings)
        .values(rows)
        .onConflictDoNothing({
          target: [rawMeterReadings.meterId, rawMeterReadings.recordedAt],
        });
    } catch (err) {
      console.error("[ingest/raw] failed to store raw readings:", err);
      return c.json({ error: "Failed to store readings" }, 500);
    }

    // Derive structured readings + demand intervals so the graphs/reconciliation update live.
    // Best-effort: the raw rows are already durably stored (the source of truth), so a
    // derivation failure must NOT fail the ingest — it can be re-derived from raw later.
    try {
      await deriveReadings(meterId, rows);
    } catch (err) {
      console.error(`[ingest/raw] derivation failed for meter ${meterId} (raw is stored):`, err);
    }

    return c.json({ accepted: rows.length });
  });

  router.post("/readings", async (c) => {
    const authResult = await authenticateSignedRequest(c);
    if (!authResult.ok) {
      return c.json({ error: authResult.error }, authResult.status);
    }
    const { rawBody, deviceId } = authResult;

    type IngestInput = typeof ingestReadingsBatchInput._output;
    let parsed: IngestInput;
    try {
      parsed = ingestReadingsBatchInput.parse(JSON.parse(rawBody));
    } catch (err) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    let highestSeq = 0;
    const affectedMeters = new Set<string>();

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
        // Idempotent upsert on (meter_id, time) — a replayed batch overwrites in place.
        await db
          .insert(readings)
          .values(values)
          .onConflictDoUpdate({
            target: [readings.meterId, readings.time],
            set: values,
          });

        affectedMeters.add(reading.meterId);
        if (reading.seq && reading.seq > highestSeq) {
          highestSeq = reading.seq;
        }
      } catch (err) {
        return c.json({ error: "Failed to insert reading" }, 500);
      }
    }

    // Trigger aggregation + gap detection for each affected meter so demand_intervals
    // and data_gaps populate immediately after ingest (docs/02 §4.2 on-ingest debounce;
    // R1/R2). Awaited inline: at MVP cadence this is cheap and keeps the pipeline
    // deterministic. Failures here must NOT lose already-committed readings, so they are
    // logged rather than surfaced to the device (the cron re-runs aggregation regardless).
    for (const meterId of affectedMeters) {
      try {
        await aggregateDemandIntervals(meterId);
        await detectDataGaps(meterId);
      } catch (err) {
        console.error(`Post-ingest aggregation failed for meter ${meterId}:`, err);
      }
    }

    return c.json({
      accepted: parsed.readings.length,
      highestSeq,
    });
  });

  router.post("/health", async (c) => {
    const authResult = await authenticateSignedRequest(c);
    if (!authResult.ok) {
      return c.json({ error: authResult.error }, authResult.status);
    }
    const { rawBody, deviceId } = authResult;

    type HealthInput = typeof ingestHealthInput._output;
    let parsed: HealthInput;
    try {
      parsed = ingestHealthInput.parse(JSON.parse(rawBody));
    } catch (err) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    // The signed device may only report its own health.
    if (parsed.deviceId !== deviceId) {
      return c.json({ error: "deviceId does not match signing device" }, 403);
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

  // First contact from a freshly installed Pi (docs/02 §4.2). The device presents its
  // deviceId + the one-time provisioning token issued at `devices.provision`. On success
  // the server rotates in a fresh device key, stores ONLY its hash, and flips the device
  // to `online`. The token is one-time by construction: commission is refused once the
  // device leaves `provisioning`, and the key it verified against has been replaced.
  router.post("/commission", async (c) => {
    let parsed: z.infer<typeof commissionInput>;
    try {
      parsed = commissionInput.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const deviceList = await db
      .select()
      .from(devices)
      .where(eq(devices.id, parsed.deviceId))
      .limit(1);

    const device = deviceList[0];
    if (!device) {
      return c.json({ error: "Device not found" }, 404);
    }

    if (device.status !== "provisioning") {
      return c.json({ error: "Device already commissioned" }, 409);
    }

    // Constant-time check of the provisioning token against the stored hash.
    const tokenHash = hashDeviceKey(parsed.provisioningToken);
    const expected = Buffer.from(device.apiKeyHash, "utf8");
    const provided = Buffer.from(tokenHash, "utf8");
    const tokenValid =
      expected.length === provided.length && timingSafeEqual(expected, provided);
    if (!tokenValid) {
      return c.json({ error: "Invalid provisioning token" }, 401);
    }

    // Issue the real device key; persist only its hash. Returned once, never again.
    const deviceKey = randomBytes(32).toString("hex");
    const now = new Date();
    await db
      .update(devices)
      .set({
        apiKeyHash: hashDeviceKey(deviceKey),
        status: "online",
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(devices.id, parsed.deviceId));

    return c.json({ deviceId: parsed.deviceId, deviceKey });
  });

  return router;
}
