export interface RPCClientOptions {
  baseUrl: string;
  headers?: Record<string, string>;
}

export interface AuthHeaders {
  "x-session-id"?: string;
  "x-user-id"?: string;
  "x-organization-id"?: string;
}

export class RPCClient {
  private baseUrl: string;
  private defaultHeaders: Record<string, string> = {};

  constructor(options: RPCClientOptions) {
    this.baseUrl = options.baseUrl;
    this.defaultHeaders = options.headers || {};
  }

  async call<T = unknown>(
    procedure: string,
    input?: unknown,
    authHeaders?: AuthHeaders,
  ): Promise<T> {
    const url = new URL("/rpc/call", this.baseUrl);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.defaultHeaders,
      ...(authHeaders || {}),
    };

    const response = await fetch(url.toString(), {
      method: "POST",
      headers,
      credentials: "include",
      body: JSON.stringify({
        method: procedure,
        params: input,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      throw new Error(
        `RPC call failed: ${procedure} - ${response.status} ${response.statusText}: ${errorData?.message || ""}`,
      );
    }

    return response.json();
  }
}

export function createClient(options: RPCClientOptions) {
  return new RPCClient(options);
}
