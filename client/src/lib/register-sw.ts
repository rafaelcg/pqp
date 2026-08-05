/**
 * Service worker registration, isolated behind one module.
 *
 * `virtual:pwa-register` only exists once vite-plugin-pwa has run, so the
 * import is dynamic — that keeps this file importable from tests and from a
 * plain `tsc` run, neither of which knows about the virtual module.
 */

export interface ServiceWorkerControls {
  /** Activate the waiting worker and reload. */
  update: () => Promise<void>;
  dispose: () => void;
}

type RegisterSW = (options: {
  onNeedRefresh?: () => void;
  onRegisterError?: (error: unknown) => void;
}) => (reloadPage?: boolean) => Promise<void>;

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

  void (async () => {
    // Nothing to register when the browser has no support, and nothing is
    // emitted in dev unless devOptions.enabled is flipped on.
    if (!("serviceWorker" in navigator)) {
      return;
    }
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
      });
    } catch {
      // The virtual module is absent in dev builds — expected, not an error.
    }
  })();

  return {
    async update() {
      await updateSW?.(true);
    },
    dispose() {
      disposed = true;
    },
  };
}
