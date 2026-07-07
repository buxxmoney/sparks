import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@sparks/server";

// Fully-typed client for the Sparks oRPC API, shared by web and (later) mobile.
// Calls look like `client.sites.list({ organizationId })` with end-to-end types
// inferred from the server procedures — a wrong input or output access fails tsc.
export type SparksClient = RouterClient<AppRouter>;

export interface CreateClientOptions {
  /** Base URL of the server, e.g. http://localhost:3001 (no trailing /rpc). */
  baseUrl: string;
  /** Extra headers evaluated on every call (e.g. the selected organization id). */
  headers?: () => Record<string, string>;
}

export function createSparksClient(options: CreateClientOptions): SparksClient {
  const link = new RPCLink({
    url: `${options.baseUrl.replace(/\/$/, "")}/rpc`,
    headers: options.headers,
    // Include cookies so the better-auth session travels with every request.
    fetch: (request, init) => globalThis.fetch(request, { ...init, credentials: "include" }),
  });

  return createORPCClient<SparksClient>(link);
}
