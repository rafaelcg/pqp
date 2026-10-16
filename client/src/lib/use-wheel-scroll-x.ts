import { useEffect, type RefObject } from "react";

/**
 * How far a wheel turn moves a row that scrolls sideways: the vertical turn of a plain mouse wheel
 * (it has no horizontal axis) becomes a horizontal move; a trackpad's own sideways swipe is left to
 * the browser. 0 when the turn is not for this row to take: mostly sideways already, no room to
 * scroll that way, or the row is already at the end it is being pushed toward (so the turn goes on to
 * whatever is behind it).
 */
export function wheelScrollDelta(
  turn: { deltaX: number; deltaY: number; deltaMode: number },
  row: { scrollLeft: number; scrollWidth: number; clientWidth: number },
): number {
  if (Math.abs(turn.deltaY) <= Math.abs(turn.deltaX)) {
    return 0;
  }
  const room = row.scrollWidth - row.clientWidth;
  if (room <= 0) {
    return 0;
  }
  // A line or a page, as a mouse reports it in Firefox, is not pixels.
  const pixels = turn.deltaMode === 1 ? turn.deltaY * 16 : turn.deltaMode === 2 ? turn.deltaY * row.clientWidth : turn.deltaY;
  if ((pixels < 0 && row.scrollLeft <= 0) || (pixels > 0 && row.scrollLeft >= room - 1)) {
    return 0;
  }
  return pixels;
}

/** A row that overflows sideways answers the wheel of a plain mouse, which has no way to scroll it. */
export function useWheelScrollX(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const row = ref.current;
    if (!row) {
      return;
    }
    // Not a React `onWheel`: those are passive, and the default has to be cancelled.
    const onWheel = (event: WheelEvent) => {
      // A right-to-left row counts `scrollLeft` from 0 down to negative numbers, which the end checks
      // below do not model. No locale of the app is right-to-left; if one arrives, the browser's own
      // scrolling (a trackpad, shift + wheel) keeps working and this stays out of the way.
      if (getComputedStyle(row).direction === "rtl") {
        return;
      }
      const delta = wheelScrollDelta(event, row);
      if (delta !== 0) {
        event.preventDefault();
        row.scrollLeft += delta;
      }
    };
    row.addEventListener("wheel", onWheel, { passive: false });
    return () => row.removeEventListener("wheel", onWheel);
  }, [ref]);
}
