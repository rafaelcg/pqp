/**
 * When the app may take over from the prerendered landing page.
 *
 * `index.html` carries the landing page's first screen as plain HTML (see
 * `prerender-hero.ts`), so on the home route the visitor already has something
 * to read, and rendering React straight away would only compete with the
 * things that are still arriving (the stylesheet, the hero picture, the
 * product screenshot) for the same slow link and the same main thread. So on
 * that route, and only on that route, the first React render waits for the page
 * to finish loading and the browser to be idle, or for the visitor's first
 * touch, click, key press or wheel turn, or for a hard ceiling, whichever comes
 * first.
 *
 * Every other route renders at once, exactly as before: there is nothing on
 * screen to protect, and `/app` in particular must not wait for anything.
 *
 * The ceiling matters more than it looks. `load` waits for every subresource, so
 * one stalled request would otherwise hold the page on its static copy for as
 * long as the request hangs.
 *
 * This gate is not the whole wait. Once it opens, `main.tsx` also waits for the
 * home page's own chunk, with no ceiling, because rendering without it would
 * swap the static copy (plain links that already work) for the loading shell.
 */

/** Longest this gate holds the first render, in ms. */
export const HYDRATE_CEILING_MS = 4000;

/** Longest wait, after `load`, for a quiet moment. */
export const HYDRATE_IDLE_TIMEOUT_MS = 1500;

/**
 * What counts as the visitor starting to use the page. "wheel" is there because
 * on a computer the first thing a visitor does is often scroll with the mouse,
 * and the live page is what animates the scroll; `defer-entry.ts` starts the
 * bundle on the same list.
 */
export const INTERACTIONS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

/** Whether this document is the home page with its prerendered first screen. */
export function hasPrerenderedHero(doc: Document = document): boolean {
  return (
    doc.documentElement.getAttribute("data-route") === "home" &&
    doc.getElementById("pre-hero") !== null
  );
}

/**
 * Whether `img` is drawn inside the first viewport. A picture in a hidden
 * language block has an empty box, and one below the fold (the hero frame on a
 * short phone screen) is not on screen yet, so neither is waited for.
 */
export function isInFirstViewport(img: Element, width: number, height: number): boolean {
  const r = img.getBoundingClientRect();
  return (
    r.width > 0 &&
    r.height > 0 &&
    r.bottom > 0 &&
    r.right > 0 &&
    r.top < height &&
    r.left < width
  );
}

/**
 * Resolves once the prerendered block's pictures in the first viewport are
 * decoded and a couple of frames have been drawn, or after `timeoutMs`,
 * whichever is first.
 *
 * Replacing the static block before its pictures have painted would make the
 * live page's copy of them the largest contentful paint (a new element, found
 * by script, so its timing depends on the bundle) instead of the one already on
 * screen, and on a fast connection would show a frame with the picture missing.
 * A picture off screen cannot be either, and waiting for one would only hold
 * the page until the ceiling. Never rejects.
 */
export async function whenPrerenderPainted(
  doc: Document = document,
  timeoutMs = 1200,
): Promise<void> {
  try {
    const view = doc.defaultView;
    const width = view?.innerWidth ?? 0;
    const height = view?.innerHeight ?? 0;
    const images = Array.from(
      doc.querySelectorAll<HTMLImageElement>("#pre-hero img"),
    ).filter((img) => isInFirstViewport(img, width, height));
    const decoded = Promise.all(
      images.map((img) =>
        typeof img.decode === "function" ? img.decode().catch(() => {}) : undefined,
      ),
    );
    await Promise.race([
      decoded,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  } catch {
    // A missing API is not a reason to hold the page.
  }
}

/**
 * Calls `start` exactly once, when the page is ready to be taken over.
 * Returns a function that cancels the wait (for tests).
 */
export function whenReadyToRender(
  start: () => void,
  win: Window = window,
): () => void {
  let done = false;
  const cleanups: Array<() => void> = [];

  const go = () => {
    if (done) {
      return;
    }
    done = true;
    cleanup();
    start();
  };

  const cleanup = () => {
    for (const fn of cleanups.splice(0)) {
      fn();
    }
  };

  const afterLoad = () => {
    if (typeof win.requestIdleCallback === "function") {
      const id = win.requestIdleCallback(go, {
        timeout: HYDRATE_IDLE_TIMEOUT_MS,
      });
      cleanups.push(() => win.cancelIdleCallback?.(id));
    } else {
      const id = win.setTimeout(go, 200);
      cleanups.push(() => win.clearTimeout(id));
    }
  };

  if (win.document.readyState === "complete") {
    afterLoad();
  } else {
    win.addEventListener("load", afterLoad, { once: true });
    cleanups.push(() => win.removeEventListener("load", afterLoad));
  }

  for (const type of INTERACTIONS) {
    win.addEventListener(type, go, { once: true, passive: true, capture: true });
    cleanups.push(() =>
      win.removeEventListener(type, go, { capture: true } as EventListenerOptions),
    );
  }

  const ceiling = win.setTimeout(go, HYDRATE_CEILING_MS);
  cleanups.push(() => win.clearTimeout(ceiling));

  return () => {
    done = true;
    cleanup();
  };
}
