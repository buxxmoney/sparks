import { useCallback, useEffect, useState } from "react";

/**
 * Runs a typed oRPC client call and tracks loading/error/data, re-running when
 * `deps` change. Pass `null` as the fetcher when the call isn't ready yet
 * (e.g. an id hasn't loaded) — the hook stays idle without firing.
 *
 * Usage:
 *   const { data, loading, error, refetch } = useRPC(
 *     orgId ? () => client.sites.list({ organizationId: orgId }) : null,
 *     [orgId],
 *   );
 */
export function useRPC<T>(fetcher: (() => Promise<T>) | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(fetcher !== null);
  const [error, setError] = useState<string | null>(null);

  const isReady = fetcher !== null;

  const run = useCallback(async () => {
    if (!fetcher) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setData(await fetcher());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, ...deps]);

  useEffect(() => {
    run();
  }, [run]);

  return { data, loading, error, refetch: run };
}
