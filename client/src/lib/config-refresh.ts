/**
 * Re-asking the server's config answers while the page stays open.
 *
 * Several answers are cached for the page's lifetime (`/api/live-hls/config`
 * per server, the watch party waitlist state), which was right while they
 * could only change with a deploy. They are runtime flags now
 * (`server/src/lib/flags.ts`, `docs/FEATURE_FLAGS.md`): the operator flips one
 * on the dashboard and the server answers differently on the very next read.
 * This is what makes "the very next read" happen without a reload: when the
 * tab comes back into focus, and every few minutes while it is visible, each
 * registered store re-asks for the answers it already holds and swaps in any
 * that changed.
 *
 * Bounded on purpose, because every open tab runs it: at most one pass per
 * `MIN_GAP_MS` however often focus flickers, the timer skips hidden tabs, and
 * a store only re-asks for keys it already has (usually the one open server).
 * A failed re-ask keeps the answer it had: stale beats blank.
 */

export const CONFIG_REFRESH_MIN_GAP_MS = 2 * 60_000;
export const CONFIG_REFRESH_INTERVAL_MS = 10 * 60_000;

type Refresher = () => void;

const refreshers = new Set<Refresher>();
let lastRunAt = 0;

/** A store that can re-ask for what it holds. Returns the unsubscribe. */
export function onConfigRefresh(refresher: Refresher): () => void {
  refreshers.add(refresher);
  return () => {
    refreshers.delete(refresher);
  };
}

/**
 * Run every refresher, unless a pass ran less than `MIN_GAP_MS` ago. Returns
 * whether it ran. `force` skips the gap (tests, and nothing else today).
 */
export function requestConfigRefresh(
  { now = Date.now(), force = false }: { now?: number; force?: boolean } = {},
): boolean {
  if (!force && now - lastRunAt < CONFIG_REFRESH_MIN_GAP_MS) {
    return false;
  }
  lastRunAt = now;
  for (const refresher of refreshers) {
    try {
      refresher();
    } catch {
      // One store failing must not stop the others.
    }
  }
  return true;
}

/**
 * Focus, becoming visible again, and a slow timer while visible. Returns the
 * teardown. Safe to call once per signed-in app mount.
 */
export function startConfigRefresh(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  // The page just loaded every answer it holds: the first pass is a gap away.
  lastRunAt = Date.now();
  const onFocus = () => {
    requestConfigRefresh();
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      requestConfigRefresh();
    }
  };
  const timer = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      requestConfigRefresh();
    }
  }, CONFIG_REFRESH_INTERVAL_MS);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** Test seam. */
export function resetConfigRefreshForTests(): void {
  refreshers.clear();
  lastRunAt = 0;
}
