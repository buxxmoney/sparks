import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Object storage for sealed report PDFs and uploaded invoices (docs/02 §4.2).
 *
 * Two backends, auto-selected:
 * - **r2** — used when the Cloudflare R2 env vars are all present (S3-compatible).
 *   Bytes live in a durable bucket; downloads are real S3 presigned URLs.
 * - **fs** — the default fallback: writes bytes under `<tmpdir>/sparks-report-storage`
 *   and serves them via the app's signed `GET /reports/file` route. Dev/test-grade
 *   (single host, non-durable) but fully functional — no silent stub.
 *
 * Tests always use **fs** (hermetic; never touch a real bucket).
 *
 * Env:
 * - `R2_ACCOUNT_ID` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` `R2_BUCKET_NAME` — enable R2
 * - `STORAGE_BACKEND=fs` — force the filesystem backend even if R2 vars are set
 * - `REPORT_STORAGE_DIR` — fs backend root (default: <tmpdir>/sparks-report-storage)
 * - `REPORT_URL_SECRET` / `BETTER_AUTH_SECRET` — HMAC key for fs signed URLs
 * - `PUBLIC_API_URL` / `BETTER_AUTH_URL` — base URL the fs signed URL points at
 */

function r2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET_NAME,
  );
}

function storageBackend(): "r2" | "fs" {
  // Tests must never reach a real bucket.
  if (process.env.NODE_ENV === "test") return "fs";
  if (process.env.STORAGE_BACKEND === "fs") return "fs";
  return r2Configured() ? "r2" : "fs";
}

// ── R2 (S3-compatible) ──────────────────────────────────────────────────────

let cachedClient: S3Client | null = null;
function r2Client(): S3Client {
  if (cachedClient) return cachedClient;
  cachedClient = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY as string,
    },
  });
  return cachedClient;
}

function r2Bucket(): string {
  return process.env.R2_BUCKET_NAME as string;
}

// ── Filesystem backend ──────────────────────────────────────────────────────

function storageRoot(): string {
  return resolve(process.env.REPORT_STORAGE_DIR ?? join(tmpdir(), "sparks-report-storage"));
}

/** Absolute path for a storage key, guarded against path traversal. */
function pathForKey(key: string): string {
  const root = storageRoot();
  const full = resolve(root, key);
  if (full !== root && !full.startsWith(`${root}/`)) {
    throw new Error(`Illegal storage key: ${key}`);
  }
  return full;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Persist an object's bytes under `key`. */
export async function putObject(
  key: string,
  body: Buffer,
  contentType = "application/octet-stream",
): Promise<void> {
  if (storageBackend() === "r2") {
    await r2Client().send(
      new PutObjectCommand({ Bucket: r2Bucket(), Key: key, Body: body, ContentType: contentType }),
    );
    return;
  }
  const full = pathForKey(key);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, body);
}

/** Read an object's bytes back (throws if missing). */
export async function getObject(key: string): Promise<Buffer> {
  if (storageBackend() === "r2") {
    const res = await r2Client().send(new GetObjectCommand({ Bucket: r2Bucket(), Key: key }));
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error(`Empty object for key ${key}`);
    return Buffer.from(bytes);
  }
  return readFile(pathForKey(key));
}

/** Whether an object exists. */
export async function objectExists(key: string): Promise<boolean> {
  if (storageBackend() === "r2") {
    try {
      await r2Client().send(new HeadObjectCommand({ Bucket: r2Bucket(), Key: key }));
      return true;
    } catch {
      return false;
    }
  }
  return existsSync(pathForKey(key));
}

// ── Signed download URLs ─────────────────────────────────────────────────────

function signingSecret(): string {
  return (
    process.env.REPORT_URL_SECRET ??
    process.env.BETTER_AUTH_SECRET ??
    "dev-report-signing-secret-change-me"
  );
}

function tokenFor(key: string, expires: number): string {
  return createHmac("sha256", signingSecret()).update(`${key}:${expires}`).digest("hex");
}

/**
 * Mint a short-lived signed URL for an object. On R2 this is a native S3 presigned
 * GET (browser fetches R2 directly). On the fs backend the signed token is a
 * capability verified by the app's `GET /reports/file` route (same model).
 */
export async function signObjectUrl(key: string, expiresInSeconds = 3600): Promise<string> {
  if (storageBackend() === "r2") {
    return getSignedUrl(r2Client(), new GetObjectCommand({ Bucket: r2Bucket(), Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }
  const base = (
    process.env.PUBLIC_API_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3001"
  ).replace(/\/$/, "");
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const token = tokenFor(key, expires);
  const params = new URLSearchParams({ key, expires: String(expires), token });
  return `${base}/reports/file?${params.toString()}`;
}

/** Verify an fs-backend signed-URL token: constant-time HMAC match and not expired. */
export function verifyObjectToken(key: string, expires: number, token: string): boolean {
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;
  const expected = tokenFor(key, expires);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
