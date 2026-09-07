/**
 * How much of the pane the call stage gets, and which way the two panes sit.
 *
 * WHY THIS EXISTS. The stage used to be `h-[68svh]` and the transcript got
 * whatever was left, which on a laptop is four or five lines. In a 510-member
 * community that is the whole chat during a share: the picture is the reason
 * everyone is there, and the room talking about it is squeezed into a slot.
 * Neither number is right for everybody, so the number stops being ours.
 *
 * TWO SHAPES, ONE STATE. Stacked is the stage above the transcript with a
 * horizontal divider; side by side is the stage beside it with a vertical one.
 * Each keeps its own fraction, because "60% tall" and "60% wide" are different
 * opinions and a shared number makes the second switch feel broken.
 *
 * FRACTIONS, NOT PIXELS. A stored pixel height is a promise about a window
 * size, and it is wrong the moment the window is resized, a share opens the
 * roster, or the same account signs in on a laptop. A fraction survives all
 * three; the pixel minimums below are re-applied against the live container on
 * every render, so a fraction can never produce an unusable pane.
 *
 * THE MINIMUMS ARE THE POINT. A divider you can drag until one side is a
 * sliver is a divider that can strand somebody, so `clampSplit` refuses.
 * Below `splitAvailable` there is not enough room for both minimums at all, and
 * then the split is not offered: the stage keeps its old height rule and the
 * transcript keeps what is left, which is exactly today's phone-landscape
 * layout.
 */

export type CallSplitOrientation = "stacked" | "side-by-side";

/**
 * What the call surface currently is, reported up by the stage itself.
 *
 * The pane cannot work this out on its own: "expanded" depends on whether
 * anybody is publishing AND on a collapse the person toggled inside the stage.
 * Only `expanded` is split, because only `expanded` is a picture with a size
 * worth arguing about. A slim bar has no height to give, and a fullscreen
 * stage has already taken the window.
 */
export type CallStageShape = "none" | "compact" | "expanded" | "fullscreen";

export interface CallSplitPreference {
  orientation: CallSplitOrientation;
  /**
   * The stage's share of the pane's HEIGHT while stacked, 0..1, or NULL for
   * "nobody has moved it".
   *
   * Null is not a number in disguise. The stage's old rule was `68svh` — a
   * fraction of the *window*, not of the pane — and no fraction of the pane
   * reproduces it at every window height, because the chrome above the pane
   * (the channel header, and in a dev build the bypass banner) is a fixed
   * number of pixels rather than a share. So an unmoved divider does not size
   * the stage at all: the stage keeps the rule it has always had, and the
   * transcript keeps what is left. Nothing about the first render of a call
   * changes on the day this ships.
   *
   * It also puts the minimums where they belong. They exist to stop a DRAG
   * producing an unusable pane, and applying them to a layout nobody chose
   * would be this feature quietly re-deciding the default for everybody.
   */
  stacked: number | null;
  /**
   * The stage's share of the pane's WIDTH while side by side, 0..1.
   *
   * Never null, because side by side has no older behaviour to preserve: the
   * arrangement did not exist, so it has to start somewhere, and a stage a bit
   * wider than the transcript is what a shared screen wants.
   */
  side: number;
}

export const CALL_SPLIT_DEFAULT: CallSplitPreference = {
  orientation: "stacked",
  stacked: null,
  side: 0.62,
};

/** A stage shorter than this is a letterbox, not a picture. */
export const MIN_STAGE_HEIGHT_PX = 160;

/**
 * The composer is about 90px and a conversation you can follow needs a few
 * lines above it. Under this the transcript is decoration.
 */
export const MIN_CHAT_HEIGHT_PX = 220;

/** A 16:9 tile narrower than this stops being watchable. */
export const MIN_STAGE_WIDTH_PX = 320;

/**
 * Wide enough for the composer, which is what actually sets this number.
 *
 * A phone's 390px is NOT the floor here, even though the transcript is
 * designed for it: the composer's row (Aa, attach, emoji, poll, GIF, the box,
 * Send) drops its buttons below `sm:`, and `sm:` is a media query about the
 * WINDOW. Beside a call on a laptop the window is wide and the column is not,
 * so the desktop composer renders into a phone-width box and the message input
 * is squeezed to a few pixels between the GIF button and Send. About 370 of
 * that row is fixed furniture; 560 leaves the box a readable ~180.
 *
 * The honest consequence, and the reason the number is not fudged down: on a
 * 1440 laptop with the roster open there is no room for a video beside a real
 * transcript, so side by side is not offered there. Close the roster, collapse
 * the channel list, or use a wider monitor and it comes back.
 */
export const MIN_CHAT_WIDTH_PX = 560;

/** The divider's own thickness, counted against the pane before splitting. */
export const CALL_SPLIT_DIVIDER_PX = 8;

