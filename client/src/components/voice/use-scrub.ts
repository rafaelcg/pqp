import { useRef, useState } from "react";

/**
 * THE SEEK BAR'S PREVIEW, WHICH ONLY A DRAG MAY HOLD.
 *
 * A slider that draws `scrub ?? position` needs somebody to clear `scrub`,
 * and the bar used to clear it only in `onValueCommit`. That looks safe and
 * is not, because the slider is controlled: `useControllableState` runs the
 * updater first, which fires `onValueCommit` from inside it, and only then
 * calls `onValueChange`. So a key press arrives as commit, then change. The
 * commit seeked and cleared the preview, the change set it again, and
 * nothing cleared it after that: the clock froze for the rest of the track,
 * through pause, resume and the next song, while each further key press
 * stepped from the frozen number. The seek was being sent all along, which
 * is why "the track never moves" was the wrong description of it.
 *
 * So the preview is tied to a drag and to nothing else. A change with no
 * drag in progress is a keyboard step: it seeks straight through, the way
 * the volume slider has always written. The value a commit already seeked
 * is remembered, so the change that follows it does not seek twice.
 */
export interface Scrub {
  /** The value to draw instead of the room's, or null to draw the room's. */
  preview: number | null;
  /** Spread onto the slider: they tell a drag from a key press. */
  rootProps: {
    onPointerDown: () => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
  };
  onValueChange: (value: number) => void;
  onValueCommit: (value: number) => void;
}

export function useScrub(onSeek: (value: number) => void): Scrub {
  const [preview, setPreview] = useState<number | null>(null);
  const dragging = useRef(false);
  const lastSeeked = useRef<number | null>(null);

  const stopDragging = () => {
    dragging.current = false;
    setPreview(null);
  };

  return {
    preview,
    rootProps: {
      onPointerDown: () => {
        dragging.current = true;
      },
      onPointerUp: stopDragging,
      onPointerCancel: stopDragging,
    },
    onValueChange: (value) => {
      if (dragging.current) {
        setPreview(value);
        return;
      }
      if (lastSeeked.current === value) {
        // The change that follows a commit, carrying the same value.
        return;
      }
      lastSeeked.current = value;
      onSeek(value);
    },
    onValueCommit: (value) => {
      stopDragging();
      lastSeeked.current = value;
      onSeek(value);
    },
  };
}
