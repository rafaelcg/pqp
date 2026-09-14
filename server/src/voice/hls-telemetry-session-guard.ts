/**
 * Bounds `resolveHlsSessionId`'s database lookup on the telemetry ingest
 * path (BROADCAST_PIPELINE B0.6) and stops a struggling lookup from being
 * retried on every flush. Three Farol findings, 2026-09-14, on the SAME call:
 *
 * "Telemetry requests can remain stuck on a hung session lookup"
 * (reliability) -- `resolveHlsSessionId` never rejects (it catches
 * internally and returns null), so nothing downstream would notice a truly
 * hung connection acquisition without its own bound. `resolve` races the
 * lookup against `timeoutMs`; on a timeout the caller is told to fail the
 * batch CLOSED (its own 503), not fall back silently -- a fallback that
 * looks like success is what let a stuck pool go unnoticed the first time
 * this route shipped.
 *
 * "Telemetry batches can repeatedly retry a failed session lookup"
 * (performance) -- a batch every `LIVE_HLS_TELEMETRY_FLUSH_MS` for the same
 * struggling session would otherwise re-run the same query for as long as
 * the outage lasts. A timeout marks its key "negatively cached" for
 * `negativeCacheMs`: every call for that key inside the window is answered
 * `"negatively-cached"` with NO lookup attempted at all, so the caller
 * degrades gracefully (its own composite fallback id) instead of hammering
 * the database again. The negative cache itself is bounded
 * (`negativeCacheMaxSize`, default 1,000 keys): a struggling deployment with
 * many distinct sessions timing out does not get an unbounded map alongside
 * its unbounded database pressure -- the OLDEST entry is evicted to make
 * room, on the theory that whatever made it stop being useful (its TTL, or
 * this cache filling up) leaves the newest struggling sessions the ones
 * worth remembering.
 *
 * "Concurrent batches for the same session each start their own lookup and
 * their own timer" (a Farol finding on the round that added the timeout
 * itself) -- a party's whole SAMPLED audience can flush within the same
 * tick, and before this, N simultaneous callers for the same key meant N
 * database queries in flight (even though `resolveHlsSessionId`'s own cache
 * would eventually coalesce the QUERY, each caller still paid for its own
 * race and its own timer) and, on a timeout, N redundant writes to the
 * negative cache. `resolve` is now single-flight per key: the first caller
 * starts the one race, and every concurrent caller for the same key gets
 * the SAME promise and therefore the SAME outcome, together.
 *
 * THE LOSER OF A LOST RACE IS ABANDONED, NOT CANCELLED. There is no cheap
 * way to cancel a Postgres query from here (same trade-off `readiness.ts`'s
 * own probe race makes); an abandoned promise that eventually settles just
 * updates `resolveHlsSessionId`'s own cache for whoever asks next. What IS
 * cancelled is this module's own bookkeeping: the in-flight entry for a key
 * is deleted the moment its race settles (by timeout OR by the lookup
 * actually finishing), so nothing here retains a reference to it, and a
 * later call for the same key -- once its negative-cache window (if any) has
 * passed -- starts a genuinely fresh attempt rather than piling onto a
 * promise this module still thinks is "in flight".
 *
 * Keyed by the CALLER's choice of string, not by a channel/session pair
 * itself, so this stays a plain cache-and-timeout primitive with no HLS
 * knowledge of its own -- easy to drive with a fake lookup and fake timers
 * in a test that has no database at all.
 */
export type HlsSessionLookupOutcome =
  | { outcome: "resolved"; sessionId: string | null }
  | { outcome: "timeout" }
  | { outcome: "negatively-cached" };

export interface HlsSessionLookupGuard {
  resolve(
    key: string,
    lookup: () => Promise<string | null>,
    now?: number,
  ): Promise<HlsSessionLookupOutcome>;
  /** Test-only: forget every negative-cache entry and in-flight attempt. */
  reset(): void;
}

export function createHlsSessionLookupGuard(options: {
  timeoutMs: number;
  negativeCacheMs: number;
  /** Oldest entry evicted once the negative cache holds this many keys. */
  negativeCacheMaxSize?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): HlsSessionLookupGuard {
  // A `Map`'s iteration order is insertion order, and re-`.set()`ing an
  // EXISTING key does not move it -- exactly the FIFO "oldest evicted" this
  // needs, with no separate bookkeeping, because every key is set here
  // exactly once (a hit before expiry never reaches this map at all, and a
  // hit after expiry deletes the old entry first, so a "re-set" of a key
  // still live in the map never happens).
  const negativelyCachedUntil = new Map<string, number>();
  const negativeCacheMaxSize = options.negativeCacheMaxSize ?? 1_000;
  // Single-flight: concurrent callers for the same key share this promise
  // rather than each starting their own race. Entries are removed the
  // instant their race settles, never left around "just in case".
  const inFlight = new Map<string, Promise<HlsSessionLookupOutcome>>();
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  function negativelyCache(key: string, now: number): void {
    if (
      !negativelyCachedUntil.has(key) &&
      negativelyCachedUntil.size >= negativeCacheMaxSize
    ) {
      const oldestKey = negativelyCachedUntil.keys().next().value;
      if (oldestKey !== undefined) {
        negativelyCachedUntil.delete(oldestKey);
      }
    }
    negativelyCachedUntil.set(key, now + options.negativeCacheMs);
  }

  return {
    resolve(key, lookup, now = Date.now()) {
      const until = negativelyCachedUntil.get(key);
      if (until !== undefined) {
        if (until > now) {
          return Promise.resolve({ outcome: "negatively-cached" });
        }
        // Expired: this key gets a fresh attempt, same as one that was
        // never cached at all.
        negativelyCachedUntil.delete(key);
      }
      const existingAttempt = inFlight.get(key);
      if (existingAttempt) {
        return existingAttempt;
      }
      const attempt = (async (): Promise<HlsSessionLookupOutcome> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((resolveRace) => {
          timer = setTimeoutFn(() => resolveRace("timeout"), options.timeoutMs);
        });
        try {
          const raced = await Promise.race([
            lookup().then((sessionId) => ({ sessionId }) as const),
            timeout,
          ]);
          if (raced === "timeout") {
            negativelyCache(key, now);
            return { outcome: "timeout" };
          }
          return { outcome: "resolved", sessionId: raced.sessionId };
        } finally {
          if (timer !== undefined) {
            clearTimeoutFn(timer);
          }
          // Detach regardless of outcome: the next call for this key (once
          // any negative-cache window has passed) starts a genuinely fresh
          // attempt rather than finding a stale "in flight" entry this
          // module has no way to know is still meaningful.
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, attempt);
      return attempt;
    },
    reset() {
      negativelyCachedUntil.clear();
      inFlight.clear();
    },
  };
}
