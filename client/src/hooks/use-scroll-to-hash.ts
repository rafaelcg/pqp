import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/** How long an arrival keeps following its section while the page settles. */
const SETTLE_MS = 3000;

/** Input that means the reader has taken over, so the follow must stop. */
const READER_INPUT = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/**
 * Land on the section a URL's `#fragment` names, on a page React renders.
 *
 * The browser's own anchor jump runs while the document is parsed, and on a
 * single-page app the section does not exist yet: `/#communities` from the
 * footer of `/download`, or `/vem#importar` from `/discord`, loads the page at
 * the top and stays there. Whether the native jump happens to win depends on
 * timing (a cold load sometimes renders before the browser gives up, a warm one
 * never does), so it cannot be relied on. A `<Link to="/#import">` never gets a
 * native jump at all, because the router changes the URL without a navigation.
 *
 * So the page does it itself once it has rendered, and again whenever the hash
 * changes. Both go through `scrollIntoView`, so the section's `scroll-mt-*`
 * still clears the sticky header.
 *
 * Arriving on a page, the jump is instant and then follows the section for a
 * few seconds. The web fonts and the live parts of a page (the landing's
 * server map) land after the first render and move everything below them by
 * tens of pixels, so a single jump lands short or long. The follow stops as
 * soon as the reader scrolls, taps or types. A hash change on a page already
 * settled on screen keeps the smooth glide from `index.css`.
 */
export function useScrollToHash() {
  const { hash } = useLocation();
  // The hash this page last handled. Undefined, or the same hash again (Strict
  // Mode runs every effect twice in development), means the page just arrived.
  const handled = useRef<string | undefined>(undefined);
  useEffect(() => {
    const first = handled.current === undefined || handled.current === hash;
    handled.current = hash;
    if (!hash) return;
    let id: string;
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch {
      // A malformed escape (`#%E0`) names no section; stay where we are.
      return;
    }
    const target = document.getElementById(id);
    if (!target) return;
    if (!first) {
      target.scrollIntoView({ block: "start" });
      return;
    }

    const jump = () =>
      target.scrollIntoView({ block: "start", behavior: "instant" });
    const pageTop = () => target.getBoundingClientRect().top + window.scrollY;
    jump();

    const until = performance.now() + SETTLE_MS;
    let last = pageTop();
    let frame = 0;
    const release = () => {
      cancelAnimationFrame(frame);
      for (const type of READER_INPUT) {
        window.removeEventListener(type, release);
      }
    };
    const follow = () => {
      const now = pageTop();
      if (Math.abs(now - last) >= 1) {
        last = now;
        jump();
      }
      if (performance.now() < until) frame = requestAnimationFrame(follow);
      else release();
    };
    for (const type of READER_INPUT) {
      window.addEventListener(type, release, { passive: true });
    }
    frame = requestAnimationFrame(follow);
    return release;
  }, [hash]);
}
