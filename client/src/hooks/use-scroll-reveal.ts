import { useLayoutEffect, type RefObject } from "react";

/**
 * Scroll reveals for a marketing page, with the end state as the default DOM.
 *
 * THE CONTRACT. Nothing is hidden by markup. An element marked `data-reveal`
 * carries ordinary CSS animations (`vem-rise` and friends in `index.css`) that
 * run on load and finish visible. This hook only adds `data-reveal-root` to the
 * page, and one CSS rule pauses every animation inside a `data-reveal` that has
 * not been given `data-shown` yet. Every one of them has a delay and
 * `fill-mode: backwards`, and an animation paused inside its delay holds its
 * first frame, so the element waits, then plays when it scrolls in.
 *
 * So the failure modes all land on "visible": no JavaScript, no
 * IntersectionObserver, a crawler, a reader who asked for less motion (the CSS
 * also turns the animations off outright). Content never depends on an
 * observer firing.
 *
 * Crawlers are skipped by user agent rather than trusted to scroll: Googlebot
 * renders with a tall viewport and never scrolls, and a preview renderer takes
 * one screenshot. Either would otherwise see sections still waiting. Skipped
 * means no animation at all (`data-reveal-off`), not only no waiting.
 */

const CRAWLER =
  /bot|crawl|spider|slurp|lighthouse|headless|facebookexternalhit|whatsapp|embedly|preview|prerender/i;

export function shouldRunReveals(env: {
  userAgent: string;
  reducedMotion: boolean;
  hasObserver: boolean;
}): boolean {
  if (!env.hasObserver || env.reducedMotion) return false;
  return !CRAWLER.test(env.userAgent);
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function useScrollReveal(rootRef: RefObject<HTMLElement | null>): void {
  // Layout effect: the pause has to be in place before the first paint, or
  // everything below the fold would flash its end state and then rewind.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (
      !shouldRunReveals({
        userAgent: navigator.userAgent,
        reducedMotion: prefersReducedMotion(),
        hasObserver: typeof IntersectionObserver === "function",
      })
    ) {
      // Not even the entrance: a crawler's one screenshot, taken at an
      // arbitrary moment, gets the finished page (`[data-reveal-off]` in
      // index.css removes every animation under the root).
      root.setAttribute("data-reveal-off", "");
      return () => root.removeAttribute("data-reveal-off");
    }
    const reveal = (
      entries: IntersectionObserverEntry[],
      observer: IntersectionObserver,
    ) => {
      for (const entry of entries) {
        // Above the viewport counts as seen: a jump to `#importar` should
        // not leave the hero waiting to replay when the reader scrolls back.
        if (entry.isIntersecting || entry.boundingClientRect.bottom < 0) {
          entry.target.setAttribute("data-shown", "");
          observer.unobserve(entry.target);
        }
      }
    };
    // Two triggers. Most blocks start as their top edge clears the bottom of
    // the screen. `data-reveal="late"` is for a block with something to watch
    // (a pointer that clicks a second in): it waits until a third of it is
    // well inside the viewport, so the click lands where the eye is.
    const early = new IntersectionObserver(reveal, {
      rootMargin: "0px 0px -10% 0px",
      threshold: 0,
    });
    const late = new IntersectionObserver(reveal, {
      rootMargin: "0px 0px -20% 0px",
      threshold: 0.3,
    });
    root.setAttribute("data-reveal-root", "");
    root
      .querySelectorAll<HTMLElement>("[data-reveal]:not([data-shown])")
      .forEach((element) =>
        (element.dataset.reveal === "late" ? late : early).observe(element),
      );
    return () => {
      early.disconnect();
      late.disconnect();
      root.removeAttribute("data-reveal-root");
    };
  }, [rootRef]);
}
