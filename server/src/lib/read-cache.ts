/**
 * A small, generic read-through cache for the "identical query, 500 callers"
 * shape a reload storm produces — the reason this exists is the
 * 2026-09-12 watch party postmortem (A2): 141 reconnecting tabs each asked
 * Postgres for the same channel's latest message page, the same server's
 * channel list, and the same channel's watch-party state, and the pool (70)
 * queued 79 of them. None of those three answers differ by who is asking —
 * only whether they are ALLOWED to see it does, and that check stays outside
 * this module. See the three call sites in `services/messages.ts`,
 * `services/servers.ts` and `services/watch-parties.ts`.
 *
 * SHAPE, deliberately copied from the roster access cache
 * (`canAccessChannelForRoster` in `ws/voice.ts`, added by #534): a short TTL,
 * in-flight coalescing so a stampede of concurrent misses becomes one query,
 * and a bounded LRU so a long-lived process cannot grow this without limit.
 * Two differences from that cache, both because this one is generic rather
 * than boolean-shaped: stale-while-revalidate (a cache this small can afford
 * to serve one extra TTL of staleness rather than block a caller on a fresh
 * fetch), and no jitter (jitter defeats correlated thundering herds on a
 * cache keyed by *when* an entry was touched; this cache's whole purpose is
 * many callers touching the same key in the same instant, so there is
 * nothing to spread out).
 *
 * WHAT THIS MUST NEVER CACHE: anything whose answer differs by viewer. A
 * cache keyed by `<thing>:<viewerId>` defeats the entire point — it does not
 * collapse the storm, it just gives the storm a longer name — and worse, a
 * bug that keys two viewers' data under the same key by mistake is exactly
 * the kind of cross-account leak this codebase treats as the worst class of
 * bug there is. Authorization is the caller's job, checked on every request
 * against the real membership tables, same as before this file existed;
 * `coalesce` only shares the DATA FETCH that follows a successful check.
 *
 * ROLLBACK. `READ_CACHE=off` (or `false`/`0`) makes `coalesce` call the
 * loader directly, every time, same as `WS_COMPRESSION`'s switch
 * (`lib/ws-compression.ts`) — an operator flips one env var and a bad
 * interaction with a specific query shape is gone with no deploy.
 */

const DEFAULT_TTL_MS = 2_000;

/** Cap on distinct keys, same reasoning as `ROSTER_ACCESS_MAX_ENTRIES`: a
 *  cache with no cap grows with the number of distinct channels/servers ever
 *  asked about, not with how many are hot right now. LRU by touch order.
 *  Exported for the eviction test in `read-cache.test.ts`. */
export const MAX_ENTRIES = 5_000;

interface Entry<T> {
  value: T;
  storedAt: number;
}

interface Metrics {
  hits: number;
  misses: number;
  coalesced: number;
  staleServed: number;
}

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const metrics: Metrics = { hits: 0, misses: 0, coalesced: 0, staleServed: 0 };

/**
 * `READ_CACHE=off` (or `false`/`0`) disables it. Anything else, including
 * unset, leaves it on — same convention as `WS_COMPRESSION`.
 */
export function readCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.READ_CACHE?.trim().toLowerCase();
  return raw !== "off" && raw !== "false" && raw !== "0";
}

/** `Map` iteration order is insertion order; a touch deletes-then-reinserts
 *  so the entry moves to the end, and eviction always takes from the front. */
function touch<T>(key: string, entry: Entry<T>): void {
  store.delete(key);
  store.set(key, entry);
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    store.delete(oldest);
  }
}

/**
 * Fetch a background refresh for a stale entry. Coalesced with `inflight` —
 * two callers finding the same stale entry in the same instant must not
 * start two refreshes — and a failed refresh is swallowed here rather than
 * thrown at whichever caller happened to trigger it: the stale value already
 * answered them, and the next `coalesce` call will either find a still-stale
 * (but not yet doubly-stale) entry and try again, or fall through to a
 * blocking load once the entry ages past the stale window. That is the
 * self-healing bound: a loader that is down does not get retried forever in
 * the background, and a caller eventually sees the real error.
 */
