import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Tooltip } from "@/components/ui/tooltip";
import {
  CALL_SPLIT_DIVIDER_PX,
  CALL_SPLIT_STEP_COARSE_PX,
  CALL_SPLIT_STEP_PX,
  clampSplit,
  nudgeSplit,
  resolveOrientation,
  splitAvailable,
  splitBounds,
  splitFraction,
  type CallSplitPreference,
  type CallStageShape,
} from "@/lib/call-split";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The call stage and the transcript, and the thing between them you drag.
 *
 * WHY A COMPONENT AND NOT TWO CLASS NAMES. The stage and the messages are
 * siblings in one column of `App.tsx`, and the only thing that decides how
 * they share the pane is a number. Putting that number here keeps `App.tsx`
 * out of pointer maths and gives the rule one place to be tested.
 *
 * THE DOM ORDER NEVER CHANGES, and that is a correctness requirement rather
 * than tidiness. `lib/remote-video-delivery.ts` pauses an SFU publication a
 * second after the last `<video>` bound to it goes away, so a layout switch
 * that moved the stage into a different branch of the tree would unmount every
 * tile, drop every binding, and hand the viewer a black rectangle a moment
 * later. Stage, divider, transcript are always the same three slots in the
 * same order; stacked and side by side differ only by `flex-direction` and by
 * which axis the inline size is written on, so React reconciles in place and
 * no `<video>` is ever destroyed. `call-split.test.tsx` pins that.
 *
 * SHRINKING THE STAGE IS A SAVING. Tile size is what livekit's `adaptiveStream`
 * measures, so dragging the divider up asks the SFU for smaller layers. The
 * tiles stay mounted and bound the whole time, which is the difference between
 * "ask for less" and "stop delivering".
 */

export interface CallSplitProps {
  /** What the stage is right now. Only `expanded` is split. */
  shape: CallStageShape;
  /**
   * The whole stored preference, not a single number: the orientation this
   * pane actually draws is resolved HERE, against a width only this component
   * measures, and the two orientations keep separate fractions. Handing down
   * one pre-picked number would mean the caller had to guess the width first.
   */
  preference: CallSplitPreference;
  /** `persist` is false during a drag and true when it lets go. */
  onPreferenceChange: (next: CallSplitPreference, persist: boolean) => void;
  /**
   * What the pane worked out from its own measurements, reported up.
   *
   * `active` is what tells the stage to fill its box instead of sizing itself.
   * `canSideBySide` is what decides whether the orientation toggle is offered
   * at all: it lives in the channel header, several hundred lines away, and a
   * toggle on a pane that cannot hold two columns is a toggle that lies.
   */
  onSplitStateChange?: (state: CallSplitState) => void;
  /**
   * Override for tests. The pane measures itself with a `ResizeObserver`,
   * which reports nothing at all through `react-dom/server`, so every layout
   * this component can draw would be unreachable from a Node test without it.
   * Same escape hatch `VoiceStatusBar` keeps for its `getDisplayMedia` probe.
   */
  paneSize?: PaneSize;
  stage: ReactNode;
  children: ReactNode;
}

export interface CallSplitState {
  active: boolean;
  canSideBySide: boolean;
}

export interface PaneSize {
  width: number;
  height: number;
}

