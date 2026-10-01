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
 * touch, click or key press, or for a hard ceiling, whichever comes first.
 *
 * Every other route renders at once, exactly as before: there is nothing on
 * screen to protect, and `/app` in particular must not wait for anything.
 *
 * The ceiling matters more than it looks. `load` waits for every subresource, so
 * one stalled request would otherwise hold the page on its static copy for as
 * long as the request hangs.
 */

/** Longest the static copy is allowed to stand alone, in ms. */
export const HYDRATE_CEILING_MS = 4000;

/** Longest wait, after `load`, for a quiet moment. */
export const HYDRATE_IDLE_TIMEOUT_MS = 1500;

const INTERACTIONS = ["pointerdown", "keydown", "touchstart"] as const;

/** Whether this document is the home page with its prerendered first screen. */
export function hasPrerenderedHero(doc: Document = document): boolean {
  return (
    doc.documentElement.getAttribute("data-route") === "home" &&
    doc.getElementById("pre-hero") !== null
  );
}

/**
 * Resolves once the prerendered block's visible pictures are decoded and a
 * couple of frames have been drawn, or after `timeoutMs`, whichever is first.
 *
 * Replacing the static block before its pictures have painted would make the
 * live page's copy of them the largest contentful paint (a new element, found
 * by script, so its timing depends on the bundle) instead of the one already on
 * screen, and on a fast connection would show a frame with the picture missing.
 * Never rejects.
 */
export async function whenPrerenderPainted(
  doc: Document = document,
  timeoutMs = 1200,
): Promise<void> {
  try {
    const images = Array.from(
      doc.querySelectorAll<HTMLImageElement>("#pre-hero img"),
    ).filter((img) => img.offsetParent !== null);
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
