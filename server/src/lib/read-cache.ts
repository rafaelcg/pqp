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

/** THE PRIMARY BOUND: cap on distinct keys, same reasoning as
 *  `ROSTER_ACCESS_MAX_ENTRIES`: a cache with no cap grows with the number of
 *  distinct channels/servers ever asked about, not with how many are hot
 *  right now. LRU by touch order. Exported for the eviction test in
 *  `read-cache.test.ts`. */
export const MAX_ENTRIES = 5_000;

/**
 * THE SECONDARY BOUND. A count cap alone bounds how many DISTINCT KEYS live
 * here, not how much a single one costs, so `touch` evicts oldest-first
 * until BOTH caps are satisfied — a cache full of large message pages gives
 * up entries sooner than one full of small watch-party rows would. This is
 * a backstop on top of `MAX_ENTRIES`, not a precise budget: see
 * `PER_ROW_ESTIMATE_BYTES` for why `totalBytes` is an estimate rather than
 * a measurement, and `MAX_CACHEABLE_ROWS` for what actually bounds the
 * worst case a single entry can cost. 50 MB is generous for a process
 * whose real job is holding WebSocket connections open, not caching query
 * results.
 */
export const MAX_BYTES = 50 * 1024 * 1024;

interface Entry<T> {
  value: T;
  storedAt: number;
  /** Estimated byte cost, computed once at write time — see
   *  `PER_ROW_ESTIMATE_BYTES`; not a measurement of the real value. */
  size: number;
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
let totalBytes = 0;

/**
 * Per-row byte guess for an array value (a message page, a channel list).
 * Deliberately not measured: after three attempts at measuring this exactly
 * or approximately from real content (a flat constant tried and rejected
 * for underestimating a long body, reusing a stale size across a refresh,
 * sampling a handful of rows), the decision landed on NOT serializing on
 * the write path at all. `totalBytes` is therefore an ESTIMATE, NOT AN
 * UPPER BOUND — it will not notice a channel list whose rows happen to
 * carry unusually large fields. What keeps the actual worst case bounded
 * is `MAX_CACHEABLE_ROWS` below, not this number: the byte budget is the
 * SECONDARY trigger, `MAX_ENTRIES` (the key-count LRU) is the primary one,
 * and neither has to be exact to do its job of giving up the coldest
 * entries first once either cap is crossed.
 */
/** Fallback when a value cannot be serialised (circular, BigInt); real
 *  entries are measured by `estimateSize`. */
const SINGLE_VALUE_ESTIMATE_BYTES = 256;

/**
 * Rows above which a value is not cached at all (see `isCacheable`), which
 * is what actually bounds the worst case: `estimateSize` below is cheap
 * specifically because it never looks at the content, so nothing here
 * would notice a pathologically large row inflating the real size past
 * what `rows * PER_ROW_ESTIMATE_BYTES` says. Refusing to cache anything
 * over 2,000 rows means the estimate is only ever wrong by content, never
 * by row count, and a value this large was never the "500 identical
 * callers" case this module exists for anyway — the caller still gets its
 * data, it (and everyone racing it) just each pay for their own query.
 */
export const MAX_CACHEABLE_ROWS = 2_000;

/** Whether `value` is small enough to be worth caching at all. Only arrays
 *  have a row count; a single row or `null` is always cacheable. */
function isCacheable(value: unknown): boolean {
  return !Array.isArray(value) || value.length <= MAX_CACHEABLE_ROWS;
}

/**
 * `rows * PER_ROW_ESTIMATE_BYTES` for an array, a flat constant for
 * anything else — an estimate, not a measurement. See the comment on
 * `PER_ROW_ESTIMATE_BYTES` for why this module deliberately does not
 * serialize a value to size it, and `isCacheable` for what actually bounds
 * the worst case instead.
 */
function estimateSize(value: unknown): number {
  // Measured, not guessed. `MAX_CACHEABLE_ROWS` bounds how much this ever
  // serialises (a 2,000-row list is a few ms), and measuring is what makes
  // `MAX_BYTES` a real ceiling on resident memory rather than a nominal
  // one: a 100-row page of long bodies must count as what it weighs.
  try {
    const json = JSON.stringify(value);
    return json === undefined ? SINGLE_VALUE_ESTIMATE_BYTES : Buffer.byteLength(json, "utf8");
  } catch {
    return SINGLE_VALUE_ESTIMATE_BYTES;
  }
}

/** The one place an entry leaves `store`, so `totalBytes` cannot drift from
 *  what is actually cached. */
function removeEntry(key: string): void {
  const entry = store.get(key);
  if (entry) {
    totalBytes -= entry.size;
    store.delete(key);
  }
}

/**
 * Bumped on every `invalidate()` call, regardless of prefix — the same
 * single-counter shape `ws/voice.ts`'s roster access cache uses for the
 * same reason (#534). Without this, a load that was already in flight when
 * a write invalidated its key could still land afterward and write the
 * pre-write value back into `store`, undoing the invalidation: a member
 * kicked mid-request, or a message edited mid-reload, would keep answering
 * with the stale value until the TTL caught up on its own. Every write path
 * into `store` below captures `epoch` before starting its load and only
 * commits if it has not moved since — over-broad (an unrelated invalidation
 * also discards an in-flight write elsewhere), which is fine: the cost is
 * one extra cache miss, and this codebase treats a cross-request stale
 * *permission* answer as the class of bug worth paying that for.
 */
let epoch = 0;

/**
 * `READ_CACHE=off` (or `false`/`0`) disables it. Anything else, including
 * unset, leaves it on — same convention as `WS_COMPRESSION`.
 */
export function readCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.READ_CACHE?.trim().toLowerCase();
  return raw !== "off" && raw !== "false" && raw !== "0";
}

