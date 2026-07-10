import { describe, expect, it } from "bun:test";
import { db, user } from "@sparks/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { auth } from "../auth";
import { app } from "../index";

// Public self-signup is closed at the HTTP layer (index.ts). Operator provisioning uses
// auth.api.signUpEmail IN-PROCESS, which never touches this route, so it's unaffected.
describe("Public sign-up disabled", () => {
  it("blocks POST /api/auth/sign-up/email with 403", async () => {
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "random@example.com", password: "password123", name: "Random" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? "").toMatch(/disabled/i);
  });

  it("does NOT break sign-in (it still reaches better-auth → 401 for bad creds)", async () => {
    const res = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrongpass" }),
    });
    // Must be handled by better-auth (401 unauthorized), NOT our 403 guard and NOT a 404
    // (a 404 means the guard broke the catch-all's routing — regression guard).
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(401);
  });

  it("does NOT block in-process creation (auth.api.signUpEmail) — provisioning still works", async () => {
    // This is exactly what admin.createCustomer uses to onboard a customer. It runs
    // in-process, so the HTTP guard above can't touch it.
    const email = `inproc-${randomUUID()}@example.com`;
    const res = await auth.api.signUpEmail({
      body: { email, password: `${randomUUID()}${randomUUID()}`, name: "In Process" },
    });
    expect(res.user.email).toBe(email);
    // Cleanup — account + session cascade on user delete.
    await db.delete(user).where(eq(user.id, res.user.id));
  });
});
