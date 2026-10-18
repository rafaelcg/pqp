/**
 * The home page's chunk, loaded once and remembered.
 *
 * The page at "/" is its own lazy chunk, so an `/app` visitor never downloads
 * it (an eager import measured about 72 KB gz more in the entry). This module
 * is the one place that imports it, and it is small enough to be eager:
 *
 * - `loadHome()` starts the import, or returns the one already running. The
 *   boot calls it first thing on "/" and waits on it (with a ceiling) before
 *   the first render, so the route usually finds the module already here.
 * - `loadedHome()` is that module once it has arrived, or null. The route
 *   renders it directly when it is there, because `React.lazy` suspends on its
 *   first render even when the import has already resolved, and on the
 *   prerendered "/" that would paint the loading shell between the static
 *   first screen and the live one.
 * - A rejected import is forgotten before it rethrows, so the next call starts
 *   a fresh one. A remembered rejection would hand every later caller (the
 *   lazy route, the idle prefetch) the same dead promise, for example after a
 *   deploy deleted the old hashed chunk (CLAUDE.md pitfall 23).
 *
 * Nothing here may import the page itself, not even a type from its parts: a
 * static import would pull the page into the entry chunk.
 */

export type HomeModule = typeof import("./index");

export interface HomeLoader<T> {
  load(): Promise<T>;
  loaded(): T | null;
}

/** A memoized importer. The real one is below; tests pass a fake. */
export function createHomeLoader<T>(importer: () => Promise<T>): HomeLoader<T> {
  let pending: Promise<T> | null = null;
  let module: T | null = null;
  return {
    load() {
      if (module) return Promise.resolve(module);
      if (!pending) {
        pending = importer().then(
          (mod) => {
            module = mod;
            return mod;
          },
          (error: unknown) => {
            pending = null;
            throw error;
          },
        );
      }
      return pending;
    },
    loaded() {
      return module;
    },
  };
}

const home = createHomeLoader<HomeModule>(() => import("./index"));

export const loadHome = home.load;
export const loadedHome = home.loaded;

/** Longest the first render on "/" waits for the home chunk, in ms. */
export const HOME_CHUNK_CEILING_MS = 3000;

/**
 * Resolves on the first of `promise` settling or `ms` passing, and never
 * rejects. The boot waits on the home chunk through this, so a slow chunk
 * cannot hold the first render for longer than the ceiling and a failed one
 * renders at once (the route then takes the ordinary lazy path). It never
 * rejects because the boot waits on it inside a `Promise.all` whose other
 * members never reject either, and one rejection there would skip the render.
 */
export function withCeiling(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

/** How long the idle prefetch waits for a quiet moment at most, in ms. */
export const HOME_PREFETCH_IDLE_TIMEOUT_MS = 2000;

type IdleWindow = Pick<Window, "setTimeout" | "clearTimeout"> & {
  requestIdleCallback?: Window["requestIdleCallback"];
  cancelIdleCallback?: Window["cancelIdleCallback"];
  navigator: { connection?: { saveData?: boolean } };
};

/**
 * Fetches the home chunk when the browser is idle, from the other marketing
 * pages. Their nav logo is a router link to "/", so without this a click on it
 * would suspend on the chunk. Skipped under Save-Data, where a download the
 * visitor did not ask for is the wrong trade. Safari has no
 * `requestIdleCallback`, so it falls back to a timer. Returns a cancel.
 */
export function prefetchHomeWhenIdle(
  win: IdleWindow = window as unknown as IdleWindow,
  load: () => Promise<unknown> = loadHome,
): () => void {
  if (win.navigator.connection?.saveData) return () => {};
  const run = () => {
    void load().catch(() => {});
  };
  if (typeof win.requestIdleCallback === "function") {
    const id = win.requestIdleCallback(run, { timeout: HOME_PREFETCH_IDLE_TIMEOUT_MS });
    return () => win.cancelIdleCallback?.(id);
  }
  const id = win.setTimeout(run, HOME_PREFETCH_IDLE_TIMEOUT_MS);
  return () => win.clearTimeout(id);
}
