import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { auth } from "./auth";
import { appRouter } from "./routers";

const app = new Hono();

// CORS middleware
app.use(
  "*",
  cors({
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3001",
    ],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "x-session-id", "x-user-id", "x-organization-id"],
    credentials: true,
  }),
);

// Health check endpoint
app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

// better-auth routes (mounted at /api/auth/*)
app.on(["GET", "POST"], "/api/auth/**", async (c) => {
  return auth.handler(c.req.raw);
});

// oRPC routes
app.post("/rpc/call", async (c) => {
  try {
    const { method, params } = await c.req.json();

    if (!method) {
      return c.json({ error: "Missing method" }, 400);
    }

    // Parse the method path (e.g., "sites.list" -> ["sites", "list"])
    const methodParts = method.split(".");
    let handler: any = appRouter;

    for (const part of methodParts) {
      handler = handler[part];
      if (!handler) {
        return c.json({ error: `Method not found: ${method}` }, 404);
      }
    }

    // Get auth context from better-auth session
    // TODO: Verify this works with better-auth v1.6.0 Hono integration
    let session: any = null;
    try {
      session = await auth.api.getSession({ headers: c.req.raw.headers });
    } catch (e) {
      // Fallback: check for manual session headers (for testing)
      const userId = c.req.header("x-user-id");
      const sessionId = c.req.header("x-session-id");
      const organizationId = c.req.header("x-organization-id");

      if (userId && sessionId) {
        session = {
          user: { id: userId },
          session: { id: sessionId },
        };
        console.log("Using fallback session headers for testing");
      }
    }

    if (!session?.user) {
      console.error("No session found, headers:", c.req.raw.headers);
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Build auth context
    const authContext = {
      userId: session.user.id,
      sessionId: session.session?.id || "",
      organizationId: params?.organizationId || "", // Will be extracted from params or user's default org
    };

    // Call the handler
    const result = await handler(authContext, params);

    return c.json(result);
  } catch (error: any) {
    console.error("oRPC error:", error);

    if (error.name === "UnauthorizedError") {
      return c.json({ error: error.message }, 401);
    }

    if (error.name === "ForbiddenError") {
      return c.json({ error: error.message }, 403);
    }

    return c.json({ error: error.message || "Internal server error" }, 500);
  }
});

// Device ingestion API (mounted at /ingest/*)
// Placeholder - will be implemented in Phase 3
app.post("/ingest/*", (c) => c.json({ error: "Not yet implemented" }, 501));

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
    (info) => {
      console.log(`Server running on http://localhost:${port}`);
    }
  );
}

// Bun runtime export
export default {
  port,
  fetch: app.fetch,
};
