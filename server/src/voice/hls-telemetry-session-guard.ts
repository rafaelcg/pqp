/**
 * Bounds `resolveHlsSessionId`'s database lookup on the telemetry ingest
 * path (BROADCAST_PIPELINE B0.6) and stops a struggling lookup from being
 * retried on every flush. Two Farol findings, 2026-09-14, on the SAME call:
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
 * the database again.
 *
 * THE LOSER OF A LOST RACE IS ABANDONED, NOT CANCELLED. There is no cheap
 * way to cancel a Postgres query from here (same trade-off `readiness.ts`'s
 * own probe race makes); an abandoned promise that eventually settles just
 * updates `resolveHlsSessionId`'s own cache for whoever asks next, which is
 * strictly better than leaking it silently.
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
  /** Test-only: forget every negative-cache entry. */
  reset(): void;
}

export function createHlsSessionLookupGuard(options: {
  timeoutMs: number;
  negativeCacheMs: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): HlsSessionLookupGuard {
  const negativelyCachedUntil = new Map<string, number>();
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  return {
    async resolve(key, lookup, now = Date.now()) {
      const until = negativelyCachedUntil.get(key);
      if (until !== undefined) {
        if (until > now) {
          return { outcome: "negatively-cached" };
        }
        // Expired: this key gets a fresh attempt, same as one that was
        // never cached at all.
        negativelyCachedUntil.delete(key);
      }
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
          negativelyCachedUntil.set(key, now + options.negativeCacheMs);
          return { outcome: "timeout" };
        }
        return { outcome: "resolved", sessionId: raced.sessionId };
      } finally {
        if (timer !== undefined) {
          clearTimeoutFn(timer);
        }
      }
    },
    reset() {
      negativelyCachedUntil.clear();
    },
  };
}
