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
/** `getRegistration()` normally answers at once; a hang here must not hold the whole update. */
export const REGISTRATION_TIMEOUT_MS = 5_000;
/** How long a worker that is active may take to start answering for THIS page. */
export const CONTROL_TIMEOUT_MS = 3_000;
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

/** What the worker that answers THIS page says about itself. */
export interface ControllerAnswer {
  /** False when no worker controls the page: a reload is then served by the network. */
  controlled: boolean;
  /**
   * The build id the controlling worker says it was made from (`sw-build` in
   * `vite.config.ts`), or null when it cannot say: a worker from before this
   * existed, or no answer in time.
   */
  build: string | null;
}

export interface ApplyUpdateDeps {
  getRegistration: () => Promise<RegistrationLike | undefined>;
  controllerBuild: () => Promise<ControllerAnswer>;
  deleteAllCaches: () => Promise<void>;
  reload: () => void;
  online: () => boolean;
  sleep: (ms: number) => Promise<void>;
  /** Resolves after `ms`; a separate seam from `sleep` so a test can make one fire and not the other. */
  timeout: (ms: number) => Promise<void>;
  now: () => number;
}

export type ApplyUpdateResult = "activated" | "purged" | "offline";

/**
 * Ask the worker that CONTROLS this page which build it belongs to. The
 * controller, not the registration's `active` worker: a worker can be `active`
 * a beat before `clients.claim()` makes it this tab's controller, and the reload
 * is answered by the controller.
 */
async function askControllerBuild(): Promise<ControllerAnswer> {
  try {
    const worker = navigator.serviceWorker?.controller;
    if (!worker) {
      return { controlled: false, build: null };
    }
    const build = await new Promise<string | null>((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 2_000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        const answer = (event.data as { build?: unknown } | null)?.build;
        resolve(typeof answer === "string" ? answer : null);
      };
      worker.postMessage({ type: "PQP_BUILD" }, [channel.port2]);
    });
    return { controlled: true, build };
  } catch {
    return { controlled: true, build: null };
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
    controllerBuild: askControllerBuild,
    deleteAllCaches: async () => {
      if (typeof caches === "undefined") {
        return;
      }
      const keys = await caches.keys();
      // Every deletion is waited for, successful or not: a reload that starts
      // while one is still pending can be served from the cache being deleted.
      const results = await Promise.allSettled(
        keys.map((key) => caches.delete(key)),
      );
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("a cache could not be deleted");
      }
    },
    reload: () => window.location.reload(),
    online: () => typeof navigator === "undefined" || navigator.onLine !== false,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeout: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/**
 * Bring the newest worker up. Resolves `ready` when nothing is installing or
 * waiting any more, `failed` on timeout, or when the update check itself failed
 * and there was no worker to bring up (nothing says the active one is current).
 */
async function activateNewestWorker(
  registration: RegistrationLike,
  deps: ApplyUpdateDeps,
): Promise<"ready" | "failed"> {
  const deadline = deps.now() + STEP_TIMEOUT_MS;
  let updateFailed = false;
  let sawNewWorker = false;
  // `update()` settles once the new worker has been fetched and handed to
  // `installing`, which is what the loop below needs to see. On a bad network
  // it can hang, so it is raced against the deadline rather than trusted.
  await Promise.race([
    registration.update().catch(() => {
      updateFailed = true;
    }),
    deps.timeout(STEP_TIMEOUT_MS),
  ]);
  while (deps.now() < deadline) {
    if (registration.waiting) {
      sawNewWorker = true;
      registration.waiting.postMessage?.({ type: "SKIP_WAITING" });
    } else if (registration.installing) {
      sawNewWorker = true;
    } else {
      return updateFailed && !sawNewWorker ? "failed" : "ready";
    }
    await deps.sleep(POLL_MS);
  }
  return "failed";
}

/**
 * Waits until the worker answering this page is the target build (or there is
 * none answering it). `clients.claim()` follows activation by a beat, so the
 * first answer can still be the old worker's.
 */
async function controllerReaches(
  target: string,
  deps: ApplyUpdateDeps,
): Promise<boolean> {
  const deadline = deps.now() + CONTROL_TIMEOUT_MS;
  for (;;) {
    const answer = await deps.controllerBuild();
    if (!answer.controlled || answer.build === target) {
      return true;
    }
    if (deps.now() >= deadline) {
      return false;
    }
    await deps.sleep(POLL_MS);
  }
}

/**
 * Makes the next load the new build and reloads into it. Resolves after calling
 * `reload` (in a browser the page is gone by then).
 *
 * `target` is the build the page is trying to reach (`/version.json`'s). With
 * it, "nothing is installing" is not taken on faith: the worker that controls
 * the page is asked which build it is, and anything but `target` is treated as a
 * worker that did not update, because that is what a stale `sw.js` at a CDN
 * looks like from here. The browser found nothing new, so there is nothing
 * installing, and a plain reload would be answered by the old precache with the
 * update "done". Without a target (the worker itself announced a waiting build)
 * there is nothing to compare to and the worker is trusted, unless the update
 * check failed with no new worker in sight.
 *
 * OFFLINE is the one case that never purges: with no network the caches are the
 * only copy of the app there is, and deleting them turns a stale page into no
 * page.
 */
export async function applyUpdate(
  target: string | null = null,
  deps: ApplyUpdateDeps = browserDeps(),
): Promise<ApplyUpdateResult> {
  let activated = false;
  try {
    const registration = await Promise.race([
      deps.getRegistration(),
      deps.timeout(REGISTRATION_TIMEOUT_MS).then(() => {
        throw new Error("the service worker registration did not answer");
      }),
    ]);
    if (!registration) {
      // No worker at all: the reload is already served by the network.
      activated = true;
    } else {
      activated = (await activateNewestWorker(registration, deps)) === "ready";
      if (activated && target) {
        activated = await controllerReaches(target, deps);
      }
    }
  } catch {
    activated = false;
  }
  if (activated) {
    deps.reload();
    return "activated";
  }
  if (!deps.online()) {
    deps.reload();
    return "offline";
  }
  try {
    await deps.deleteAllCaches();
  } catch {
    // Reload anyway: a failed purge is no worse than not having tried.
  }
  deps.reload();
  return "purged";
}
