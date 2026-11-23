/**
 * Where the share popout sits and how big it is (issue #1736).
 *
 * The popout lives inside the CONVERSATION AREA, never over the channel list
 * and never over the composer: the area handed in here is already that box,
 * with the composer's height taken off the bottom by the caller.
 *
 * It rests in one of four corners. Dragging moves it freely, and letting go
 * snaps it to the nearest corner, which is what keeps it out of the middle of
 * the chat and makes the stored position mean something on every window size.
 * The size is stored as a fraction of the area's width for the same reason a
 * call split is (`lib/call-split.ts`): a pixel width is a promise about a
 * window that is wrong the moment the window changes.
 *
 * Pure, with no DOM, so the client suite can pin every rule.
 */

export type PopoutCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const POPOUT_CORNERS: readonly PopoutCorner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

export interface PopoutRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Gap between the popout and the edges of the area. */
export const POPOUT_MARGIN_PX = 12;
/** Below this a share is not legible, whatever the window. */
export const POPOUT_MIN_WIDTH_PX = 240;
/** Past this it is no longer a popout; that is what the theater is for. */
export const POPOUT_MAX_WIDTH_FRACTION = 0.6;
export const POPOUT_DEFAULT_WIDTH_FRACTION = 0.32;
/** A share is 16:9. The header is drawn over the picture, not above it. */
export const POPOUT_ASPECT = 16 / 9;

/**
 * The popout's size inside `area`.
 *
 * Width wins over the stored fraction when the area is too small to honour
 * it, then height wins over width: a popout taller than the area would cover
 * the composer it is meant to stay clear of. On an area too small for the
 * minimum it takes what there is, rather than overflowing.
 */
export function popoutSize(
  area: PopoutRect,
  widthFraction: number,
): { width: number; height: number } {
  const usableWidth = Math.max(0, area.width - 2 * POPOUT_MARGIN_PX);
  const usableHeight = Math.max(0, area.height - 2 * POPOUT_MARGIN_PX);
  const fraction = clampWidthFraction(widthFraction);
  const maxWidth = Math.min(usableWidth, area.width * POPOUT_MAX_WIDTH_FRACTION);
  let width = Math.min(
    Math.max(area.width * fraction, POPOUT_MIN_WIDTH_PX),
    Math.max(maxWidth, Math.min(POPOUT_MIN_WIDTH_PX, usableWidth)),
  );
  let height = width / POPOUT_ASPECT;
  if (height > usableHeight) {
    height = usableHeight;
    width = height * POPOUT_ASPECT;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

/** The popout resting in `corner` of `area`. */
export function popoutRect(
  area: PopoutRect,
  corner: PopoutCorner,
  widthFraction: number,
): PopoutRect {
  const { width, height } = popoutSize(area, widthFraction);
  const left = corner.endsWith("left")
    ? area.left + POPOUT_MARGIN_PX
    : area.left + area.width - POPOUT_MARGIN_PX - width;
  const top = corner.startsWith("top")
    ? area.top + POPOUT_MARGIN_PX
    : area.top + area.height - POPOUT_MARGIN_PX - height;
  return { left: Math.round(left), top: Math.round(top), width, height };
}

/**
 * Keep a popout being dragged inside the area. The pointer can leave it; the
 * picture does not, so it can never be dropped somewhere it cannot be grabbed
 * again.
 */
export function clampToArea(area: PopoutRect, rect: PopoutRect): PopoutRect {
  const maxLeft = area.left + area.width - rect.width;
  const maxTop = area.top + area.height - rect.height;
  return {
    ...rect,
    left: Math.min(Math.max(rect.left, area.left), Math.max(area.left, maxLeft)),
    top: Math.min(Math.max(rect.top, area.top), Math.max(area.top, maxTop)),
  };
}

/** The corner a popout dropped at `rect` snaps to: the nearest by its centre. */
export function nearestCorner(area: PopoutRect, rect: PopoutRect): PopoutCorner {
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const left = centerX < area.left + area.width / 2;
  const top = centerY < area.top + area.height / 2;
  if (top) {
    return left ? "top-left" : "top-right";
  }
  return left ? "bottom-left" : "bottom-right";
}

/** The stored fraction for a popout resized to `widthPx` in `area`. */
export function widthFractionFor(area: PopoutRect, widthPx: number): number {
  if (area.width <= 0) {
    return POPOUT_DEFAULT_WIDTH_FRACTION;
  }
  return clampWidthFraction(widthPx / area.width);
}

export function clampWidthFraction(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0) {
    return POPOUT_DEFAULT_WIDTH_FRACTION;
  }
  return Math.min(fraction, POPOUT_MAX_WIDTH_FRACTION);
}

export type PopoutArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

/**
 * Moving the popout from the keyboard: an arrow sends it to the corner on that
 * side, keeping the other axis. A drag is not the only way to get it out of
 * the way of what somebody is reading.
 */
export function cornerAfterArrow(
  corner: PopoutCorner,
  key: PopoutArrowKey,
): PopoutCorner {
  const vertical = corner.startsWith("top") ? "top" : "bottom";
  const horizontal = corner.endsWith("left") ? "left" : "right";
  switch (key) {
    case "ArrowUp":
      return `top-${horizontal}`;
    case "ArrowDown":
      return `bottom-${horizontal}`;
    case "ArrowLeft":
      return `${vertical}-left`;
    case "ArrowRight":
      return `${vertical}-right`;
  }
}
