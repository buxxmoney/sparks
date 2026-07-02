import { db } from "@sparks/db";
import { betterAuth } from "better-auth";

// Placeholder - better-auth will be configured in Phase 2
// This should integrate with the @sparks/db Drizzle schema

export const auth = betterAuth({
  database: {
    db: db as unknown as object, // Typed in Phase 2
    type: "drizzle",
  },
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3001",
  appName: "Sparks",
});
