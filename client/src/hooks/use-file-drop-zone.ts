import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  isExternalFileDrag,
  readDroppedItems,
  type DroppedItems,
} from "@/lib/file-drop";

/**
 * What a surface does with a file dragged over it.
 *
 *  - `accept`: shows the "drop to attach" overlay and takes the drop.
 *  - `refuse`: shows the overlay in its "not here" tone, with the reason, and
 *    answers the drag with the no-drop cursor, so nothing is delivered. Used
 *    when the surface WOULD take files but this deployment, channel or person
 *    cannot (attachments off, no permission to send).
 *  - `off`: not a drop zone at all. The page-wide guard (`installFileDropGuard`)
 *    still keeps the browser from opening the file.
 */
export type FileDropMode = "accept" | "refuse" | "off";

interface Options {
  mode: FileDropMode;
  onDrop?: (items: DroppedItems) => void;
}

/**
 * Whether this event is a file drag from outside the page, aimed at something
 * physically inside the zone (see the portal note on `useFileDropZone`).
 */
function isRelevant(mode: FileDropMode, event: DragEvent<HTMLElement>): boolean {
  return (
    mode !== "off" &&
    isExternalFileDrag(event.dataTransfer) &&
    event.target instanceof Node &&
    event.currentTarget.contains(event.target)
  );
}

/**
 * Handlers for one drop zone, plus whether a file drag is over it right now.
 *
 * Spread `zoneProps` on the container that should be the target. The whole
 * pane is the target, not the one input inside it: people drop a screenshot
 * onto the messages, and a target the size of a textarea is a target you miss.
 *
 * Three things here are not obvious.
 *
 * `dragenter` and `dragleave` fire for every element the pointer crosses, so a
 * boolean flickers off the moment the drag passes over a child. Only a depth
 * count returning to zero means the drag has left the zone.
 *
 * React bubbles synthetic events through portals. A dialog opened from inside
 * the pane is a DOM sibling of it, not a child, and a file dropped on that
 * dialog must not attach to the conversation behind it. Every handler checks
 * that the target is physically inside the zone.
 *
 * A drag that began inside pqp (a channel being reordered, a picture picked up
 * out of the transcript) never counts, even when the browser dresses it as a
 * file (`isExternalFileDrag`).
 */
export function useFileDropZone({ mode, onDrop }: Options) {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  const reset = useCallback(() => {
    depth.current = 0;
    setActive(false);
  }, []);

  // Going `off` (a channel switch, attachments turning out to be disabled)
  // while a drag is over the zone must not leave the overlay up.
  useEffect(() => {
    if (mode === "off") {
      reset();
    }
  }, [mode, reset]);

  // The drag can end somewhere this zone never hears about (dropped on a
  // dialog, Escape, released outside the window), which would strand the
  // overlay on screen. These listeners only ever clear.
  useEffect(() => {
    if (!active) {
      return;
    }
    const clear = () => reset();
    document.addEventListener("drop", clear, true);
    document.addEventListener("dragend", clear, true);
    return () => {
      document.removeEventListener("drop", clear, true);
      document.removeEventListener("dragend", clear, true);
    };
  }, [active, reset]);

  const zoneProps = useMemo(
    () => ({
      onDragEnter: (event: DragEvent<HTMLElement>) => {
        if (!isRelevant(modeRef.current, event)) {
          return;
        }
        depth.current += 1;
        setActive(true);
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!isRelevant(modeRef.current, event)) {
          return;
        }
        // Without this the browser navigates to the file instead of dropping.
        event.preventDefault();
        event.dataTransfer.dropEffect =
          modeRef.current === "accept" ? "copy" : "none";
        // A missed `dragenter` (the zone mounted under the pointer) is
        // recovered here rather than left showing nothing.
        if (depth.current === 0) {
          depth.current = 1;
        }
        setActive(true);
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!isRelevant(modeRef.current, event)) {
          return;
        }
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) {
          setActive(false);
        }
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        const relevant = isRelevant(modeRef.current, event);
        reset();
        if (!relevant) {
          return;
        }
        // Whatever the mode, the zone owns this drop: leaving it to the
        // browser is the navigate-to-the-file failure.
        event.preventDefault();
        if (modeRef.current !== "accept") {
          return;
        }
        const items = readDroppedItems(event.dataTransfer);
        if (items.files.length === 0 && items.folders.length === 0) {
          return;
        }
        onDropRef.current?.(items);
      },
    }),
    [reset],
  );

  return { zoneProps, active: active && mode !== "off" };
}
