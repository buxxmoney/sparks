/**
 * OFFLINE device-JWT minter. Run this on a trusted machine that holds the RSA PRIVATE
 * key — it never lives on the server. The token it prints is hard-coded onto the Pi as
 * `Authorization: Bearer <jwt>` for POST /ingest/raw. The server verifies it with the
 * matching PUBLIC key (DEVICE_INGEST_JWT_PUBLIC_KEY).
 *
 * One-time key generation (keep the private key OFFLINE, give the public key to the server):
 *   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out device-signing.private.pem
 *   openssl rsa -in device-signing.private.pem -pubout -out device-signing.public.pem
 *   # → DEVICE_INGEST_JWT_PUBLIC_KEY = contents of device-signing.public.pem (Railway env)
 *
 * Usage:
 *   bun scripts/mint-device-jwt.ts <meterId> --key device-signing.private.pem [--device <deviceId>] [--days N]
 *   # or provide the key via env: DEVICE_INGEST_JWT_PRIVATE_KEY="$(cat device-signing.private.pem)"
 */
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const meterId = process.argv[2];
if (!meterId || meterId.startsWith("--")) {
  console.error("Usage: bun scripts/mint-device-jwt.ts <meterId> --key <private.pem> [--device <id>] [--days N]");
  process.exit(1);
}

const keyPath = arg("--key");
const privateKey = keyPath
  ? readFileSync(keyPath, "utf8")
  : process.env.DEVICE_INGEST_JWT_PRIVATE_KEY;
if (!privateKey) {
  console.error("Provide the RSA private key via --key <path> or DEVICE_INGEST_JWT_PRIVATE_KEY.");
  process.exit(1);
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url");

const now = Math.floor(Date.now() / 1000);
const days = arg("--days");
const deviceId = arg("--device");

// Device tokens MUST carry an expiry (the server rejects tokens without one). Default to a
// long-lived 2 years so re-provisioning is rare; override with --days for a shorter window.
const expiryDays = days ? Number(days) : 730;

const header = { alg: "RS256", typ: "JWT" };
const payload: Record<string, unknown> = {
  sub: meterId,
  meterId,
  iat: now,
  exp: now + expiryDays * 86400,
};
if (deviceId) payload.deviceId = deviceId;

const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
const signer = createSign("RSA-SHA256");
signer.update(signingInput);
signer.end();
const signature = b64url(signer.sign(privateKey));
const token = `${signingInput}.${signature}`;

console.log(token);
