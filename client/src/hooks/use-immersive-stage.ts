import { useCallback, useEffect, useState } from "react";

/**
 * When the stage should own the whole window.
 *
 * A phone held sideways is 340 to 400 CSS pixels tall. That is also the range
 * where Tailwind's `md:` (768px wide) kicks in, so a landscape iPhone gets
 * the desktop layout: rail, channel list, stage, and sometimes the member
 * roster, all side by side on a 750px screen, with the share squeezed into
 * whatever is left. Watching a share is the one moment where none of that
 * chrome earns its space, so it goes, and the stage takes the width.
 *
 * The decision is a pure function; the hook only feeds it the viewport and
 * publishes the answer as `data-immersive-stage` on `<html>`. The shell's
 * columns hide themselves through one CSS rule (`index.css`) keyed on that
 * attribute, so the layout files carry a `data-immersive-hide` marker and
 * nothing else. That keeps `App.tsx` and this stage out of each other's way.
 *
 * The way back is `dismiss()`: a button on the stage puts the columns back
 * for the rest of this share. Rotating to portrait or leaving the share
 * clears everything.
 */

/** Height under which a landscape window is a phone, not a small laptop. */
export const IMMERSIVE_MAX_HEIGHT_PX = 500;
export const IMMERSIVE_MEDIA_QUERY = `(orientation: landscape) and (max-height: ${IMMERSIVE_MAX_HEIGHT_PX}px)`;

export interface ImmersiveInput {
  /** A screen share is the focused tile on the stage. */
  shareFocused: boolean;
  /** The stage is already fullscreen, in-page or via the platform. */
  fullscreen: boolean;
  /** `IMMERSIVE_MEDIA_QUERY` matches. */
  smallLandscape: boolean;
  /** The person asked for the columns back during this share. */
  dismissed: boolean;
}

export function resolveImmersive(input: ImmersiveInput): boolean {
  if (input.fullscreen) {
    return true;
  }
  if (!input.shareFocused || !input.smallLandscape) {
    return false;
  }
  return !input.dismissed;
}

export const IMMERSIVE_STAGE_ATTRIBUTE = "data-immersive-stage";

function readSmallLandscape(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(IMMERSIVE_MEDIA_QUERY).matches;
}

export function useSmallLandscape(): boolean {
  const [matches, setMatches] = useState(readSmallLandscape);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(IMMERSIVE_MEDIA_QUERY);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return matches;
}

export function useImmersiveStage(input: {
  shareFocused: boolean;
  fullscreen: boolean;
}) {
  const smallLandscape = useSmallLandscape();
  const [dismissed, setDismissed] = useState(false);

  // A new share (or the share ending) forgets the dismissal: the choice was
  // about this picture, not about the phone forever.
  useEffect(() => {
    if (!input.shareFocused) {
      setDismissed(false);
    }
  }, [input.shareFocused]);

  const immersive = resolveImmersive({
    shareFocused: input.shareFocused,
    fullscreen: input.fullscreen,
    smallLandscape,
    dismissed,
  });

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const root = document.documentElement;
    if (immersive) {
      root.setAttribute(IMMERSIVE_STAGE_ATTRIBUTE, "");
    } else {
      root.removeAttribute(IMMERSIVE_STAGE_ATTRIBUTE);
    }
    return () => root.removeAttribute(IMMERSIVE_STAGE_ATTRIBUTE);
  }, [immersive]);

  const dismiss = useCallback(() => setDismissed(true), []);
  const restore = useCallback(() => setDismissed(false), []);

  return {
    immersive,
    smallLandscape,
    /** True when the columns are hidden by the landscape rule alone, so a way back is owed. */
    canDismiss: immersive && !input.fullscreen,
    /** The columns are back by request; offer the reverse. */
    dismissed: dismissed && input.shareFocused && smallLandscape && !input.fullscreen,
    dismiss,
    restore,
  };
}
