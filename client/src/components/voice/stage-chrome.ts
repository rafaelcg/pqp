/**
 * When the call stage's controls may leave, and what holds them in place.
 *
 * The timing lives in `hooks/use-idle-chrome.ts` (three idle seconds; any
 * pointer move, key or touch brings the chrome back). This file is the other
 * half, the question the timer cannot answer: is it SAFE to hide right now?
 * Pure, with the reason spelled out, so each rule is a one-line test and a
 * regression says which rule broke instead of "the bar stayed".
 *
 * The rule of thumb is the one every video player follows. Hide only while one
 * stream owns the stage and somebody is plausibly just watching it. In every
 * other case the controls are the interface and they stay.
 */

export interface StageChromeInput {
  /** The person's own switch (`lib/stage-controls-pref.ts`). */
  autoHideSetting: boolean;
  /** The stage is open, not collapsed into the composer's bar. */
  expanded: boolean;
  /**
   * A stream owns the stage: one picture alone (focused, or the only one), or
   * a screen share anywhere on it. False for a grid of cameras, which is
   * people, and for an audio-only call.
   */
  streamOnStage: boolean;
  /**
   * The only picture is this person's own (their share, or their own camera
   * with nobody else publishing). Nothing there is being watched, and the
   * overlay carries what the presenter has to read: that they are live, that
   * sound is going out, and that the uplink is struggling.
   */
  ownPictureOnly: boolean;
}

export type StageChromeHold =
  | "menu-open"
  | "share-picker-open"
  | "pointer-over-controls"
  | "keyboard-focus-in-controls"
  | "push-to-talk-held"
  | "not-connected"
  | "error"
  | "notice"
  | "peer-failed";

export interface StageChromeHoldInput {
  /** A menu or popover hung off the bar (video quality, stream settings). */
  menuOpen: boolean;
  /** The browser's screen picker is up, which takes the pointer with it. */
  sharePickerOpen: boolean;
  /** The pointer is on the bar, the way back to the grid, or a top control. */
  pointerOverControls: boolean;
  /**
   * Keyboard focus is on a control. NOT plain focus: a mouse click leaves a
   * button focused for as long as nothing else is, and holding the bar for
   * that is how a bar that had been used once never went away again.
   */
  keyboardFocusInControls: boolean;
  pushToTalkHeld: boolean;
  /** False while joining, or in anything else that is not a live call. */
  connected: boolean;
  error: boolean;
  /** A line in the notice bar, which is where "reconnecting" is said. */
  notice: boolean;
  /** Somebody's connection failed and the stage is offering a retry. */
  peerFailed: boolean;
}

/**
 * Whether the stage is a place where controls may fade at all.
 *
 * False for a grid of cameras (more than one picture, none a share), nothing on stage, a collapsed
 * stage and an audio-only call: there the controls are the thing being used.
 */
export function stageChromeMayHide(input: StageChromeInput): boolean {
  return (
    input.autoHideSetting &&
    input.expanded &&
    input.streamOnStage &&
    !input.ownPictureOnly
  );
}

/** The first thing keeping the controls up right now, or null when nothing is. */
export function stageChromeHold(
  input: StageChromeHoldInput,
): StageChromeHold | null {
  if (input.menuOpen) {
    return "menu-open";
  }
  if (input.sharePickerOpen) {
    return "share-picker-open";
  }
  if (input.pointerOverControls) {
    return "pointer-over-controls";
  }
  if (input.keyboardFocusInControls) {
    return "keyboard-focus-in-controls";
  }
  if (input.pushToTalkHeld) {
    return "push-to-talk-held";
  }
  if (!input.connected) {
    return "not-connected";
  }
  if (input.error) {
    return "error";
  }
  if (input.notice) {
    return "notice";
  }
  if (input.peerFailed) {
    return "peer-failed";
  }
  return null;
}

/**
 * Whether a focus event is keyboard focus. `:focus-visible` is the browser's
 * own answer: false for a button a mouse just pressed, true for a Tab or an
 * arrow key. An engine that does not know the selector throws, and the safe
 * answer for an accessibility rule is yes.
 */
export function isKeyboardFocus(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  try {
    return target.matches(":focus-visible");
  } catch {
    return true;
  }
}

/**
 * The state a person must not miss while the controls are gone. A change in
 * any of these wakes them for one idle period: you were muted by a moderator,
 * somebody arrived or left, a hand went up. A hotkey mute is the same case:
 * pressed with the bar faded, it would otherwise change nothing anywhere.
 */
export function stageChromeAttentionKey(input: {
  isMuted: boolean;
  isDeafened: boolean;
  serverMuted: boolean;
  canSpeak: boolean;
  peerCount: number;
  handsUp: number;
}): string {
  return [
    input.isMuted ? "m" : "-",
    input.isDeafened ? "d" : "-",
    input.serverMuted ? "s" : "-",
    input.canSpeak ? "t" : "-",
    input.peerCount,
    input.handsUp,
  ].join("|");
}