/**
 * `Map` iteration order is insertion order; a touch deletes-then-reinserts so
 * the entry moves to the end, and eviction always takes from the front.
 *
 * `entry` may be the SAME object already sitting in `store` (a plain
 * touch-for-recency on a hit) or a brand new one replacing what was there
 * (a fresh write after a load, including a stale-while-revalidate refresh
 * landing on top of the stale entry it is replacing). Either way,
 * subtracting whatever was there before adding what is there now keeps
 * `totalBytes` correct without the two cases needing to be told apart —
 * subtracting and re-adding the same size on a plain touch nets to zero.
 */
function touch<T>(key: string, entry: Entry<T>): void {
  const existing = store.get(key);
  if (existing) {
    totalBytes -= existing.size;
  }
  store.delete(key);
  store.set(key, entry);
  totalBytes += entry.size;
  while (store.size > 0 && (store.size > MAX_ENTRIES || totalBytes > MAX_BYTES)) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    removeEntry(oldest);
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
  // The `inflight` cleanup runs INSIDE the same `.then`/`.catch` pair that
  // settles `promise`, in the same microtask its own rejection reaches an
  // awaiter — not a separate `.catch().finally()` chained after it. That
  // used to add one extra microtask hop before the cleanup ran, which was
  // enough for a caller that awaits `coalesce`, sees it reject, and retries
  // in the very next line to find the just-rejected promise still sitting
  // in `inflight` and join it — reading the same stale error a second time
  // instead of starting a fresh load. `promise` is referenced inside its own
  // `.then`/`.catch` below, which is fine — those only run once this
  // assignment has completed — and it is exactly what makes the guard work:
  // `inflight.get(key) === promise` asks "is this load still the one the
  // map points to for this key", which is false when an `invalidate()` or
  // `invalidateExact()` ran while this was in flight (both delete the map
  // entry, so nothing points to this promise any more) and a fresh load may
  // since have taken the slot. Skipping the write in that case is the fix
  // for the race Farol's review caught: without this guard, an invalidated
  // load that finishes late writes its stale answer back in — and, since
  // `inflight.delete(key)` was unconditional, could also delete the newer
  // load's in-flight entry out from under it.
  const promise: Promise<T> = loader()
    .then((value) => {
      if (inflight.get(key) === promise) {
        inflight.delete(key);
        // A refresh that grew past `MAX_CACHEABLE_ROWS` is not written
        // back — the stale entry already in `store` keeps answering hits
        // until it ages into the doubly-stale miss path, same as any
        // other refresh failure.
        if (isCacheable(value)) {
          touch(key, {
            value,
            storedAt: Date.now(),
            size: estimateSize(value),
          });
        } else {
          // The stale entry must not keep answering hits and relaunching a
          // refresh every TTL for a value that will never be admitted:
          // drop it, and let callers load uncached until it shrinks.
          removeEntry(key);
        }
      }
      return value;
    })
    .catch((error: unknown) => {
      if (inflight.get(key) === promise) {
        inflight.delete(key);
      }
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
    removeEntry(key);
  }

  const pending = inflight.get(key);
  if (pending) {
    metrics.coalesced += 1;
    return pending as Promise<T>;
  }

  metrics.misses += 1;
  // Same "am I still the load this key points to" guard as `revalidate`,
  // and for the same reason: `invalidate()` / `invalidateExact()` may run
  // while this is in flight (an edit landing mid-fetch, say), clear this
  // key's `inflight` entry, and let a second, fresher load start and even
  // finish before this one does. Without the guard, this one's `.then`
  // would overwrite that fresher answer with data read before the write —
  // exactly the pre-edit-text-survives-the-edit bug the review flagged —
  // and its unconditional `inflight.delete` would remove the newer load's
  // entry too, letting a THIRD caller start a third redundant query.
  const promise: Promise<T> = loader()
    .then((value) => {
      if (inflight.get(key) === promise) {
        inflight.delete(key);
        // Over `MAX_CACHEABLE_ROWS`: every current and coalesced caller
        // still gets this answer (the `.then` return below), it is simply
        // never written to `store` — the next call is a fresh miss again.
        if (isCacheable(value)) {
          touch(key, { value, storedAt: Date.now(), size: estimateSize(value) });
        }
      }
      return value;
    })
    .catch((error: unknown) => {
      if (inflight.get(key) === promise) {
        inflight.delete(key);
      }
      throw error;
    });
  inflight.set(key, promise);
  return promise;
}

/**
 * Drop one exact key (and any in-flight load for it) in O(1) — no scan.
 * Use this whenever the caller already holds the complete key, which is the
 * common case (one channel's message page, one server's member list, one
 * user's age-gate status): `invalidate(prefix)` below still works for an
 * exact key too, but it scans every entry to find matches by string prefix,
 * which is wasted work once the key is already known in full.
 */
export function invalidateExact(key: string): void {
  removeEntry(key);
  inflight.delete(key);
}

/**
 * Drop every cached entry (and any in-flight load) whose key starts with
 * `prefix`. For a genuine family of keys — every user's cached role in one
 * server, every viewer's cached access to one channel, every page-size
 * variant of one channel's latest page — this is the only option: nothing
 * about `prefix` names which of those keys exist. Prefer `invalidateExact`
 * above when the caller already has one complete key; this scans the whole
 * cache (bounded by `MAX_ENTRIES`) on every call.
 */
export function invalidate(prefix: string): void {
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) {
      removeEntry(key);
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
 *  `dbTxByPath`. `bytes` is the running total behind the `MAX_BYTES`
 *  eviction trigger, so a sustained climb toward it is visible before an
 *  eviction storm starts, not just after. */
export function readCacheMetrics(): Metrics & { size: number; bytes: number } {
  return { ...metrics, size: store.size, bytes: totalBytes };
}

/** Test seam: wipe every entry, in-flight load and counter. `totalBytes` is
 *  tracked independently of `store` (so a delete can charge the right
 *  entry's size without a second lookup), which is exactly why clearing
 *  `store` alone would leave it drifted — a later test would then evict
 *  earlier than its own entries justify, or count `bytes` wrong. */
export function resetReadCacheForTests(): void {
  store.clear();
  inflight.clear();
  totalBytes = 0;
  metrics.hits = 0;
  metrics.misses = 0;
  metrics.coalesced = 0;
  metrics.staleServed = 0;
}
