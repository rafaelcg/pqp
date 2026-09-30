/**
 * Take the new build NOW: make sure the page that loads next is the new one.
 *
 * `location.reload()` alone is not enough, and that is the whole reason this
 * file exists. While a service worker controls the page, the reload is answered
 * from that worker's precache, and the precache belongs to the OLD build until
 * the new worker takes over. Reproduced with real builds in
 * `e2e/stale-bundle/`: with a new worker waiting, three reloads in a row came
 * back on the previous bundle. So this first makes the new worker the active one
 * and only then reloads.
 *
 * The steps, each one a fallback for the one above failing:
 *
 *  1. Ask the browser to look for a new worker now (`update()`), so this does
 *     not depend on the page having navigated lately.
 *  2. Let it finish installing; poke a waiting one with `SKIP_WAITING` (a build
 *     from before `skipWaiting` was switched on still needs the message).
 *  3. Reload. The precache is the new build's.
 *
 * If any of that fails or takes longer than `STEP_TIMEOUT_MS` (no registration,
 * an install that cannot finish because a deploy is half propagated, a worker
 * wedged for any reason) the precache is DELETED and the page reloads anyway.
 * With the precache gone the old worker has nothing to answer a navigation
 * with and goes to the network, so the page that loads is the deployed one. No
 * state of this can strand somebody, which is the property that matters.
 *
 * The worker is never UNREGISTERED: a push subscription belongs to its
 * registration, it can only be re-created from a user gesture, and an update is
 * not a reason to silently turn somebody's notifications off.
 */

export const STEP_TIMEOUT_MS = 15_000;
const POLL_MS = 200;

interface WorkerLike {
  state?: string;
  postMessage?: (message: unknown) => void;
}

interface RegistrationLike {
  update: () => Promise<unknown>;
  installing: WorkerLike | null;
  waiting: WorkerLike | null;
}

export interface ApplyUpdateDeps {
  getRegistration: () => Promise<RegistrationLike | undefined>;
  /**
   * The build id the ACTIVE worker says it was made from (`sw-build` in
   * `vite.config.ts`), or null when it cannot say: a worker from before this
   * existed, none at all, or no answer in time.
   */
  workerBuild: () => Promise<string | null>;
  deleteAllCaches: () => Promise<void>;
  reload: () => void;
  sleep: (ms: number) => Promise<void>;
  /** Resolves after `ms`; a separate seam from `sleep` so a test can make one fire and not the other. */
  timeout: (ms: number) => Promise<void>;
  now: () => number;
}

export type ApplyUpdateResult = "activated" | "purged";

/** Ask the worker that is answering this page which build it belongs to. */
async function askActiveWorkerBuild(): Promise<string | null> {
  try {
    // The registration's ACTIVE worker, not `controller`: the moment a new
    // worker activates it is `active`, while `controller` follows a beat later.
    const registration = await navigator.serviceWorker?.getRegistration();
    const worker = registration?.active ?? navigator.serviceWorker?.controller;
    if (!worker) {
      return null;
    }
    return await new Promise<string | null>((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 2_000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        const build = (event.data as { build?: unknown } | null)?.build;
        resolve(typeof build === "string" ? build : null);
      };
      worker.postMessage({ type: "PQP_BUILD" }, [channel.port2]);
    });
  } catch {
    return null;
  }
}

function browserDeps(): ApplyUpdateDeps {
  return {
    getRegistration: async () => {
      if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
        return undefined;
      }
      return (await navigator.serviceWorker.getRegistration()) as
        | RegistrationLike
        | undefined;
    },
    workerBuild: askActiveWorkerBuild,
    deleteAllCaches: async () => {
      if (typeof caches === "undefined") {
        return;
      }
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    },
    reload: () => window.location.reload(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeout: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/**
 * Bring the newest worker up. Resolves true when nothing is installing or
 * waiting any more (so the active worker is the newest one), false on timeout.
 */
async function activateNewestWorker(
  registration: RegistrationLike,
  deps: ApplyUpdateDeps,
): Promise<boolean> {
  const deadline = deps.now() + STEP_TIMEOUT_MS;
  // `update()` settles once the new worker has been fetched and handed to
  // `installing`, which is what the loop below needs to see. On a bad network
  // it can hang, so it is raced against the deadline rather than trusted.
  await Promise.race([
    registration.update().catch(() => {}),
    deps.timeout(STEP_TIMEOUT_MS),
  ]);
  while (deps.now() < deadline) {
    if (registration.waiting) {
      registration.waiting.postMessage?.({ type: "SKIP_WAITING" });
    } else if (!registration.installing) {
      return true;
    }
    await deps.sleep(POLL_MS);
  }
  return false;
}

/**
 * Makes the next load the new build and reloads into it. Resolves after calling
 * `reload` (in a browser the page is gone by then).
 *
 * `target` is the build the page is trying to reach (`/version.json`'s). With
 * it, "nothing is installing" is not taken on faith: the active worker is asked
 * which build it is, and anything but `target` is treated as a worker that did
 * not update, because that is what a stale `sw.js` at a CDN looks like from
 * here. The browser found nothing new, so there is nothing installing, and a
 * plain reload would be answered by the old precache with the update "done".
 * Without a target (the worker itself announced a waiting build) there is
 * nothing to compare to and the worker is trusted.
 */
export async function applyUpdate(
  target: string | null = null,
  deps: ApplyUpdateDeps = browserDeps(),
): Promise<ApplyUpdateResult> {
  let activated = false;
  try {
    const registration = await deps.getRegistration();
    // No worker at all: the reload is already served by the network.
    activated = registration
      ? await activateNewestWorker(registration, deps)
      : true;
    if (activated && registration && target) {
      activated = (await deps.workerBuild()) === target;
    }
  } catch {
    activated = false;
  }
  if (activated) {
    deps.reload();
    return "activated";
  }
  try {
    await deps.deleteAllCaches();
  } catch {
    // Reload anyway: a failed purge is no worse than not having tried.
  }
  deps.reload();
  return "purged";
}
