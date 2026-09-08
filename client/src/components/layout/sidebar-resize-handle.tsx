import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  CHANNEL_SIDEBAR_MIN_WIDTH,
  channelSidebarWidthForKey,
  clampChannelSidebarWidth,
  resetChannelSidebarWidth,
} from "@/lib/channel-sidebar-width";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The draggable right edge of the channel column.
 *
 * INVISIBLE UNTIL WANTED. A permanent grab bar on a 256px column is a
 * permanent 6px of noise for a thing most people set once. It is a transparent
 * strip until the pointer is over it or it has keyboard focus, and then it is
 * a one-pixel line in the accent colour, which is the whole affordance.
 *
 * IT SITS ON THE BORDER, not inside the column: `translate-x-1/2` puts half of
 * it outside the aside, so it overlaps the channel list's own scrollbar by
 * about 3px rather than 6. Any wider and dragging the scrollbar on Windows
 * would start a resize instead.
 *
 * POINTER CAPTURE, not window listeners. The strip captures the pointer on
 * `pointerdown`, so a drag that leaves the handle (which every drag does
 * immediately) keeps arriving here, and nothing has to be torn down on an
 * unmount mid-drag.
 *
 * ESCAPE CANCELS. A drag that started at 256 and is at 400 when Escape is
 * pressed goes back to 256, the same contract a drag in any editor has. The
 * width at `pointerdown` is what it returns to, not the last committed one.
 *
 * NO ANIMATION, EVER. The width follows the pointer, so a transition on it is
 * lag rather than polish. That also means there is nothing for
 * `prefers-reduced-motion` to switch off: the keyboard steps and the double
 * click reset land in one frame for everybody.
 *
 * `role="separator"` with `aria-valuenow` is the ARIA window-splitter pattern.
 * It is focusable (`tabIndex=0`) because a separator that only a mouse can
 * move is a control half the people cannot reach.
 */
export function SidebarResizeHandle({
  width,
  maxWidth,
  onWidthChange,
  onCommit,
}: {
  /** The column's current width in CSS pixels. */
  width: number;
  /** This window's upper bound, for `aria-valuemax`. */
  maxWidth: number;
  /** Called continuously during a drag and once per key. Not persisted. */
  onWidthChange: (width: number) => void;
  /** Called when the width is settled: pointer up, key up, reset. Persists. */
  onCommit: (width: number) => void;
}) {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState(false);
  // A ref rather than state: the pointer-move handler reads it on every frame
  // and must never see a stale render's copy.
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(
    null,
  );
  // Read at event time rather than taken as a prop: a resize drag on a narrow
  // window moves this bound continuously, and the number the clamp uses must
  // be the one that is true right now, not the one from the last render.
  const viewport = () =>
    typeof window === "undefined" ? 0 : window.innerWidth;

  function endDrag(element: HTMLElement) {
    const current = drag.current;
    drag.current = null;
    setDragging(false);
    if (current && element.hasPointerCapture(current.pointerId)) {
      element.releasePointerCapture(current.pointerId);
    }
    return current;
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    // Only the primary button, and never while a secondary one is held: a
    // right click here should open nothing and move nothing.
    if (event.button !== 0) {
      return;
    }
    // Stops the browser from starting a text selection in the channel list
    // the moment the pointer moves.
    event.preventDefault();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    // `preventDefault` above stopped the browser focusing this, and without
    // focus the Escape-cancels branch in `onKeyDown` would never fire during a
    // mouse drag. `focus-visible` keeps the ring off for the pointer.
    element.focus();
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
    };
    setDragging(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current) {
      return;
    }
    onWidthChange(
      clampChannelSidebarWidth(
        current.startWidth + (event.clientX - current.startX),
        viewport(),
      ),
    );
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const current = endDrag(event.currentTarget);
    if (!current) {
      return;
    }
    onCommit(
      clampChannelSidebarWidth(
        current.startWidth + (event.clientX - current.startX),
        viewport(),
      ),
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && drag.current) {
      const current = endDrag(event.currentTarget);
      if (current) {
        onCommit(clampChannelSidebarWidth(current.startWidth, viewport()));
      }
      return;
    }
    const next = channelSidebarWidthForKey(event.key, {
      current: width,
      shiftKey: event.shiftKey,
      viewportWidth: viewport(),
    });
    if (next === null) {
      return;
    }
    // Home and End are the page's own scroll keys otherwise, and the arrows
    // would move the focus ring out of the column.
    event.preventDefault();
    onCommit(next);
  }

  return (
    <div
      data-sidebar-resize=""
      role="separator"
      aria-orientation="vertical"
      aria-label={t("chrome.resizeChannelList")}
      aria-valuenow={width}
      aria-valuemin={CHANNEL_SIDEBAR_MIN_WIDTH}
      aria-valuemax={maxWidth}
      tabIndex={0}
      title={`${t("chrome.resizeChannelList")} · ${t("chrome.resizeChannelListReset")}`}
      className={cn(
        // `hidden md:block`: below `md` the column is a drawer over the chat
        // and there is no edge to drag.
        "absolute inset-y-0 right-0 z-30 hidden w-1.5 translate-x-1/2 cursor-col-resize touch-none select-none outline-none md:block",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-signal after:opacity-0",
        "hover:after:opacity-70 focus-visible:after:opacity-100 focus-visible:after:w-0.5",
        dragging && "after:opacity-100",
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onCommit(resetChannelSidebarWidth(viewport()))}
    />
  );
}
