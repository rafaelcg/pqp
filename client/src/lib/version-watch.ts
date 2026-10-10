import {
  isCriticalBuild,
  isForcedBuild,
  isStaleBuild,
  parseVersionManifest,
  type ForceConfig,
  type LatestBuild,
} from "@/lib/client-version";
import { DEV_BUILD_ID, type BuildIdentity } from "@/lib/build-info";
import { FRESH_BUILD, type BuildStaleness } from "@/lib/update-prompt-state";

/**
 * A page finding out, by itself, that it is out of date.
 *
 * WHY THIS IS NOT THE SERVICE WORKER'S JOB. The worker looks for a new build
 * when the page navigates (and once a day, if it is asked to do something).
 * A window that never navigates, which is what the desktop app and a pinned tab
 * are, is told nothing for as long as it lives: a Windows desktop app running a
 * build from before a deploy was found on 2026-09-30 with the new shell around
 * it and the old site inside. So the page asks, on four occasions: when it
 * starts, when it comes back into focus or view, when the realtime socket
 * (re)connects (`requestVersionCheck`, called from `realtime.ts`; a reconnect
 * after an API deploy is the moment a new build is most likely), and on a timer
 * of about ten minutes while it is open, hidden or not. The question is one
 * small request: `/version.json`, written by the build, never cached.
 *
 * WHY `/version.json` AND NOT THE API. The web bundle and the API deploy apart
 * (a client-only change never restarts the API), so the API's own version says
 * nothing about which bundle is current. `/version.json` is written by the same
 * build that wrote the bundle and lands in the same atomic Pages deploy.
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
/** The timer (8 to 12 minutes); jittered so a deploy's worth of tabs do not ask in the same second. */
export const CHECK_INTERVAL_MS = 8 * 60_000;
export const CHECK_JITTER_MS = 4 * 60_000;
/** After the page starts; long enough not to compete with the first paint. */
export const FIRST_CHECK_DELAY_MS = 4_000;

export interface VersionWatchDeps {
  running: BuildIdentity;
  fetchLatest: () => Promise<LatestBuild | null>;
  /**
   * The operator's answer, or null when it could not be had (offline, signed
   * out, an older API, a timeout). Null is NOT "no force": see `run`.
   */
  fetchForceConfig: () => Promise<ForceConfig | null>;
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
  /** What this watch last published, so a failed lookup does not undo it. */
  let lastPublished: BuildStaleness | null = null;

  function publish(next: BuildStaleness): void {
    lastPublished = next;
    deps.publish(next);
  }

  async function run(): Promise<void> {
    void deps.updateWorker();
    const latest = await deps.fetchLatest();
    if (!isStaleBuild(deps.running, latest) || !latest) {
      // Unknown (the read failed, or answered nothing usable) keeps whatever
      // was published: "I could not ask" is not "the build is current".
      if (latest) {
        firstSeen = null;
        publish(FRESH_BUILD);
      }
      return;
    }
    if (firstSeen?.build !== latest.build) {
      firstSeen = { build: latest.build, at: now() };
    }
    const config = await deps.fetchForceConfig().catch(() => null);
    // A lookup that FAILED must not undo a force that was already known for this
    // very build. Found in the e2e: the version read succeeded, the network went
    // away before the force lookup, the failure read as "no force", and the
    // blocking screen turned into an automatic reload. Only an answer changes
    // the answer; the operator turning it off is an answer.
    const known = lastPublished?.latestBuild === latest.build ? lastPublished : null;
    const forced = config
      ? isForcedBuild(deps.running, config)
      : Boolean(known?.forced);
    const critical = config
      ? isCriticalBuild(deps.running, config)
      : Boolean(known?.critical);
    publish({
      stale: true,
      forced,
      critical,
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
/** The page's live watch, for `requestVersionCheck`. Null until started. */
let activeWatch: VersionWatch | null = null;

/**
 * Ask now (within `MIN_GAP_MS`), from outside the watch: the realtime socket
 * calls it on every connect and reconnect. A no-op before the watch starts, in
 * a dev build, and in tests that never start one.
 */
export function requestVersionCheck(): void {
  void activeWatch?.check();
}

export function startVersionWatch(options: {
  running: BuildIdentity;
  fetchForceConfig: () => Promise<ForceConfig | null>;
  publish: (next: BuildStaleness) => void;
}): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  // A dev build compares to nothing, so asking would only be noise (and a 404
  // in the console under `vite dev`, which has no `/version.json`).
  if (options.running.build === DEV_BUILD_ID) {
    return () => {};
  }
  const watch = createVersionWatch({
    running: options.running,
    fetchLatest: () => fetchLatestBuild(),
    fetchForceConfig: options.fetchForceConfig,
    // A hidden tab reads the version file (a tiny static file) but leaves the
    // worker alone: the worker checks for itself on the page's fetches
    // (`sw-build-script.ts`), and a hundred background tabs each asking for
    // `sw.js` every ten minutes would be a hundred update jobs for one answer.
    // A stale hidden tab reloads through `applyUpdate`, which updates first.
    updateWorker: () =>
      document.visibilityState === "hidden"
        ? Promise.resolve()
        : updateRegisteredWorker(),
    publish: options.publish,
  });
  activeWatch = watch;

  let timer: number | undefined;
  const schedule = () => {
    const delay = CHECK_INTERVAL_MS + Math.random() * CHECK_JITTER_MS;
    timer = window.setTimeout(() => {
      // Hidden tabs ask too. A hidden tab is the SAFEST place to reload
      // (`update-policy.ts`), and one that skipped its turn only learned it was
      // stale the moment somebody looked at it again, which is the worst moment.
      void watch.check();
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
    if (activeWatch === watch) {
      activeWatch = null;
    }
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

