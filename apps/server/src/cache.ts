/**
 * Tiny in-memory TTL cache for hot read paths and repeated authz lookups.
 *
 * The API runs as a single long-lived Node process (Railway), so a process-local
 * Map is the right tool — no Redis needed. Two properties make this worthwhile
 * given the ~350ms/request infra floor and cross-region DB round trips:
 *
 *  - TTL: a value stays warm for a few seconds, so 30s-interval dashboard polling
 *    and multiple concurrent viewers reuse one computed result.
 *  - Single-flight: concurrent callers for the same key share ONE in-flight
 *    promise, so the ~6 parallel calls a dashboard fires collapse to a single DB
 *    round trip even on a cold cache — not just on the next poll.
 *
 * Disabled under NODE_ENV=test: the suite creates and deletes data rapidly across
 * tests, and must never read a stale cached authz/result value. With caching off
 * every call is a live query, so tests stay deterministic.
 */

// Read per-call (not a module const) so the app-test suite — which runs under
// NODE_ENV=test — always sees a live query, while cache.test.ts can flip NODE_ENV
// to exercise the caching behavior directly.
function cachingDisabled(): boolean {
  return process.env.NODE_ENV === "test";
}

type Entry<V> = { value: V; expiresAt: number };

export class TtlCache<V> {
  private store = new Map<string, Entry<V>>();
  private inflight = new Map<string, Promise<V>>();

  get(key: string): V | undefined {
    if (cachingDisabled()) return undefined;
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    if (cachingDisabled()) return;
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  /** Drop every key beginning with `prefix` — targeted invalidation on writes. */
  deletePrefix(prefix: string): void {
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) this.store.delete(k);
    }
  }

  clear(): void {
    this.store.clear();
    this.inflight.clear();
  }

  /**
   * Resolve `key`, computing + caching via `loader` on a miss. Loaders MUST return
   * a defined value (use `null` for "absent") — an `undefined` result is treated as
   * a miss and won't be cached. Concurrent misses for the same key share one loader
   * call (single-flight); a loader rejection is propagated and nothing is cached.
   */
  async memo(key: string, ttlMs: number, loader: () => Promise<V>): Promise<V> {
    if (cachingDisabled()) return loader();

    const hit = this.get(key);
    if (hit !== undefined) return hit;

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const p = loader()
      .then((value) => {
        if (value !== undefined) this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, p);
    return p;
  }
}
