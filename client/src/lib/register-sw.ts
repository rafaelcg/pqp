/**
 * Service worker registration, isolated behind one module.
 *
 * `virtual:pwa-register` only exists once vite-plugin-pwa has run, so the
 * import is dynamic — that keeps this file importable from tests and from a
 * plain `tsc` run, neither of which knows about the virtual module.
 */

import { reportFaroEvent } from "./faro";

export interface ServiceWorkerControls {
  /** Activate the waiting worker and reload. */
  update: () => Promise<void>;
  dispose: () => void;
}

type RegisterSW = (options: {
  onNeedRefresh?: () => void;
  onRegisterError?: (error: unknown) => void;
  onRegisteredSW?: (
    swUrl: string,
    registration: ServiceWorkerRegistration | undefined,
  ) => void;
}) => (reloadPage?: boolean) => Promise<void>;

/**
 * Calls `onFailed` when a worker of this registration fails to install: it
 * goes `redundant` without ever reaching `installed`. A worker that is
 * replaced after it installed also ends `redundant`, and is not a failure.
 *
 * `onRegisterError` never sees this: registration succeeds, and the install
 * fails afterwards (a precache entry that is not 200, for example). From
 * 2026-09-30 to 2026-10-10 every install failed that way, and nothing on the
 * page noticed (`docs/PWA.md` §"A precache entry that 404s").
 */
export function watchInstallFailures(
  registration: ServiceWorkerRegistration,
  onFailed: () => void,
): void {
  const watch = (worker: ServiceWorker | null) => {
    if (!worker) {
      return;
    }
    let installed = false;
    worker.addEventListener("statechange", () => {
      if (worker.state === "redundant") {
        if (!installed) {
          onFailed();
        }
      } else if (worker.state !== "installing" && worker.state !== "parsed") {
        installed = true;
      }
    });
  };
  watch(registration.installing);
  registration.addEventListener("updatefound", () => watch(registration.installing));
}

/** Longest a first-time visitor to the marketing home page goes unregistered. */
export const HOME_REGISTER_DELAY_MS = 20_000;

const HOME_INTERACTIONS = ["pointerdown", "keydown", "touchstart"] as const;

/**
 * Resolves when it is worth installing the worker.
 *
 * On every route but the marketing home page that is at once, exactly as it
 * always was. On the home page, for somebody with no worker installed yet, it
 * is deferred: installing this worker precaches the whole shell (about 6 MB of
 * script, including the chat client and the media libraries), and a visitor who
 * only reads the landing page and leaves would download all of it for nothing,
 * on a phone, in the background, in front of the page they came to see. So the
 * worker waits for a sign the visit is going somewhere (a touch, a click, a key
 * press) or for `HOME_REGISTER_DELAY_MS` of somebody staying. Whoever already
 * has a worker keeps registering immediately, because that is what checks for a
 * new build.
 *
 * Returns a function that abandons the wait.
 */
function whenWorthRegistering(go: () => void): () => void {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path !== "/") {
    go();
    return () => {};
  }
  let settled = false;
  const cleanups: Array<() => void> = [];
  const fire = () => {
    if (settled) return;
    settled = true;
    for (const fn of cleanups.splice(0)) fn();
    go();
  };
  void navigator.serviceWorker
    .getRegistration()
    .then((existing) => {
      if (settled) return;
      if (existing) {
        fire();
        return;
      }
      for (const type of HOME_INTERACTIONS) {
        window.addEventListener(type, fire, { once: true, passive: true, capture: true });
        cleanups.push(() =>
          window.removeEventListener(type, fire, { capture: true } as EventListenerOptions),
        );
      }
      const timer = window.setTimeout(fire, HOME_REGISTER_DELAY_MS);
      cleanups.push(() => window.clearTimeout(timer));
    })
    .catch(fire);
  return () => {
    settled = true;
    for (const fn of cleanups.splice(0)) fn();
  };
}

/**
 * Registers the worker and calls `onNeedRefresh` when a new build is waiting.
 *
 * Returns synchronously with controls whose `update` resolves once the real
 * registration has loaded — callers wire a button to it without caring that the
 * module underneath arrived asynchronously.
 */
export function registerServiceWorker(
  onNeedRefresh: () => void,
): ServiceWorkerControls {
  let updateSW: ((reloadPage?: boolean) => Promise<void>) | null = null;
  let disposed = false;
  let abandonWait: (() => void) | null = null;

  const register = () => {
    void (async () => {
      try {
        const module = (await import("virtual:pwa-register")) as {
          registerSW: RegisterSW;
        };
        if (disposed) {
          return;
        }
        updateSW = module.registerSW({
          onNeedRefresh,
          onRegisterError: (error) => {
            console.warn("[pwa] service worker registration failed", error);
          },
          onRegisteredSW: (_url, registration) => {
            if (registration) {
              watchInstallFailures(registration, () => {
                console.warn("[pwa] service worker install failed");
                reportFaroEvent("pwa_sw_install_failed");
              });
            }
          },
        });
      } catch {
        // The virtual module is absent in dev builds — expected, not an error.
      }
    })();
  };

  // Nothing to register when the browser has no support, and nothing is
  // emitted in dev unless devOptions.enabled is flipped on.
  if ("serviceWorker" in navigator) {
    abandonWait = whenWorthRegistering(register);
  }

  return {
    async update() {
      await updateSW?.(true);
    },
    dispose() {
      disposed = true;
      abandonWait?.();
    },
  };
}