/** One arrow-key press. Shift multiplies it; see `CALL_SPLIT_STEP_COARSE_PX`. */
export const CALL_SPLIT_STEP_PX = 16;
export const CALL_SPLIT_STEP_COARSE_PX = 64;

export interface SplitBounds {
  minStage: number;
  minChat: number;
}

export function splitBounds(orientation: CallSplitOrientation): SplitBounds {
  return orientation === "side-by-side"
    ? { minStage: MIN_STAGE_WIDTH_PX, minChat: MIN_CHAT_WIDTH_PX }
    : { minStage: MIN_STAGE_HEIGHT_PX, minChat: MIN_CHAT_HEIGHT_PX };
}

/**
 * Whether a pane of this size can hold both minimums plus the divider.
 *
 * False is not a failure: it is a phone in landscape, or a window dragged
 * short. The caller then draws the un-split layout it always drew, and no
 * divider is offered, because a divider with nowhere to go is a control that
 * lies.
 */
export function splitAvailable(
  container: number,
  orientation: CallSplitOrientation,
): boolean {
  const { minStage, minChat } = splitBounds(orientation);
  return (
    Number.isFinite(container) &&
    container >= minStage + minChat + CALL_SPLIT_DIVIDER_PX
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * The stage's size in pixels: the stored fraction of the pane, then forced
 * inside the minimums.
 *
 * `container` is the whole pane INCLUDING the divider, so the arithmetic here
 * is the same number the browser will lay out. When the pane cannot hold both
 * minimums the two share what there is in the ratio the minimums ask for,
 * which keeps both panes visible instead of picking a winner.
 */
export function clampSplit(input: {
  fraction: number;
  container: number;
  minStage: number;
  minChat: number;
}): number {
  const { minStage, minChat } = input;
  const container = Number.isFinite(input.container) ? input.container : 0;
  if (container <= 0) {
    return 0;
  }
  const usable = Math.max(0, container - CALL_SPLIT_DIVIDER_PX);
  const maxStage = usable - minChat;
  if (maxStage <= minStage) {
    return Math.round((usable * minStage) / (minStage + minChat));
  }
  const desired = Math.round(usable * clamp01(input.fraction));
  return Math.min(Math.max(desired, minStage), maxStage);
}

/** A dragged or nudged pixel size, back to the fraction that gets stored. */
export function splitFraction(sizePx: number, container: number): number {
  const usable = Math.max(0, container - CALL_SPLIT_DIVIDER_PX);
  if (usable <= 0) {
    return 0.5;
  }
  return clamp01(sizePx / usable);
}

/**
 * Keyboard resize. `delta` is in pixels, positive meaning "give the stage
 * more", and the result is clamped by the same rule the pointer obeys, so the
 * two paths cannot disagree about where the ends are.
 */
export function nudgeSplit(input: {
  fraction: number;
  container: number;
  orientation: CallSplitOrientation;
  deltaPx: number;
}): number {
  const bounds = splitBounds(input.orientation);
  const current = clampSplit({
    fraction: input.fraction,
    container: input.container,
    ...bounds,
  });
  const next = clampSplit({
    fraction: splitFraction(current + input.deltaPx, input.container),
    container: input.container,
    ...bounds,
  });
  return splitFraction(next, input.container);
}

/**
 * The orientation actually drawn. Side by side is a claim about width, so a
 * pane that cannot hold two columns falls back to stacked without touching
 * what was stored: widen the window and the choice comes back.
 */
export function resolveOrientation(
  preferred: CallSplitOrientation,
  paneWidth: number,
): CallSplitOrientation {
  if (preferred !== "side-by-side") {
    return "stacked";
  }
  return splitAvailable(paneWidth, "side-by-side") ? "side-by-side" : "stacked";
}

const STORAGE_KEY = "pqp:call-split";

/**
 * PURELY LOCAL, the call `member-sidebar-preference` already makes: "the
 * picture should be two thirds of THIS monitor" describes a window, not a
 * person, and syncing it would be wrong on the other machine every time.
 */
export function loadCallSplit(): CallSplitPreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return CALL_SPLIT_DEFAULT;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return CALL_SPLIT_DEFAULT;
    }
    const value = parsed as Partial<Record<keyof CallSplitPreference, unknown>>;
    return {
      orientation:
        value.orientation === "side-by-side" ? "side-by-side" : "stacked",
      stacked:
        typeof value.stacked === "number" && Number.isFinite(value.stacked)
          ? clamp01(value.stacked)
          : null,
      side:
        typeof value.side === "number" && Number.isFinite(value.side)
          ? clamp01(value.side)
          : CALL_SPLIT_DEFAULT.side,
    };
  } catch {
    // Denied storage, or somebody's half-written JSON. The default split is a
    // working call; a thrown reader is a white screen.
    return CALL_SPLIT_DEFAULT;
  }
}

export function saveCallSplit(preference: CallSplitPreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // The drag still works for this session; only the memory of it is lost.
  }
}
