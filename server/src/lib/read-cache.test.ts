import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  coalesce,
  invalidate,
  MAX_BYTES,
  MAX_CACHEABLE_ROWS,
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

  it("measures an entry's real serialised size, so content counts against the budget", async () => {
    const plain = new Array(10).fill(0).map(() => ({ body: "short" }));
    const heavy = new Array(10).fill(0).map(() => ({ body: "x".repeat(50_000) }));

    await coalesce("plain", 60_000, async () => plain);
    const plainBytes = readCacheMetrics().bytes;
    resetReadCacheForTests();
    await coalesce("heavy", 60_000, async () => heavy);
    const heavyBytes = readCacheMetrics().bytes;

    expect(plainBytes).toBe(Buffer.byteLength(JSON.stringify(plain), "utf8"));
    expect(heavyBytes).toBe(Buffer.byteLength(JSON.stringify(heavy), "utf8"));
    expect(heavyBytes).toBeGreaterThan(plainBytes * 100);
  });

  it("measures a single row or null too", async () => {
    await coalesce("row", 60_000, async () => ({ id: "x" }));
    expect(readCacheMetrics().bytes).toBe(Buffer.byteLength(JSON.stringify({ id: "x" }), "utf8"));

    resetReadCacheForTests();
    await coalesce("null", 60_000, async () => null);
    expect(readCacheMetrics().bytes).toBe(Buffer.byteLength("null", "utf8"));
  });

  it("re-measures on a stale-while-revalidate refresh", async () => {
    const ten = new Array(10).fill(0);
    const fifty = new Array(50).fill(0);
    await coalesce("k", 20, async () => ten);
    expect(readCacheMetrics().bytes).toBe(Buffer.byteLength(JSON.stringify(ten), "utf8"));

    await new Promise((r) => setTimeout(r, 30)); // into the stale window
    await coalesce("k", 20, async () => fifty); // stale-serves `ten`, refreshes in the background
    await new Promise((r) => setTimeout(r, 10)); // let the refresh land

    expect(readCacheMetrics().bytes).toBe(Buffer.byteLength(JSON.stringify(fifty), "utf8"));
  });

  it("drops the stale entry when a refresh grows past the row cap, instead of refreshing it forever", async () => {
    const small = new Array(10).fill(0);
    const huge = new Array(MAX_CACHEABLE_ROWS + 1).fill(0);
    await coalesce("grow", 20, async () => small);
    expect(readCacheMetrics().size).toBe(1);

    await new Promise((r) => setTimeout(r, 30)); // stale
    await coalesce("grow", 20, async () => huge); // stale-serves, refresh comes back oversized
    await new Promise((r) => setTimeout(r, 10));

    expect(readCacheMetrics().size).toBe(0);
    expect(readCacheMetrics().bytes).toBe(0);
  });

  it("evicts the oldest entry once the byte budget is exceeded, well under the entry cap", async () => {
    // Every entry here sits right at MAX_CACHEABLE_ROWS (the largest a
    // single entry is ever allowed to be), so this needs enough of them to
    // cross MAX_BYTES on its own — comfortably fewer than MAX_ENTRIES, so
    // only the byte trigger can be responsible for what gets evicted.
    const maxRows = new Array(MAX_CACHEABLE_ROWS).fill(0).map(() => ({ body: "x".repeat(1024) }));
    const perEntryBytes = Buffer.byteLength(JSON.stringify(maxRows), "utf8");
    const entriesNeeded = Math.ceil(MAX_BYTES / perEntryBytes) + 2;
    expect(entriesNeeded).toBeLessThan(MAX_ENTRIES);

    for (let i = 0; i < entriesNeeded; i++) {
      await coalesce(`big${i}`, 60_000, async () => maxRows);
    }
    expect(readCacheMetrics().bytes).toBeLessThanOrEqual(MAX_BYTES);
    expect(readCacheMetrics().size).toBeLessThan(entriesNeeded);

    // The oldest-touched entry is gone; the most recent is still cached.
    let reloadedFirst = false;
    await coalesce("big0", 60_000, async () => {
      reloadedFirst = true;
      return maxRows;
    });
    expect(reloadedFirst).toBe(true);

    let reloadedLast = false;
    await coalesce(`big${entriesNeeded - 1}`, 60_000, async () => {
      reloadedLast = true;
      return maxRows;
    });
    expect(reloadedLast).toBe(false);
  });

  it("refuses to cache a value over MAX_CACHEABLE_ROWS, but still answers every caller", async () => {
    const tooBig = new Array(MAX_CACHEABLE_ROWS + 1).fill(0);
    let calls = 0;
    const load = async () => {
      calls += 1;
      return tooBig;
    };

    // Concurrent callers of the SAME oversized load still coalesce onto one
    // in-flight query and all get the answer...
    const [a, b] = await Promise.all([
      coalesce("huge", 60_000, load),
      coalesce("huge", 60_000, load),
    ]);
    expect(a).toBe(tooBig);
    expect(b).toBe(tooBig);
    expect(calls).toBe(1);
    // ...but nothing was written to the cache, so bytes/size stay at zero
    // and the next call is a fresh miss.
    expect(readCacheMetrics()).toMatchObject({ size: 0, bytes: 0 });

    await coalesce("huge", 60_000, load);
    expect(calls).toBe(2);
  });

  it("still caches a value at exactly MAX_CACHEABLE_ROWS", async () => {
    const atLimit = new Array(MAX_CACHEABLE_ROWS).fill(0);
    let calls = 0;
    const load = async () => {
      calls += 1;
      return atLimit;
    };
    await coalesce("k", 60_000, load);
    await coalesce("k", 60_000, load);
    expect(calls).toBe(1);
    expect(readCacheMetrics().size).toBe(1);
  });

  it("resetReadCacheForTests clears the resident-byte counter, not just the entries", async () => {
    await coalesce("k", 60_000, async () => new Array(20).fill(0));
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
    await coalesce("k2", 60_000, async () => new Array(20).fill(0));
    expect(readCacheMetrics().bytes).toBe(sizeBefore);
  });
});
