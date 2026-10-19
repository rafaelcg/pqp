import { useEffect, useLayoutEffect } from "react";

/** One saved position per history entry: `pqp:home-scroll:<entry key>`. */
const SCROLL_KEY = "pqp:home-scroll:";

/**
 * What tells the restore that somebody else is moving the page now: a hash
 * link or back and forward, and the reader's own input (the same list
 * `useScrollToHash` stops its follow on).
 */
const OVERRULE = ["hashchange", "popstate", "wheel", "touchstart", "keydown", "pointerdown"] as const;

/**
 * The key of the history entry on screen. React Router stores one in
 * `history.state` for every entry it pushes; the tab's first entry, and an
 * entry a plain `#section` link made, have none and share "default".
 */
function entryKey(): string {
  const state: unknown = window.history.state;
  const key = state && typeof state === "object" ? (state as { key?: unknown }).key : undefined;
  return SCROLL_KEY + (typeof key === "string" ? key : "default");
}

/** Whether this document was loaded by a reload, or rebuilt by back or forward. */
function arrivedByReload(): boolean {
  try {
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return entry?.type === "reload" || entry?.type === "back_forward";
  } catch {
    return false;
  }
}

/**
 * Brings a reload from mid-page back to where the reader was. The page's
 * pinned scenes and lazy media settle after first paint, and the browser's
 * own restore runs before that, so it would land at the top. This waits two
 * frames and jumps itself (instant: html is `scroll-behavior: smooth` with
 * motion).
 *
 * - A hash wins. With one in the URL this does nothing, and
 *   `useScrollToHash` alone moves the page, so the two never fight during
 *   its three-second follow.
 * - A hash that arrives during the restore wins too, and so does back or
 *   forward or the reader's own input: the restore stands down. Without that,
 *   its late correction could land inside a header link's glide before the
 *   glide had moved a pixel (a smooth scroll can take 300 ms to start on a
 *   busy machine), read "nothing moved", and jump back, cancelling the glide.
 * - It runs only when the document came from a reload or from back or
 *   forward. Any other arrival opens at the top.
 * - Positions are saved per history entry. The document can say "reload"
 *   long after the fact (reload /download, then click the logo to "/"), and
 *   only the entry key keeps that arrival from borrowing an old position.
 */
export function useReloadRestore() {
  useLayoutEffect(() => {
    const previous = history.scrollRestoration;
    history.scrollRestoration = "manual";
    return () => {
      history.scrollRestoration = previous;
    };
  }, []);

  useEffect(() => {
    const onHide = () => {
      try {
        sessionStorage.setItem(entryKey(), String(Math.round(window.scrollY)));
      } catch {
        // Storage can be blocked; the page still works without a restore.
      }
    };
    window.addEventListener("pagehide", onHide);

    let raf = 0;
    let timer = 0;
    let stopped = false;
    const stop = () => {
      stopped = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      for (const type of OVERRULE) window.removeEventListener(type, stop);
    };
    if (!window.location.hash && arrivedByReload()) {
      const key = entryKey();
      let saved: number | null = null;
      try {
        // Read now, cleared after the jump: a dev double-mount must see it twice.
        const raw = sessionStorage.getItem(key);
        if (raw !== null && Number.isFinite(Number(raw))) saved = Number(raw);
      } catch {
        // See above.
      }
      if (saved !== null && saved > 0) {
        const top = saved;
        // The URL is read again at each jump, as well as listened to: a
        // hash can land between an event and the timer that follows it.
        const jump = () => {
          if (stopped || window.location.hash) return;
          window.scrollTo({ top, behavior: "instant" });
        };
        for (const type of OVERRULE) window.addEventListener(type, stop, { passive: true });
        raf = requestAnimationFrame(() => {
          raf = requestAnimationFrame(() => {
            jump();
            try {
              sessionStorage.removeItem(key);
            } catch {
              // See above.
            }
            // Scene runways and images keep settling; correct once if nothing
            // else moved the page in the meantime.
            const landed = window.scrollY;
            timer = window.setTimeout(() => {
              if (Math.abs(window.scrollY - landed) < 2) jump();
              stop();
            }, 500);
          });
        });
      }
    }

    return () => {
      stop();
      window.removeEventListener("pagehide", onHide);
    };
  }, []);
}
