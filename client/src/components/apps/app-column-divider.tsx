import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import {
  APP_COLUMN_MIN_PX,
  APP_COLUMN_STEP_PX,
  appColumnMaxWidth,
  appColumnWidth,
} from "@/lib/apps/app-chat-visibility";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The edge between the app and the column beside it, which the person drags to
 * give the chat more room or the app more room (`app_pane_layout_v2`).
 *
 * A separator, not a button: focusable, with its value in px, and the arrows
 * move it (Shift four times as far, Home and End to the ends). A double click,
 * or Enter, gives the width back to the window (the stored drag is forgotten).
 * The hit area is the 8 px gutter around the 1 px line, and the line brightens on hover and
 * while dragging. Pointer capture keeps the drag going over the app's frame;
 * the layout also turns the frame's pointer events off while it lasts.
 */
export function AppColumnDivider({
  width,
  body,
  controls,
  onDrag,
  onCommit,
}: {
  width: number;
  body: number;
  /** The column's id, for `aria-controls`. */
  controls: string;
  /** A width while the pointer is down (not stored yet). */
  onDrag: (width: number) => void;
  /** The width to keep, or null to give it back to the window. */
  onCommit: (width: number | null) => void;
}) {
  const { t } = useTranslation();
  const drag = useRef<{ x: number; start: number; last: number } | null>(null);
  const max = appColumnMaxWidth(body);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, start: width, last: width };
    onDrag(width);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    // The column is on the right: moving left makes it wider.
    const next = appColumnWidth(body, current.start - (event.clientX - current.x));
    current.last = next;
    onDrag(next);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onCommit(current.last);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? APP_COLUMN_STEP_PX * 4 : APP_COLUMN_STEP_PX;
    let next: number | null | undefined;
    if (event.key === "ArrowLeft") next = width + step;
    else if (event.key === "ArrowRight") next = width - step;
    else if (event.key === "Home") next = max;
    else if (event.key === "End") next = APP_COLUMN_MIN_PX;
    else if (event.key === "Enter") next = null;
    if (next === undefined) return;
    event.preventDefault();
    onCommit(next === null ? null : appColumnWidth(body, next));
  };

  return (
    <Tooltip label={t("apps.column.resize")} detail={t("apps.column.resizeHint")} side="left">
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-controls={controls}
        aria-valuenow={width}
        aria-valuemin={APP_COLUMN_MIN_PX}
        aria-valuemax={max}
        data-testid="app-column-divider"
        className={cn(
          // Its own 8 px gutter, not an overlap: anything the column draws over
          // its own left edge (the call's bar is `absolute`, `z-50`) would
          // otherwise sit on half of the handle and eat the drag.
          "group relative w-2 flex-none cursor-col-resize touch-none select-none",
          "focus-visible:outline-none",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => onCommit(null)}
        onKeyDown={onKeyDown}
      >
        <span
          aria-hidden
          className={cn(
            "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors duration-[var(--duration-fast)]",
            "group-hover:w-0.5 group-hover:bg-accent group-focus-visible:w-0.5 group-focus-visible:bg-focus-ring",
            drag.current && "w-0.5 bg-accent",
          )}
        />
      </div>
    </Tooltip>
  );
}
