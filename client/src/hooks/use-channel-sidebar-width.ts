import { useCallback, useEffect, useState } from "react";
import {
  type SidebarWidthSlot,
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
export function useChannelSidebarWidth(slot: SidebarWidthSlot = {}): {
  width: number;
  /** This window's upper bound. What the handle reports as `aria-valuemax`. */
  maxWidth: number;
  /** During a drag. Not persisted. */
  setWidth: (width: number) => void;
  /** Settled. Persisted. */
  commitWidth: (width: number) => void;
} {
  const { key, defaultWidth } = slot;
  // THE CHOICE AND WHAT IS DRAWN ARE TWO NUMBERS. The resize listener used to
  // write the window's bound into the choice itself (`min(previous, bound)`),
  // so a window made narrow once (docked beside another, a phone held
  // sideways) left the column at 200 px for good, however wide the window
  // grew again, until a reload: the channel list read as squeezed next to an
  // app (Locadora feedback, round 2). Now the bound only clamps what is drawn
  // and the choice waits for the room to come back. Read unclamped so a choice
  // made on a wide window is not lost to a narrow first render.
  const [preferred, setPreferred] = useState(() =>
    loadChannelSidebarWidth(Number.POSITIVE_INFINITY, { key, defaultWidth }),
  );
  const [maxWidth, setMaxWidth] = useState(() =>
    channelSidebarMaxWidth(viewportWidth()),
  );
  // A caller that switches slot while mounted reads the new slot's stored
  // width, rather than showing (and then saving under the new key) the old
  // one's. Today every caller keeps one slot for its lifetime; this keeps it
  // that way if one ever does not.
  const [loadedKey, setLoadedKey] = useState(key);
  if (loadedKey !== key) {
    setLoadedKey(key);
    setPreferred(loadChannelSidebarWidth(Number.POSITIVE_INFINITY, { key, defaultWidth }));
  }

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    function onResize() {
      const next = channelSidebarMaxWidth(window.innerWidth);
      // Guarded on a real change: a resize drag fires this every frame, and
      // above ~1050px the bound is a flat 420 that never moves at all.
      setMaxWidth((previous) => (previous === next ? previous : next));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const commitWidth = useCallback(
    (next: number) => {
      const clamped = clampChannelSidebarWidth(next, viewportWidth());
      setPreferred(clamped);
      saveChannelSidebarWidth(clamped, { key });
    },
    [key],
  );

  const width = Math.min(preferred, maxWidth);
  return { width, maxWidth, setWidth: setPreferred, commitWidth };
}
