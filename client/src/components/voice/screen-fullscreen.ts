/**
 * Which shared screen, if any, is filling the viewport.
 *
 * WHY THIS EXISTS. Fullscreen used to be a property of *the stage*: one
 * boolean, one container, one button in the call's control bar. That was
 * correct while only one person could share. Two simultaneous shares (PR #59)
 * made the stage a two-up grid, so the one button blew both screens up at once
 * and there was no way to say "just that one" — reported verbatim as "if i
 * press fullscreen it fullscreens the 2 screens at the same time".
 *
 * The fix keeps the *fullscreen element* exactly where it was (the stage) and
 * adds a second, independent thing: which single share is alone on it. That
 * matters more than it looks:
 *
 * - The platform call, the element it targets, the `fullscreenchange` wiring
 *   and the iPhone in-page `expand` fallback are untouched, so the
 *   one-sharer case that is live today behaves byte for byte as before.
 * - Switching from one screen to the other while already fullscreen is pure
 *   state. No second `requestFullscreen`, so nothing stacks on the browser's
 *   fullscreen element stack, nothing needs a fresh user gesture, and there is
 *   no exit-then-re-enter flash.
 *
 * Everything here is a pure function so the interesting part is testable
 * without a DOM that can actually go fullscreen (jsdom cannot).
 */

export interface ScreenFullscreenState {
  /**
   * The stage is filling the viewport: real element fullscreen, or the in-page
   * `expand` fallback. Owned by the browser in `element` mode, which is why it
   * is separate from `soloPeerId` rather than derived from it.
   */
  active: boolean;
  /**
   * The one shared screen alone on the stage. `null` means the whole stage is
   * fullscreen (every share, the camera tiles, the strip), which is what the
   * control bar's own button asks for and what one-sharer calls have always
   * done.
   */
  soloPeerId: string | null;
}

export const NO_SCREEN_FULLSCREEN: ScreenFullscreenState = {
  active: false,
  soloPeerId: null,
};

/** What, if anything, the caller must ask the platform for. */
export type FullscreenRequest = "enter" | "exit" | "none";

export interface ScreenFullscreenTransition {
  next: ScreenFullscreenState;
  request: FullscreenRequest;
}

/**
 * Only one share can fill the viewport. Asking for the one already there means
 * "put it back"; asking for the other one replaces it rather than stacking.
 */
export function nextSoloPeerId(
  current: string | null,
  peerId: string,
): string | null {
  return current === peerId ? null : peerId;
}

/**
 * The fullscreen button on one shared screen.
 *
 * Three outcomes, and the middle one is the point of the change:
 * - not fullscreen -> enter, with that screen alone.
 * - fullscreen showing a *different* screen (or the whole stage) -> swap to
 *   this one with no platform call at all.
 * - fullscreen showing this screen -> leave.
 */
export function toggleScreenFullscreen(
  state: ScreenFullscreenState,
  peerId: string,
): ScreenFullscreenTransition {
  if (!state.active) {
    return { next: { active: true, soloPeerId: peerId }, request: "enter" };
  }
  const solo = nextSoloPeerId(state.soloPeerId, peerId);
  if (solo === null) {
    // Already alone on the stage, so the button is an exit.
    return { next: NO_SCREEN_FULLSCREEN, request: "exit" };
  }
  return { next: { active: true, soloPeerId: solo }, request: "none" };
}

/**
 * The control bar's button: the whole stage, everybody's share included. This
 * is the pre-existing behaviour and the only one a one-sharer call ever sees.
 */
export function toggleStageFullscreen(
  state: ScreenFullscreenState,
): ScreenFullscreenTransition {
  if (state.active) {
    return { next: NO_SCREEN_FULLSCREEN, request: "exit" };
  }
  return { next: { active: true, soloPeerId: null }, request: "enter" };
}

/**
 * The browser is the authority in `element` mode: Escape, the window chrome and
 * a refused request all arrive as `fullscreenchange` and never as a click.
 * Leaving fullscreen by any route drops the solo choice too, so coming back
 * shows the normal grid with every share in it.
 */
export function syncScreenFullscreen(
  state: ScreenFullscreenState,
  active: boolean,
): ScreenFullscreenState {
  if (!active) {
    return state.active || state.soloPeerId !== null
      ? NO_SCREEN_FULLSCREEN
      : state;
  }
  return state.active ? state : { active: true, soloPeerId: state.soloPeerId };
}

/**
 * A presenter can stop sharing while their screen is the one blown up. Without
 * this the stage would stay fullscreen on a peer that has no stream and no
 * tile: a black rectangle with no way back except Escape.
 *
 * Only the solo choice is dropped, not fullscreen itself, because the stage is
 * still worth showing (the other share, the camera tiles) and yanking somebody
 * out of fullscreen is more startling than falling back to the grid.
 */
export function reconcileScreenFullscreen(
  state: ScreenFullscreenState,
  peerIds: readonly string[],
): ScreenFullscreenState {
  if (state.soloPeerId === null || peerIds.includes(state.soloPeerId)) {
    return state;
  }
  return { ...state, soloPeerId: null };
}
