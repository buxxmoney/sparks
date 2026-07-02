import { Hono } from "hono";
import { auth } from "./auth";

const app = new Hono();

// Health check endpoint
app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

// better-auth routes (mounted at /api/auth/*)
app.on(["GET", "POST"], "/api/auth/**", async (c) => {
  return auth.handler(c.req.raw);
});

// oRPC routes (mounted at /rpc/*)
// Placeholder - will be implemented in Phase 2
app.post("/rpc/*", (c) => c.json({ error: "Not yet implemented" }, 501));

// Device ingestion API (mounted at /ingest/*)
// Placeholder - will be implemented in Phase 3
app.post("/ingest/*", (c) => c.json({ error: "Not yet implemented" }, 501));

// 404 handler
app.notFound((c) => c.json({ error: "Not found" }, 404));

// Start server (Bun runtime)
const port = Number.parseInt(process.env.PORT || "3001");
console.log(`Server running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
