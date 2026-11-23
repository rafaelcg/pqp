/**
 * Where a call's picture is drawn when `share_popout` is on (issue #1736).
 *
 * Three states, and the person moves between them:
 *
 * - `popout`: one picture floats in a corner of the conversation area and the
 *   chat keeps the whole pane. The default, and the state a call starts in.
 * - `theater`: the picture fills the conversation area, as a grid when several
 *   shares are being watched. Only ever drawn in the call's own channel.
 * - `hidden`: the person closed the popout. The call carries on in the dock;
 *   choosing something to watch brings the popout back.
 *
 * Pure, and kept apart from the components, because every rule here is a bug
 * with a visible shape (a theater drawn over somebody else's channel, a popout
 * that comes back by itself after being closed) and the client suite runs in
 * node with no DOM.
 */

export type ShareViewMode = "popout" | "theater" | "hidden";

export type ShareViewEvent =
  /** The maximize button, or a double click on the popout. */
  | { type: "maximize" }
  /** The minimize button in the theater. */
  | { type: "minimize" }
  /** Escape. Leaves the theater; does nothing to a popout. */
  | { type: "escape" }
  /** The popout's close button. */
  | { type: "close" }
  /** The person chose something to watch ("Assistir", the switcher). */
  | { type: "watch" }
  /** The call ended, or a new one started: start over. */
  | { type: "call-changed" };

export const INITIAL_SHARE_VIEW_MODE: ShareViewMode = "popout";

export function nextShareViewMode(
  mode: ShareViewMode,
  event: ShareViewEvent,
): ShareViewMode {
  switch (event.type) {
    case "maximize":
      return "theater";
    case "minimize":
      return mode === "theater" ? "popout" : mode;
    case "escape":
      return mode === "theater" ? "popout" : mode;
    case "close":
      return "hidden";
    case "watch":
      // Choosing a share from the theater keeps the theater: it is already
      // showing every share the person watches.
      return mode === "theater" ? "theater" : "popout";
    case "call-changed":
      return INITIAL_SHARE_VIEW_MODE;
  }
}

/**
 * Whether this call uses the popout at all, or the stage split as before.
 *
 * The flag is per server. A narrow window keeps today's layout, because a
 * floating picture over a phone-width chat covers the very thing it is meant
 * to leave free. A watch party has its own stage and is out of scope.
 */
export function sharePopoutApplies(input: {
  flagOn: boolean;
  /** The `lg` breakpoint (`useLgUp`). */
  wide: boolean;
  isWatchPartyChannel: boolean;
}): boolean {
  return input.flagOn && input.wide && !input.isWatchPartyChannel;
}

/** What is actually drawn, given the mode and where the person is. */
export type SharePopoutPlacement = "none" | "floating" | "theater";

export function sharePopoutPlacement(input: {
  mode: ShareViewMode;
  /** The person is looking at the call's own channel or DM. */
  viewingCallChannel: boolean;
  /** `popoutTarget` found something to show. */
  hasTarget: boolean;
}): SharePopoutPlacement {
  if (input.mode === "hidden" || !input.hasTarget) {
    return "none";
  }
  // The theater fills the conversation area of the call's channel. Walking off
  // to another channel must not drag a full-size picture over that one, so
  // the picture goes back to floating; coming back finds the theater again.
  if (input.mode === "theater" && input.viewingCallChannel) {
    return "theater";
  }
  return "floating";
}
