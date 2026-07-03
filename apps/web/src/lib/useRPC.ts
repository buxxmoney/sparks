import { useEffect, useState } from "react";
import { getSelectedOrganization } from "./useOrganizationContext";

export function useRPC<T>(method: string, params?: unknown, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // For session.me and session.listMemberships, allow undefined params since they don't need them
    // For other methods, undefined params means we're not ready yet
    const allowedWithoutParams = ["session.me", "session.listMemberships"];
    const shouldSkip = params === undefined && !allowedWithoutParams.includes(method);

    if (shouldSkip) {
      setData(null);
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      setLoading(true);
      setError(null);

      try {
        const orgId = getSelectedOrganization();
        const headers: HeadersInit = {
          "Content-Type": "application/json",
        };

        if (orgId) {
          headers["x-organization-id"] = orgId;
        }

        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/rpc/call`,
          {
            method: "POST",
            headers,
            credentials: "include",
            body: JSON.stringify({
              method,
              params,
            }),
          },
        );

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || `HTTP ${response.status}`);
        }

        const result = await response.json();
        setData(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [method, ...(deps.length > 0 ? deps : [params])]);

  return { data, loading, error };
}
