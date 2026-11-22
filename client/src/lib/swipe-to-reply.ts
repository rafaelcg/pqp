import type { PointerEvent as ReactPointerEvent } from "react";
import { useMemo, useRef } from "react";

/** Past this many pixels a released swipe replies (the canvas's motion board, 45 pt). */
export const SWIPE_REPLY_AT = 45;
/** The row never travels further than this, however far the finger goes. */
export const SWIPE_REPLY_MAX = 72;
/** Movement before the gesture decides it is a swipe and not a scroll. */
const SWIPE_SLOP = 10;

/**
 * Where the row sits for a finger `dx` pixels to the right: one to one up to
 * the reply point, then a rubber band, so the point is felt and not passed.
 */
export function swipeOffset(dx: number): number {
  if (dx <= 0) {
    return 0;
  }
  if (dx <= SWIPE_REPLY_AT) {
    return dx;
  }
  return Math.min(SWIPE_REPLY_MAX, SWIPE_REPLY_AT + (dx - SWIPE_REPLY_AT) * 0.3);
}

type Gesture = {
  pointerId: number;
  x: number;
  y: number;
  swiping: boolean;
  armed: boolean;
};

/**
 * Drag a message to the right to reply, as in WhatsApp (the canvas,
 * "Celular: gestos", board 1): the row follows the finger, a reply mark fades
 * in behind it, the phone ticks at the reply point, and the row springs back
 * on release whether or not it replied. Touch only; the row keeps vertical
 * scrolling (`touch-action: pan-y` in index.css), and a gesture that starts
 * vertical is never a swipe.
 *
 * Writes `--swipe-x` (pixels) and `--swipe-p` (0 to 1) on the row itself, so
 * a drag never renders React.
 */
export function useSwipeToReply(
  enabled: boolean,
  onReply: (() => void) | undefined,
) {
  const gesture = useRef<Gesture | null>(null);
  const replyRef = useRef(onReply);
  replyRef.current = onReply;

  return useMemo(() => {
    if (!enabled) {
      return {};
    }
    const settle = (row: HTMLElement) => {
      row.removeAttribute("data-swiping");
      row.removeAttribute("data-swipe-armed");
      row.style.removeProperty("--swipe-x");
      row.style.removeProperty("--swipe-p");
    };
    return {
      "data-swipe-reply": "",
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (event.pointerType === "mouse" || !event.isPrimary) {
          return;
        }
        gesture.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          swiping: false,
          armed: false,
        };
      },
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) {
          return;
        }
        const dx = event.clientX - current.x;
        const dy = event.clientY - current.y;
        const row = event.currentTarget;
        if (!current.swiping) {
          if (Math.abs(dy) > SWIPE_SLOP && Math.abs(dy) >= Math.abs(dx)) {
            gesture.current = null;
            return;
          }
          if (dx < SWIPE_SLOP || dx < Math.abs(dy) * 1.5) {
            return;
          }
          current.swiping = true;
          row.setAttribute("data-swiping", "");
        }
        const offset = swipeOffset(dx);
        row.style.setProperty("--swipe-x", `${offset}px`);
        row.style.setProperty("--swipe-p", String(Math.min(1, offset / SWIPE_REPLY_AT)));
        const armed = offset >= SWIPE_REPLY_AT;
        if (armed !== current.armed) {
          current.armed = armed;
          row.toggleAttribute("data-swipe-armed", armed);
          if (armed) {
            navigator.vibrate?.(10);
          }
        }
      },
      onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
        const current = gesture.current;
        gesture.current = null;
        if (!current?.swiping) {
          return;
        }
        settle(event.currentTarget);
        if (current.armed) {
          replyRef.current?.();
        }
      },
      onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => {
        gesture.current = null;
        settle(event.currentTarget);
      },
    };
  }, [enabled]);
}