function revalidate<T>(
  key: string,
  loader: () => Promise<T>,
): void {
  if (inflight.has(key)) {
    return;
  }
  const promise = loader()
    .then((value) => {
      inflight.delete(key);
      touch(key, { value, storedAt: Date.now() });
      return value;
    })
    .catch((error: unknown) => {
      inflight.delete(key);
      throw error;
    });
  // A background refresh's rejection must not become an unhandled rejection
  // just because nobody is awaiting this particular promise; a caller that
  // DID await it (one that raced in as a plain miss, see below) still sees
  // the throw via its own reference to the same promise.
  promise.catch(() => {});
  inflight.set(key, promise);
}

/**
 * Read-through cache with in-flight coalescing and stale-while-revalidate.
 *
 * - A fresh hit (`age < ttlMs`) returns the cached value with no I/O.
 * - A stale hit (`ttlMs <= age < ttlMs * 2`) returns the cached value
 *   immediately and kicks a background refresh, coalesced across callers.
 * - Anything older, or a miss, calls `loader()`; concurrent callers for the
 *   same key while that call is in flight share its result rather than each
 *   starting their own — the 500-tabs-reload case this module exists for.
 *
 * `ttlMs` is read per call rather than fixed per key, so a caller may tune it
 * per call site without a second cache instance; it is applied at both the
 * fresh/stale boundary and the stale/expired boundary (the stale window is
 * always one more `ttlMs`).
 */
export async function coalesce<T>(
  key: string,
  ttlMs: number = DEFAULT_TTL_MS,
  loader: () => Promise<T>,
): Promise<T> {
  if (!readCacheEnabled()) {
    return loader();
  }

  const now = Date.now();
  const entry = store.get(key) as Entry<T> | undefined;
  if (entry) {
    const age = now - entry.storedAt;
    if (age < ttlMs) {
      metrics.hits += 1;
      touch(key, entry);
      return entry.value;
    }
    if (age < ttlMs * 2) {
      metrics.staleServed += 1;
      touch(key, entry);
      revalidate(key, loader);
      return entry.value;
    }
    // Doubly stale: treat exactly like a miss below, including sharing an
    // in-flight load with anyone else who arrives while this one runs.
    store.delete(key);
  }

  const pending = inflight.get(key);
  if (pending) {
    metrics.coalesced += 1;
    return pending as Promise<T>;
  }

  metrics.misses += 1;
  const promise = loader()
    .then((value) => {
      inflight.delete(key);
      touch(key, { value, storedAt: Date.now() });
      return value;
    })
    .catch((error: unknown) => {
      inflight.delete(key);
      throw error;
    });
  inflight.set(key, promise);
  return promise;
}

/**
 * Drop every cached entry (and any in-flight load) whose key starts with
 * `prefix`. Pass a full key for a single-entry invalidation (the common
 * case: one channel's message page, one server's channel list) or a shared
 * prefix to drop a family of keys at once (every page-size variant of one
 * channel's latest page, say).
 */
export function invalidate(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
    }
  }
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) {
      inflight.delete(key);
    }
  }
}

/** Snapshot for `GET /api/admin/metrics` under `readCache.*`. Cumulative
 *  since boot (or the last `resetReadCacheForTests`), same convention as
 *  `dbTxByPath`. */
export function readCacheMetrics(): Metrics & { size: number } {
  return { ...metrics, size: store.size };
}

/** Test seam: wipe every entry, in-flight load and counter. */
export function resetReadCacheForTests(): void {
  store.clear();
  inflight.clear();
  metrics.hits = 0;
  metrics.misses = 0;
  metrics.coalesced = 0;
  metrics.staleServed = 0;
}
