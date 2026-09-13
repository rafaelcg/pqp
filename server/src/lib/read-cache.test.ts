import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  coalesce,
  invalidate,
  MAX_BYTES,
  MAX_ENTRIES,
  readCacheEnabled,
  readCacheMetrics,
  resetReadCacheForTests,
} from "./read-cache.js";

/** A promise plus the function that settles it, for a loader whose
 *  completion the test controls rather than a timer. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("read-cache", () => {
  beforeEach(() => {
    resetReadCacheForTests();
    delete process.env.READ_CACHE;
  });

  afterEach(() => {
    delete process.env.READ_CACHE;
  });

  describe("readCacheEnabled", () => {
    it("defaults on when unset", () => {
      expect(readCacheEnabled({})).toBe(true);
    });

    it("is off for off/false/0, case- and whitespace-insensitive", () => {
      expect(readCacheEnabled({ READ_CACHE: "off" })).toBe(false);
      expect(readCacheEnabled({ READ_CACHE: "OFF" })).toBe(false);
      expect(readCacheEnabled({ READ_CACHE: " off " })).toBe(false);
      expect(readCacheEnabled({ READ_CACHE: "false" })).toBe(false);
      expect(readCacheEnabled({ READ_CACHE: "0" })).toBe(false);
    });

    it("stays on for anything else, including a typo", () => {
      expect(readCacheEnabled({ READ_CACHE: "on" })).toBe(true);
      expect(readCacheEnabled({ READ_CACHE: "ofF-typo" })).toBe(true);
    });
  });

  // ------------------------------------------------------------ coalescing

  it("issues exactly one loader call for 50 concurrent callers of the same key", async () => {
    let calls = 0;
    const gate = deferred<number>();
    const loader = () => {
      calls += 1;
      return gate.promise;
    };

    const inFlight = Array.from({ length: 50 }, () => coalesce("k", 2_000, loader));
    // Give every caller a turn to reach the cache before the loader settles,
    // so they land on the SAME in-flight promise rather than a fresh miss.
    await new Promise((r) => setTimeout(r, 10));
    gate.resolve(42);
    const values = await Promise.all(inFlight);

    expect(calls).toBe(1);
    expect(values).toEqual(Array<number>(50).fill(42));
    const metrics = readCacheMetrics();
    expect(metrics.misses).toBe(1);
    expect(metrics.coalesced).toBe(49);
  });

  it("serves a fresh entry with no further loader call", async () => {
    let calls = 0;
    const first = await coalesce("k", 2_000, async () => {
      calls += 1;
      return "v1";
    });
    const second = await coalesce("k", 2_000, async () => {
      calls += 1;
      return "v2";
    });

    expect(first).toBe("v1");
    expect(second).toBe("v1");
    expect(calls).toBe(1);
    expect(readCacheMetrics()).toMatchObject({ misses: 1, hits: 1 });
  });

  it("propagates a loader rejection without caching it", async () => {
    let calls = 0;
    await expect(
      coalesce("k", 2_000, async () => {
        calls += 1;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const recovered = await coalesce("k", 2_000, async () => {
      calls += 1;
      return "ok";
    });
    expect(recovered).toBe("ok");
    expect(calls).toBe(2);
  });

  // ------------------------------------------------------------ invalidation

  it("invalidate(key) drops the entry so the next call reloads", async () => {
    let calls = 0;
    const load = () => {
      calls += 1;
      return Promise.resolve(calls);
    };
    expect(await coalesce("k", 2_000, load)).toBe(1);
    invalidate("k");
    expect(await coalesce("k", 2_000, load)).toBe(2);
    expect(calls).toBe(2);
  });

  it("invalidate(prefix) drops every key sharing the prefix and no others", async () => {
    await coalesce("messages:latest:c1:50", 2_000, async () => "a");
    await coalesce("messages:latest:c1:100", 2_000, async () => "b");
    await coalesce("messages:latest:c2:50", 2_000, async () => "c");

    invalidate("messages:latest:c1:");

    let calls = 0;
    const c1 = await coalesce("messages:latest:c1:50", 2_000, async () => {
      calls += 1;
      return "fresh";
    });
    const c2 = await coalesce("messages:latest:c2:50", 2_000, async () => {
      calls += 1;
      return "should not run";
    });

    expect(c1).toBe("fresh");
    expect(c2).toBe("c"); // untouched by the c1-scoped invalidation
    expect(calls).toBe(1); // only c1's key needed a reload
  });

  it("invalidate also cancels a matching in-flight load", async () => {
    const gate = deferred<string>();
    let calls = 0;
    const firstLoad = coalesce("k", 2_000, () => {
      calls += 1;
      return gate.promise;
    });
    // Invalidate while the first load is still pending.
    invalidate("k");
    const secondLoad = coalesce("k", 2_000, async () => {
      calls += 1;
      return "second";
    });
    gate.resolve("first");

    expect(await firstLoad).toBe("first");
    expect(await secondLoad).toBe("second");
    // Both loaders ran: the invalidation stopped the second caller from
    // joining a promise that answers a question that no longer applies.
    expect(calls).toBe(2);
  });

  it("does not let an invalidated load's late answer overwrite a fresher one, even resolving last", async () => {
    // The exact ordering the review caught: a read starts, a write
    // invalidates it mid-flight, a second read starts and finishes FIRST,
    // and only then does the original (invalidated) read resolve. Its
    // now-stale answer must not land in the cache on top of the fresh one,
    // and its cleanup must not delete the fresh entry's in-flight bookkeeping
    // out from under a THIRD caller.
    const staleGate = deferred<string>();
    let calls = 0;
    const staleLoad = coalesce("k", 2_000, () => {
      calls += 1;
      return staleGate.promise;
    });

    invalidate("k"); // a write lands while `staleLoad` is still in flight

    const freshLoad = await coalesce("k", 2_000, async () => {
      calls += 1;
      return "fresh";
    });
    expect(freshLoad).toBe("fresh");

    // Now let the ORIGINAL, invalidated load resolve, after the fresh one
    // already completed and populated the cache.
    staleGate.resolve("stale");
    expect(await staleLoad).toBe("stale"); // the caller still gets its own answer

    // But the cache must still hold the fresh value, not the stale one, and
    // must not have been left in an in-flight state either.
    let thirdCalls = 0;
    const thirdRead = await coalesce("k", 2_000, async () => {
      thirdCalls += 1;
      return "should not run";
    });
    expect(thirdRead).toBe("fresh");
    expect(thirdCalls).toBe(0); // served from the cache, not a new load
    expect(calls).toBe(2); // only the stale and fresh loaders ever ran
  });

  // ------------------------------------------------------- stale-while-revalidate

  it("serves a stale value inside the stale window and refreshes it in the background", async () => {
    let calls = 0;
    const load = () => {
      calls += 1;
      return Promise.resolve(`v${calls}`);
    };
    expect(await coalesce("k", 30, load)).toBe("v1");

    // Past the TTL but inside the one-extra-TTL stale window.
    await new Promise((r) => setTimeout(r, 45));
    const stale = await coalesce("k", 30, load);
    expect(stale).toBe("v1"); // still the old value, served with no wait
    expect(calls).toBe(2); // the background refresh WAS started
    expect(readCacheMetrics().staleServed).toBe(1);

    // Let the background refresh land.
    await new Promise((r) => setTimeout(r, 10));
    const refreshed = await coalesce("k", 30, load);
    expect(refreshed).toBe("v2"); // now serving what the refresh fetched
    expect(calls).toBe(2); // no additional loader call was needed for this read
  });

  it("coalesces concurrent stale hits into one background refresh", async () => {
    let calls = 0;
    const gate = deferred<string>();
    const load = () => {
      calls += 1;
      return calls === 1 ? Promise.resolve("v1") : gate.promise;
    };
    await coalesce("k", 20, load);
    await new Promise((r) => setTimeout(r, 30)); // now stale

    const stale1 = await coalesce("k", 20, load);
    const stale2 = await coalesce("k", 20, load);
    expect(stale1).toBe("v1");
    expect(stale2).toBe("v1");
    // Only one background refresh, even though two callers found it stale.
    expect(calls).toBe(2);
    gate.resolve("v2");
    await new Promise((r) => setTimeout(r, 5));
  });

  it("falls through to a blocking load once an entry is doubly stale", async () => {
    let calls = 0;
    const load = () => {
      calls += 1;
      return Promise.resolve(`v${calls}`);
    };
    expect(await coalesce("k", 20, load)).toBe("v1");

    // Past ttl * 2: no longer eligible for stale-while-revalidate.
    await new Promise((r) => setTimeout(r, 55));
    const result = await coalesce("k", 20, load);
    expect(result).toBe("v2");
    expect(calls).toBe(2);
    // Both the original fetch and this one are real misses, not stale serves.
    expect(readCacheMetrics().misses).toBe(2);
    expect(readCacheMetrics().staleServed).toBe(0);
  });

  // --------------------------------------------------------------- rollback

  it("READ_CACHE=off calls the loader every time with no coalescing or counters", async () => {
    process.env.READ_CACHE = "off";
    let calls = 0;
    const [a, b] = await Promise.all([
      coalesce("k", 2_000, async () => {
        calls += 1;
        return calls;
      }),
      coalesce("k", 2_000, async () => {
        calls += 1;
        return calls;
      }),
    ]);
    expect(calls).toBe(2);
    expect(new Set([a, b]).size).toBe(2); // each caller got its own answer
    const metrics = readCacheMetrics();
    expect(metrics.hits + metrics.misses + metrics.coalesced + metrics.staleServed).toBe(0);
  });

  // ------------------------------------------------------------------- LRU

  it("evicts the oldest-touched entry once the cache exceeds its cap", async () => {
    for (let i = 0; i < MAX_ENTRIES; i++) {
      await coalesce(`k${i}`, 60_000, async () => i);
    }
    expect(readCacheMetrics().size).toBe(MAX_ENTRIES);

    // One more entry pushes the size past the cap, so the oldest-touched
    // key (`k0`, never touched again since it was written) is evicted.
    await coalesce(`k${MAX_ENTRIES}`, 60_000, async () => MAX_ENTRIES);
    expect(readCacheMetrics().size).toBe(MAX_ENTRIES);

    let reloaded = false;
    await coalesce("k0", 60_000, async () => {
      reloaded = true;
      return -1;
    });
    expect(reloaded).toBe(true);

    // A recently-touched key (the last one written) must still be cached.
    let reloadedLast = false;
    await coalesce(`k${MAX_ENTRIES}`, 60_000, async () => {
      reloadedLast = true;
      return -1;
    });
    expect(reloadedLast).toBe(false);
  }, 20_000);

  it("evicts the oldest entry once the byte budget is exceeded, well under the entry cap", async () => {
    // A handful of large entries, each a fraction of MAX_BYTES, should start
    // evicting long before MAX_ENTRIES is anywhere close — the count cap
    // alone would happily hold thousands of these. `estimateSize` measures
    // the real serialized size on a miss (see its doc comment), so a plain
    // string's length maps directly to its accounted size here.
    const chunk = "x".repeat(Math.floor(MAX_BYTES / 4));
    await coalesce("big0", 60_000, async () => chunk);
    await coalesce("big1", 60_000, async () => chunk);
    await coalesce("big2", 60_000, async () => chunk);
    expect(readCacheMetrics().size).toBe(3);

    // A fourth entry of the same size pushes total bytes over budget, so
    // the oldest-touched one (`big0`) must go.
    await coalesce("big3", 60_000, async () => chunk);
    expect(readCacheMetrics().bytes).toBeLessThanOrEqual(MAX_BYTES);

    let reloaded = false;
    await coalesce("big0", 60_000, async () => {
      reloaded = true;
      return chunk;
    });
    expect(reloaded).toBe(true);

    let reloadedLast = false;
    await coalesce("big3", 60_000, async () => {
      reloadedLast = true;
      return chunk;
    });
    expect(reloadedLast).toBe(false);
  });

  it("measures a cold load's real size accurately, not a flat per-row guess", async () => {
    // The estimator was tried as a flat `row count * constant` guess and
    // rejected: a message body or an embed blob can run well past a generic
    // per-row constant, which would let the byte budget understate what is
    // actually resident. A single very large value (bigger than a
    // thousand-row page ever would be at a constant-per-row rate) must be
    // measured close to its real size, not rounded down to a small guess.
    const bigValue = "y".repeat(200_000);
    await coalesce("k", 60_000, async () => bigValue);
    expect(readCacheMetrics().bytes).toBeGreaterThanOrEqual(200_000);
  });

  it("reuses the previous entry's byte size on a stale-while-revalidate refresh instead of recomputing it", async () => {
    // The expensive half of `estimateSize` (serializing the whole value) is
    // deliberately paid on a miss and NOT on every stale-while-revalidate
    // refresh a hot key goes through — see the comment on `estimateSize` for
    // why reusing the previous size is not just cheap but usually exact
    // (every write that could actually change the answer invalidates first,
    // so an unforced refresh is normally re-fetching unchanged content).
    // This proves the reuse, not just that the numbers happen to agree: the
    // refresh here returns a value with a VERY different real size, and
    // `bytes` must still reflect the ORIGINAL entry's size, which is only
    // possible if the refresh path did not call `estimateSize` again.
    const small = "a";
    const muchBigger = "b".repeat(50_000);
    await coalesce("k", 20, async () => small);
    const sizeAfterFirst = readCacheMetrics().bytes;
    expect(sizeAfterFirst).toBeLessThan(100);

    await new Promise((r) => setTimeout(r, 30)); // into the stale window
    await coalesce("k", 20, async () => muchBigger); // stale-serves `small`, refreshes in the background
    await new Promise((r) => setTimeout(r, 10)); // let the refresh land

    expect(readCacheMetrics().bytes).toBe(sizeAfterFirst);
  });

  it("resetReadCacheForTests clears the resident-byte counter, not just the entries", async () => {
    await coalesce("k", 60_000, async () => "x".repeat(1_000));
    const sizeBefore = readCacheMetrics().bytes;
    expect(sizeBefore).toBeGreaterThan(0);

    resetReadCacheForTests();

    expect(readCacheMetrics()).toMatchObject({
      size: 0,
      bytes: 0,
      hits: 0,
      misses: 0,
      coalesced: 0,
      staleServed: 0,
    });

    // And the counter tracks a fresh write correctly afterward, rather than
    // starting from whatever it silently carried over.
    await coalesce("k2", 60_000, async () => "x".repeat(1_000));
    expect(readCacheMetrics().bytes).toBe(sizeBefore);
  });
});
