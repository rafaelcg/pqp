import { useCallback, useEffect, useState } from "react";
import {
  loadVideoFit,
  saveVideoFit,
  toggledVideoFit,
  VIDEO_FIT_DEFAULT,
  type VideoFit,
  type VideoFitKind,
  type VideoFitPreference,
} from "@/lib/video-fit";

/**
 * The fill-or-fit preference, shared by every tile on the stage.
 *
 * ONE STORE, MANY CALLERS, and that is the whole reason this is not a plain
 * `useState` in the stage. The button lives on a tile, there are up to eight
 * of them, and pressing one has to change all of them at once — a per-tile
 * `useState` would leave seven tiles cropped and one letterboxed, which is
 * the bug the button is supposed to fix.
 *
 * A MODULE STORE RATHER THAN A CONTEXT, because the alternative is threading
 * a value from `App.tsx` through `VoiceChannelStage`, `CallStage`,
 * `ActiveCall` and into every tile, and a context provider around the stage
 * is a new component in the tree the stage renders. Nothing on the stage may
 * be remounted by a preference change — `lib/remote-video-delivery.ts` pauses
 * a publication a second after the last `<video>` bound to it goes away — and
 * a subscription that only ever flips a class cannot do that.
 *
 * Read on first use rather than at import: a denied `localStorage` must not be
 * able to stop a module loading, and `loadVideoFit` swallows that anyway.
 */

let store: VideoFitPreference | null = null;
const listeners = new Set<(next: VideoFitPreference) => void>();

function current(): VideoFitPreference {
  store ??= loadVideoFit();
  return store;
}

function setKind(kind: VideoFitKind, fit: VideoFit): void {
  const next: VideoFitPreference = { ...current(), [kind]: fit };
  store = next;
  saveVideoFit(next);
  for (const listener of listeners) {
    listener(next);
  }
}

/** Tests only: forget what was read, so the next call re-reads storage. */
export function resetVideoFitStore(): void {
  store = null;
  for (const listener of listeners) {
    listener(VIDEO_FIT_DEFAULT);
  }
}

export interface VideoFitControls {
  fit: VideoFit;
  /** The other one, remembered for every tile of this kind. */
  toggle: () => void;
}

export function useVideoFit(kind: VideoFitKind): VideoFitControls {
  const [preference, setPreference] = useState<VideoFitPreference>(current);
  useEffect(() => {
    listeners.add(setPreference);
    // Between the initial read and this effect another tile may have written,
    // and a tile a frame behind the rest is the inconsistency this exists to
    // prevent.
    setPreference(current());
    return () => {
      listeners.delete(setPreference);
    };
  }, []);
  const fit = preference[kind];
  const toggle = useCallback(() => {
    setKind(kind, toggledVideoFit(current()[kind]));
  }, [kind]);
  return { fit, toggle };
}
