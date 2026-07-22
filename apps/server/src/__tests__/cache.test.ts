import { describe, expect, it } from "bun:test";
import { TtlCache } from "../cache";

// NOTE: the cache is disabled under NODE_ENV=test (so app tests stay deterministic).
// These tests exercise the DATA-STRUCTURE behavior directly by toggling NODE_ENV
// around each case, since that gate is read at method-call time.
async function withCachingEnabled<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = prev;
  }
}

describe("TtlCache", () => {
  it("is a no-op under NODE_ENV=test (every memo call hits the loader)", async () => {
    const cache = new TtlCache<number>();
    let calls = 0;
    const load = async () => {
      calls++;
      return 42;
    };
    expect(await cache.memo("k", 1000, load)).toBe(42);
    expect(await cache.memo("k", 1000, load)).toBe(42);
    expect(calls).toBe(2); // no caching in test mode
  });

  it("caches within the TTL and reloads after it expires", async () => {
    await withCachingEnabled(async () => {
      const cache = new TtlCache<number>();
      let calls = 0;
      const load = async () => {
        calls++;
        return calls;
      };
      expect(await cache.memo("k", 20, load)).toBe(1);
      expect(await cache.memo("k", 20, load)).toBe(1); // cache hit — loader not re-run
      expect(calls).toBe(1);
      await new Promise((r) => setTimeout(r, 30)); // let it expire
      expect(await cache.memo("k", 20, load)).toBe(2); // reloaded
      expect(calls).toBe(2);
    });
  });

  it("single-flights concurrent misses into one loader call", async () => {
    await withCachingEnabled(async () => {
      const cache = new TtlCache<string>();
      let calls = 0;
      const load = async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 15));
        return "v";
      };
      // Fire 6 parallel misses for the same key (the dashboard burst).
      const results = await Promise.all(Array.from({ length: 6 }, () => cache.memo("k", 1000, load)));
      expect(results).toEqual(["v", "v", "v", "v", "v", "v"]);
      expect(calls).toBe(1); // collapsed to a single DB round trip
    });
  });

  it("invalidates by exact key and by prefix", async () => {
    await withCachingEnabled(async () => {
      const cache = new TtlCache<string>();
      await cache.memo("access:s1:u1", 1000, async () => "editor");
      await cache.memo("access:s1:u2", 1000, async () => "viewer");
      await cache.memo("owner:u1:o1", 1000, async () => "yes");

      cache.delete("access:s1:u1");
      expect(cache.get("access:s1:u1")).toBeUndefined();
      expect(cache.get("access:s1:u2")).toBe("viewer");

      cache.deletePrefix("access:s1:");
      expect(cache.get("access:s1:u2")).toBeUndefined();
      expect(cache.get("owner:u1:o1")).toBe("yes"); // untouched
    });
  });
});