function usePaneSize(ref: RefObject<HTMLDivElement | null>): PaneSize {
  const [size, setSize] = useState<PaneSize>({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const read = () =>
      setSize((previous) => {
        const width = Math.round(element.clientWidth);
        const height = Math.round(element.clientHeight);
        return previous.width === width && previous.height === height
          ? previous
          : { width, height };
      });
    read();
    if (typeof ResizeObserver === "undefined") {
      // No observer (an old WebView, a server render): the split still works,
      // it just will not follow a resize until something else re-renders.
      window.addEventListener("resize", read);
      return () => window.removeEventListener("resize", read);
    }
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

export function CallSplit({
  shape,
  preference,
  onPreferenceChange,
  onSplitStateChange,
  paneSize,
  stage,
  children,
}: CallSplitProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const stagePaneRef = useRef<HTMLDivElement>(null);
  const measured = usePaneSize(paneRef);
  // The stage's own size, measured, for the case where nobody has dragged yet
  // and it is still sizing itself. That number is what the divider reports and
  // what a first drag starts from, so the handle never jumps under the pointer.
  const naturalStage = usePaneSize(stagePaneRef);
  const { width, height } = paneSize ?? measured;
  // Side by side is a claim about width AND about there being a picture. A
  // pane that cannot hold two columns, or a stage with nothing on it, draws
  // the stacked layout without touching what is stored: widening the window,
  // or somebody turning a camera on, brings the choice back on its own.
  const orientation = resolveOrientation(preference.orientation, width, shape);
  const sideBySide = orientation === "side-by-side";
  const fraction = sideBySide ? preference.side : preference.stacked;
  const container = sideBySide ? width : height;
  const bounds = splitBounds(orientation);

  // Two different questions, and conflating them is how a default gets
  // rewritten by accident.
  //
  // `resizable` is "is there a divider": an expanded stage in a pane with room
  // for both minimums. A phone held sideways fails it, and then this component
  // draws exactly what the app drew before it existed.
  //
  // `sized` is "does the pane own the stage's size": only once somebody has
  // actually moved the divider. Until then the stage keeps its own height rule
  // and the transcript keeps the rest, so the minimums bound a drag rather
  // than silently re-deciding every first render.
  const resizable =
    shape === "expanded" && splitAvailable(container, orientation);
  const sized = resizable && fraction !== null;
  const stagePx = sized
    ? clampSplit({ fraction, container, ...bounds })
    : null;
  /** Where the divider is right now, dragged or not. */
  const dividerAt =
    stagePx ?? (sideBySide ? naturalStage.width : naturalStage.height);

  // Asked of the same function that draws the layout, rather than restated:
  // the toggle offering an arrangement the pane would refuse to draw is the
  // bug this used to have on an empty stage, in the other direction.
  const canSideBySide =
    resolveOrientation("side-by-side", width, shape) === "side-by-side";
  useEffect(() => {
    onSplitStateChange?.({ active: sized, canSideBySide });
  }, [sized, canSideBySide, onSplitStateChange]);

  const dragRef = useRef<{ origin: number; startPx: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const commitFraction = useCallback(
    (next: number, persist: boolean) => {
      onPreferenceChange(
        sideBySide
          ? { ...preference, side: next }
          : { ...preference, stacked: next },
        persist,
      );
    },
    [onPreferenceChange, preference, sideBySide],
  );

  const applyPx = useCallback(
    (px: number, persist: boolean) => {
      const clamped = clampSplit({
        fraction: splitFraction(px, container),
        container,
        ...bounds,
      });
      commitFraction(splitFraction(clamped, container), persist);
    },
    [bounds, commitFraction, container],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizable || event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // From wherever the divider is standing, which on the first drag of a
    // call is the height the stage gave itself.
    dragRef.current = {
      origin: sideBySide ? event.clientX : event.clientY,
      startPx: dividerAt,
    };
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    const moved = (sideBySide ? event.clientX : event.clientY) - drag.origin;
    applyPx(drag.startPx + moved, false);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    dragRef.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const moved = (sideBySide ? event.clientX : event.clientY) - drag.origin;
    applyPx(drag.startPx + moved, true);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!resizable) {
      return;
    }
    const step = event.shiftKey ? CALL_SPLIT_STEP_COARSE_PX : CALL_SPLIT_STEP_PX;
    const grow = sideBySide ? "ArrowRight" : "ArrowDown";
    const shrink = sideBySide ? "ArrowLeft" : "ArrowUp";
    let deltaPx: number | null = null;
    if (event.key === grow) {
      deltaPx = step;
    } else if (event.key === shrink) {
      deltaPx = -step;
    } else if (event.key === "Home") {
      deltaPx = -container;
    } else if (event.key === "End") {
      deltaPx = container;
    }
    if (deltaPx === null) {
      return;
    }
    event.preventDefault();
    commitFraction(
      nudgeSplit({
        fraction: fraction ?? splitFraction(dividerAt, container),
        container,
        orientation,
        deltaPx,
      }),
      true,
    );
  };

  const usable = Math.max(1, container - CALL_SPLIT_DIVIDER_PX);
  const percent = Math.min(100, Math.round((dividerAt / usable) * 100));
  const minPercent = Math.round((bounds.minStage / usable) * 100);
  const maxPercent = Math.round(((usable - bounds.minChat) / usable) * 100);

  return (
    <div
      ref={paneRef}
      data-call-split={resizable ? orientation : "off"}
      data-call-split-sized={sized ? "" : undefined}
      className={cn(
        "flex min-h-0 min-w-0 flex-1",
        sideBySide ? "flex-row" : "flex-col",
      )}
    >
      <div
        ref={stagePaneRef}
        data-call-split-stage=""
        className={cn(
          "flex min-h-0 min-w-0 flex-col",
          // A fullscreen stage takes the pane: the element-fullscreen mode
          // sizes itself `h-full`, and `h-full` of a shrink-to-fit box is
          // zero. Everything else is either the dragged size below or the
          // stage's own height rule, and both want to shrink to fit.
          shape === "fullscreen" ? "flex-1" : "shrink-0",
          sized && "overflow-hidden",
        )}
        style={
          stagePx === null
            ? undefined
            : sideBySide
              ? { width: stagePx }
              : { height: stagePx }
        }
      >
        {stage}
      </div>
      {resizable ? (
        <SplitDivider
          sideBySide={sideBySide}
          dragging={dragging}
          percent={percent}
          minPercent={minPercent}
          maxPercent={maxPercent}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
        />
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

/**
 * The handle.
 *
 * Nobody is going to be told this is draggable, so it says so three times over
 * without a word of copy: it is a raised bar rather than a border, it carries
 * a grip pill in the middle the way every resizable pane in every editor does,
 * and the cursor changes to the resize arrows before the pointer is on it (the
 * hit area is taller than the line it draws). The tooltip is for the fourth
 * kind of person, and for the keyboard: the separator takes focus, and the
 * arrows move it.
 */
function SplitDivider({
  sideBySide,
  dragging,
  percent,
  minPercent,
  maxPercent,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onKeyDown,
}: {
  sideBySide: boolean;
  dragging: boolean;
  percent: number;
  minPercent: number;
  maxPercent: number;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip
      label={t("call.split.resize")}
      detail={t("call.split.hint")}
      side={sideBySide ? "right" : "bottom"}
    >
    <div
      role="separator"
      tabIndex={0}
      data-testid="call-split-divider"
      aria-orientation={sideBySide ? "vertical" : "horizontal"}
      aria-valuenow={percent}
      aria-valuemin={minPercent}
      aria-valuemax={maxPercent}
      aria-valuetext={t("call.split.value", { percent })}
      className={cn(
        // The `::before` is the hit area: 8px is a fine LINE and a poor
        // TARGET, and a thumb on a phone is nowhere near that accurate. It
        // reaches 6px into each neighbour without taking any layout, which is
        // also why the resize cursor appears just before the pointer arrives.
        "group relative flex shrink-0 touch-none select-none items-center justify-center border-y border-ink-4/60 bg-ink-2/70 transition-colors before:absolute before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
        sideBySide
          ? "h-full w-2 cursor-col-resize border-x border-y-0 before:inset-y-0 before:-inset-x-1.5"
          : "h-2 w-full cursor-row-resize before:inset-x-0 before:-inset-y-1.5",
        dragging ? "bg-accent/25" : "hover:bg-ink-3",
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden="true"
        className={cn(
          "rounded-full transition-colors",
          sideBySide ? "h-10 w-1" : "h-1 w-10",
          dragging ? "bg-accent" : "bg-ink-4 group-hover:bg-paper-muted",
        )}
      />
    </div>
    </Tooltip>
  );
}
