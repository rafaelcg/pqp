/**
 * How wide the channel column is, in CSS pixels, remembered per device.
 *
 * WHY IT IS A PREFERENCE AT ALL. 16rem was picked once and never revisited,
 * and it is wrong at both ends: a QG with `broder-do-role` and
 * `avisos-importantes` truncates every second row, while somebody on a 13"
 * laptop watching a share wants the pixels back and has only the all-or-
 * nothing icons rail to get them with. Dragging the edge is the control every
 * other app with this layout has.
 *
 * PURELY LOCAL, deliberately, for the reason `member-sidebar-preference`
 * gives: it is a statement about a window, not about a person. The same
 * account on a 27" display and on a laptop wants two different numbers, and
 * syncing it would make one of them wrong on every switch.
 *
 * THE MAXIMUM IS TWO NUMBERS, not one. 420px is where the column stops being
 * a list and starts being a second panel. But 420 on a 900px window leaves the
 * transcript 408px after the 72px rail, so the cap is also a fraction of the
 * viewport, and the smaller of the two wins. That is what makes a window
 * resize safe: shrink the window and the stored 420 is clamped down on the
 * spot rather than pushing the chat off screen.
 *
 * THE MINIMUM IS MEASURED, not guessed, and it is 200 rather than the 180 it
 * started at. Channel rows survive 180 happily. `broder-do-role` and
 * `staff-e-cargos` still read in full beside their padlock. What does not is
 * the header: its 36px server icon and three fixed-width buttons leave the
 * server's name about 12px at 180, which renders as nothing at all, and the
 * footer's name and handle collapse to two characters each. At 200 the name
 * is short but present, the handle reads, and every channel row is untouched.
 *
 * NOTHING HERE TOUCHES THE DOM. The clamping, the parsing and the keyboard
 * step maths are the whole of the logic, which is why they live in a module
 * with its own test rather than inside a component.
 */

const STORAGE_KEY = "pqp:channel-sidebar-width";

/** `w-64`, the width the column has always had. Double click resets to it. */
export const CHANNEL_SIDEBAR_DEFAULT_WIDTH = 256;

/** See the header: the narrowest width where the row and the footer still work. */
export const CHANNEL_SIDEBAR_MIN_WIDTH = 200;

/** The absolute cap, before the viewport fraction is applied. */
export const CHANNEL_SIDEBAR_MAX_WIDTH = 420;

/** The other half of the cap. 40% of the window, so the chat always keeps most of it. */
export const CHANNEL_SIDEBAR_MAX_VIEWPORT_FRACTION = 0.4;

/** One arrow key. */
export const CHANNEL_SIDEBAR_STEP = 8;

/** One arrow key with Shift held. */
export const CHANNEL_SIDEBAR_LARGE_STEP = 32;

/**
 * The upper bound for this window. Never below the minimum: on a viewport too
 * narrow for either number the column is a drawer anyway, and returning a
 * maximum under the minimum would make `clamp` incoherent.
 */
export function channelSidebarMaxWidth(viewportWidth?: number): number {
  if (
    typeof viewportWidth !== "number" ||
    !Number.isFinite(viewportWidth) ||
    viewportWidth <= 0
  ) {
    return CHANNEL_SIDEBAR_MAX_WIDTH;
  }
  const share = Math.floor(viewportWidth * CHANNEL_SIDEBAR_MAX_VIEWPORT_FRACTION);
  return Math.max(
    CHANNEL_SIDEBAR_MIN_WIDTH,
    Math.min(CHANNEL_SIDEBAR_MAX_WIDTH, share),
  );
}

/**
 * Any number in, a usable width out. `NaN` and `Infinity` resolve to the
 * default rather than to a bound, because they mean "no answer" rather than
 * "as wide as possible".
 */
export function clampChannelSidebarWidth(
  value: number,
  viewportWidth?: number,
): number {
  const max = channelSidebarMaxWidth(viewportWidth);
  if (!Number.isFinite(value)) {
    return Math.min(max, CHANNEL_SIDEBAR_DEFAULT_WIDTH);
  }
  return Math.min(max, Math.max(CHANNEL_SIDEBAR_MIN_WIDTH, Math.round(value)));
}

/**
 * What a stored string means. Anything that is not a plain finite number falls
 * back to the default: an empty string, `"256px"`, a truncated write, JSON
 * from some future shape of this key.
 */
export function parseStoredChannelSidebarWidth(
  raw: string | null,
  viewportWidth?: number,
): number {
  if (raw === null) {
    return clampChannelSidebarWidth(CHANNEL_SIDEBAR_DEFAULT_WIDTH, viewportWidth);
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return clampChannelSidebarWidth(CHANNEL_SIDEBAR_DEFAULT_WIDTH, viewportWidth);
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return clampChannelSidebarWidth(CHANNEL_SIDEBAR_DEFAULT_WIDTH, viewportWidth);
  }
  return clampChannelSidebarWidth(value, viewportWidth);
}

export function loadChannelSidebarWidth(viewportWidth?: number): number {
  try {
    return parseStoredChannelSidebarWidth(
      localStorage.getItem(STORAGE_KEY),
      viewportWidth,
    );
  } catch {
    // Storage denied (privacy mode, an Electron partition with no quota). The
    // width the column has always had is a working app.
    return clampChannelSidebarWidth(CHANNEL_SIDEBAR_DEFAULT_WIDTH, viewportWidth);
  }
}

export function saveChannelSidebarWidth(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // The drag still works for the rest of the session; only the memory of it
    // is lost. Not worth surfacing.
  }
}

/**
 * What a key on the drag handle means, as a new width or `null` for "not ours".
 *
 * The column is on the left, so ArrowRight grows it and ArrowLeft shrinks it,
 * the direction the edge itself moves. Home and End are the bounds, which is
 * what the ARIA separator pattern says they should be. Shift multiplies the
 * step so crossing the whole range is four presses rather than thirty.
 */
export function channelSidebarWidthForKey(
  key: string,
  options: { current: number; shiftKey?: boolean; viewportWidth?: number },
): number | null {
  const { current, shiftKey = false, viewportWidth } = options;
  const step = shiftKey ? CHANNEL_SIDEBAR_LARGE_STEP : CHANNEL_SIDEBAR_STEP;
  if (key === "ArrowRight") {
    return clampChannelSidebarWidth(current + step, viewportWidth);
  }
  if (key === "ArrowLeft") {
    return clampChannelSidebarWidth(current - step, viewportWidth);
  }
  if (key === "Home") {
    return CHANNEL_SIDEBAR_MIN_WIDTH;
  }
  if (key === "End") {
    return channelSidebarMaxWidth(viewportWidth);
  }
  return null;
}

/** Double click on the handle. The default, clamped to this window. */
export function resetChannelSidebarWidth(viewportWidth?: number): number {
  return clampChannelSidebarWidth(
    CHANNEL_SIDEBAR_DEFAULT_WIDTH,
    viewportWidth,
  );
}
