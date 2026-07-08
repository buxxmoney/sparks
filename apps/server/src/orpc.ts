import { os, ORPCError } from "@orpc/server";
import type { z } from "zod";
import type { AuthContext } from "./middleware";
import { ForbiddenError, PreconditionError, UnauthorizedError } from "./middleware";

// The oRPC request context. The Hono adapter builds `auth` per request
// (see index.ts) exactly as the old /rpc/call dispatcher did.
export interface ORPCContext {
  auth: AuthContext;
}

// Base builder: sets the context type and maps the domain error classes thrown
// by the existing procedures onto oRPC error codes — preserving the 401/403/500
// behavior the old hand-rolled dispatcher had.
const base = os.$context<ORPCContext>().use(async ({ next }) => {
  try {
    return await next();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      throw new ORPCError("UNAUTHORIZED", { message: err.message });
    }
    if (err instanceof ForbiddenError) {
      throw new ORPCError("FORBIDDEN", { message: err.message });
    }
    if (err instanceof PreconditionError) {
      // Client-actionable precondition — surface the message (400) instead of 500.
      throw new ORPCError("BAD_REQUEST", { message: err.message });
    }
    // Unexpected error: the browser only sees a generic 500, so log everything we
    // can (name, message, full stack, and any nested `cause`) to make the server
    // logs actionable. `console.error(err)` alone often prints "[object Object]"
    // for non-Error throwables — serialize defensively.
    if (err instanceof Error) {
      console.error(
        `[rpc] procedure error: ${err.name}: ${err.message}\n${err.stack ?? "(no stack)"}`,
      );
      const cause = (err as { cause?: unknown }).cause;
      if (cause) {
        console.error(
          "[rpc] └─ cause:",
          cause instanceof Error ? `${cause.name}: ${cause.message}\n${cause.stack}` : cause,
        );
      }
    } else {
      console.error("[rpc] procedure error (non-Error thrown):", JSON.stringify(err));
    }
    throw err; // oRPC maps unknown errors to INTERNAL_SERVER_ERROR (500)
  }
});

/**
 * Wrap an existing `(ctx, input) => result` business function as a typed oRPC
 * procedure. The function itself is unchanged — oRPC validates the input with
 * the provided zod schema and injects the auth context. This keeps the
 * migration strictly behavior-preserving (the same functions the tests call
 * directly are the ones served).
 */
export function proc<TSchema extends z.ZodTypeAny, TOutput>(
  schema: TSchema,
  fn: (ctx: AuthContext, input: z.output<TSchema>) => Promise<TOutput>,
) {
  return base.input(schema).handler(({ input, context }) => fn(context.auth, input));
}

/** Same as `proc`, for procedures that take no input. */
export function procNoInput<TOutput>(fn: (ctx: AuthContext) => Promise<TOutput>) {
  return base.handler(({ context }) => fn(context.auth));
}
