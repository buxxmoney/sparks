// Load apps/server/.env (RESEND_API_KEY, EMAIL_FROM, WEB_URL, …) before any
// module that reads process.env. The dev server runs via tsx/Node which does NOT
// auto-load .env (unlike Bun); dotenv does not override vars already set by the
// launch config, so the inline DATABASE_URL/secret still win.
import "dotenv/config";
import { serve } from "@hono/node-server";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth";
import { createDeviceRouter, createIngestionRouter } from "./ingestion";
import { ForbiddenError, UnauthorizedError, requireSession } from "./middleware";
import type { ORPCContext } from "./orpc";
import { appRouter } from "./router.orpc";
import { getObject, objectExists, verifyObjectToken } from "./storage";

// Re-export the router type so the typed client (packages/api) can consume it.
export type { AppRouter } from "./router.orpc";

// Exported so tests can drive the fully-wired app via `app.request(...)` without
// opening a socket (a listener is only started under Node below).
export { app };

const app = new Hono();

// Allowed browser origins: the localhost dev ports plus any production web
// origin(s) from WEB_ORIGINS (comma-separated), e.g. "https://app.sparksmetering.com".
const corsOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
  "http://localhost:3002",
  "http://127.0.0.1:3002",
  ...(process.env.WEB_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
];

// CORS middleware
app.use(
  "*",
  cors({
    origin: corsOrigins,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "x-organization-id"],
    credentials: true,
  }),
);

// Health check endpoint
app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

// better-auth routes (mounted at /api/auth/*)
app.on(["GET", "POST"], "/api/auth/**", async (c) => {
  return auth.handler(c.req.raw);
});

// oRPC routes — the typed client posts to /rpc/<namespace>/<procedure>.
// The auth context is built by the layered middleware's requireSession (real
// better-auth session; identity-header spoof only under NODE_ENV==='test').
const rpcHandler = new RPCHandler(appRouter);

app.all("/rpc/*", async (c) => {
  let context: ORPCContext;
  try {
    context = { auth: await requireSession(c) };
  } catch (err) {
    if (err instanceof UnauthorizedError) return c.json({ error: err.message }, 401);
    if (err instanceof ForbiddenError) return c.json({ error: err.message }, 403);
    throw err;
  }

  const { matched, response } = await rpcHandler.handle(c.req.raw, {
    prefix: "/rpc",
    context,
  });

  if (matched) return response;
  return c.json({ error: "Not found" }, 404);
});

// Device-facing HTTP (docs/02 §4.2) — plain Hono routes, device HMAC auth, NOT oRPC.
//   POST /ingest/readings   POST /ingest/health
//   GET  /device/config/:deviceId   POST /device/commission
app.route("/ingest", createIngestionRouter());
app.route("/device", createDeviceRouter());

// Sealed-PDF download (docs/02 §4.2). Capability URL: the signed token minted by
// report.getPdf IS the access grant (site-access was checked when minting), so
// no session is needed here — the browser opens the URL directly. Streams the
// stored bytes from object storage.
app.get("/reports/file", async (c) => {
  const key = c.req.query("key");
  const expires = Number(c.req.query("expires"));
  const token = c.req.query("token");
  if (!key || !token || !Number.isFinite(expires)) {
    return c.json({ error: "Missing or malformed signed-URL parameters" }, 400);
  }
  if (!verifyObjectToken(key, expires, token)) {
    return c.json({ error: "Invalid or expired download link" }, 403);
  }
  if (!(await objectExists(key))) {
    return c.json({ error: "Report not found" }, 404);
  }
  const bytes = await getObject(key);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${key.split("/").pop() ?? "report.pdf"}"`,
    },
  });
});

// 404 handler
app.notFound((c) => c.json({ error: "Not found" }, 404));

// Start server (works with both Bun and Node.js/tsx)
const port = Number.parseInt(process.env.PORT || "3001");

// Check if running in Bun or Node.js
if (typeof Bun === "undefined") {
  // Node.js/tsx runtime - use serve
  serve(
    {
      fetch: app.fetch,
      port: port,
    },
    () => {
      console.log(`Server running on http://localhost:${port}`);
    },
  );
}

// Bun runtime export
export default {
  port,
  fetch: app.fetch,
};
