import {
  NO_FORCE,
  isForcedBuild,
  isStaleBuild,
  parseForceConfig,
  parseVersionManifest,
  type ForceConfig,
  type LatestBuild,
} from "@/lib/client-version";
import type { BuildIdentity } from "@/lib/build-info";
import { FRESH_BUILD, type BuildStaleness } from "@/lib/update-prompt-state";

/**
 * A page finding out, by itself, that it is out of date.
 *
 * WHY THIS IS NOT THE SERVICE WORKER'S JOB. The worker looks for a new build
 * when the page navigates (and once a day, if it is asked to do something).
 * A window that never navigates, which is what the desktop app and a pinned tab
 * are, is told nothing for as long as it lives: a Windows desktop app running a
 * build from before a deploy was found on 2026-09-30 with the new shell around
 * it and the old site inside. So the page asks, on three occasions: when it
 * starts, when it comes back into focus or view, and on a timer of about twelve
 * minutes while it is open. The question is one small request:
 * `/version.json`, written by the build, never cached.
 *
 * It asks the browser to look for a new worker at the same time, because
 * finding out the build is stale and having the new precache ready are two
 * halves of the same update and there is no reason for either to wait.
 *
 * The operator's side (`/api/client-update/config`) is only asked when the
 * build is ALREADY stale, which keeps an up-to-date client (nearly all of them)
 * from making any request to the API for this at all.
 */

/** Between two checks however often focus flickers. */
export const MIN_GAP_MS = 60_000;
/** The timer; jittered so a deploy's worth of tabs do not ask in the same second. */
export const CHECK_INTERVAL_MS = 12 * 60_000;
export const CHECK_JITTER_MS = 3 * 60_000;
/** After the page starts; long enough not to compete with the first paint. */
export const FIRST_CHECK_DELAY_MS = 4_000;

export interface VersionWatchDeps {
  running: BuildIdentity;
  fetchLatest: () => Promise<LatestBuild | null>;
  fetchForceConfig: () => Promise<ForceConfig>;
  /** Ask the browser to look for a new worker now. Never throws. */
  updateWorker: () => Promise<void>;
  publish: (next: BuildStaleness) => void;
  now?: () => number;
}

export interface VersionWatch {
  /** Check now, unless one ran less than `MIN_GAP_MS` ago (or `force`). */
  check: (options?: { force?: boolean }) => Promise<void>;
}

export function createVersionWatch(deps: VersionWatchDeps): VersionWatch {
  const now = deps.now ?? Date.now;
  let lastStartedAt = -Infinity;
  let inflight: Promise<void> | null = null;
  // When this page first saw a newer build, for a build id that carries no
  // `builtAt`. Kept per target so a second deploy starts its own clock.
  let firstSeen: { build: string; at: number } | null = null;

  async function run(): Promise<void> {
    void deps.updateWorker();
    const latest = await deps.fetchLatest();
    if (!isStaleBuild(deps.running, latest) || !latest) {
      // Unknown (the read failed, or answered nothing usable) keeps whatever
      // was published: "I could not ask" is not "the build is current".
      if (latest) {
        firstSeen = null;
        deps.publish(FRESH_BUILD);
      }
      return;
    }
    if (firstSeen?.build !== latest.build) {
      firstSeen = { build: latest.build, at: now() };
    }
    const config = await deps.fetchForceConfig().catch(() => NO_FORCE);
    deps.publish({
      stale: true,
      forced: isForcedBuild(deps.running, config),
      latestBuild: latest.build,
      // The deployed build's age is how long this page has been behind, even
      // if it only just learned of it (a laptop that slept for two days).
      since: latest.builtAt ?? firstSeen.at,
    });
  }

  return {
    check(options) {
      if (inflight) {
        return inflight;
      }
      if (!options?.force && now() - lastStartedAt < MIN_GAP_MS) {
        return Promise.resolve();
      }
      lastStartedAt = now();
      inflight = run()
        .catch(() => {})
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}

// --------------------------------------------------------------- the browser

/** `/version.json`, past every cache between here and the deploy. */
export async function fetchLatestBuild(
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<LatestBuild | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    // The query string defeats a CDN that keys on the URL; `no-store` defeats
    // the browser's own cache; and the file is served `no-cache` besides. Three
    // layers because the one thing this request must never be is stale.
    const response = await fetchImpl(`/version.json?t=${now}`, {
      cache: "no-store",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return null;
    }
    return parseVersionManifest(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function updateRegisteredWorker(): Promise<void> {
  try {
    if (!("serviceWorker" in navigator)) {
      return;
    }
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();
  } catch {
    // Offline, or the script could not be fetched: nothing to do about it here.
  }
}

/**
 * Wire the watch to the page: a first check shortly after start, then focus,
 * visibility and the jittered timer. Returns the teardown.
 *
 * `fetchForceConfig` is injected because the API client needs a signed-in
 * session and this module must not know about that.
 */
export function startVersionWatch(options: {
  running: BuildIdentity;
  fetchForceConfig: () => Promise<ForceConfig>;
  publish: (next: BuildStaleness) => void;
}): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  const watch = createVersionWatch({
    running: options.running,
    fetchLatest: () => fetchLatestBuild(),
    fetchForceConfig: options.fetchForceConfig,
    updateWorker: updateRegisteredWorker,
    publish: options.publish,
  });

  let timer: number | undefined;
  const schedule = () => {
    const delay = CHECK_INTERVAL_MS + Math.random() * CHECK_JITTER_MS;
    timer = window.setTimeout(() => {
      // A hidden tab skips its turn; the visibility handler catches it up.
      if (document.visibilityState === "visible") {
        void watch.check();
      }
      schedule();
    }, delay);
  };

  const first = window.setTimeout(
    () => void watch.check({ force: true }),
    FIRST_CHECK_DELAY_MS,
  );
  schedule();

  const onFocus = () => void watch.check();
  const onVisible = () => {
    if (document.visibilityState === "visible") {
      void watch.check();
    }
  };
  // A new worker taking control (it does so as soon as it is installed) is the
  // browser telling the page a build has arrived: look at once.
  const onController = () => void watch.check({ force: true });
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onFocus);
  navigator.serviceWorker?.addEventListener("controllerchange", onController);

  return () => {
    window.clearTimeout(first);
    window.clearTimeout(timer);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onFocus);
    navigator.serviceWorker?.removeEventListener(
      "controllerchange",
      onController,
    );
  };
}

export { parseForceConfig };
