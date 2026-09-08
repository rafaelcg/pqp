import { useCallback, useEffect, useState } from "react";
import {
  channelSidebarMaxWidth,
  clampChannelSidebarWidth,
  loadChannelSidebarWidth,
  saveChannelSidebarWidth,
} from "@/lib/channel-sidebar-width";

/** `window.innerWidth`, or 0 in a renderer that has no window at all. */
export function viewportWidth(): number {
  return typeof window === "undefined" ? 0 : window.innerWidth;
}

/**
 * The channel column's width, restored from storage on the first render and
 * clamped to the window from then on.
 *
 * READ IN THE INITIALISER, not in an effect. An effect would paint 256px and
 * then jump to the stored 380px on the next frame, which is the "visible jump"
 * this is supposed to avoid; `useState(fn)` runs before the first paint.
 *
 * `resize` RATHER THAN A MEDIA QUERY, because the bound moves continuously
 * with the window rather than at a breakpoint. The listener only ever narrows
 * the column: a window that grows again does not push it back out, since the
 * stored number is the person's choice and the clamp is a constraint, not a
 * second opinion.
 */
export function useChannelSidebarWidth(): {
  width: number;
  /** This window's upper bound. What the handle reports as `aria-valuemax`. */
  maxWidth: number;
  /** During a drag. Not persisted. */
  setWidth: (width: number) => void;
  /** Settled. Persisted. */
  commitWidth: (width: number) => void;
} {
  const [width, setWidth] = useState(() =>
    loadChannelSidebarWidth(viewportWidth()),
  );
  const [maxWidth, setMaxWidth] = useState(() =>
    channelSidebarMaxWidth(viewportWidth()),
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    function onResize() {
      const next = channelSidebarMaxWidth(window.innerWidth);
      // Both guarded on a real change: a resize drag fires this every frame,
      // and above ~1050px the bound is a flat 420 that never moves at all.
      setMaxWidth((previous) => (previous === next ? previous : next));
      setWidth((previous) => (previous > next ? next : previous));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const commitWidth = useCallback((next: number) => {
    const clamped = clampChannelSidebarWidth(next, viewportWidth());
    setWidth(clamped);
    saveChannelSidebarWidth(clamped);
  }, []);

  return { width, maxWidth, setWidth, commitWidth };
}
