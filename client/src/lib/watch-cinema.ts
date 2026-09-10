/**
 * Cinema layout for a watch party that has gone fullscreen.
 *
 * Native fullscreen still takes the split pane (`[data-call-split]`), because
 * that is the only way the existing transcript can overlay the film without
 * being torn out of the tree. What cinema changes is the LAYOUT inside that
 * pane: the picture fills the screen, the divider goes, and chat is either
 * gone or a hover/hotkey overlay. It does not own a column.
 */

export type WatchCinemaMode = "off" | "element" | "expand" | "video";

/** Element and expand fill a pane we style; the native iPhone player does not. */
export function isWatchCinemaMode(mode: WatchCinemaMode): boolean {
  return mode === "element" || mode === "expand";
}

/** Overlay is only meaningful while cinema owns the pane. */
export function watchCinemaChatOverlay(
  mode: WatchCinemaMode,
  overlay: boolean,
): boolean {
  return isWatchCinemaMode(mode) && overlay;
}

/**
 * Whether a key should toggle the fullscreen chat overlay.
 *
 * `c` like Twitch. Ignored while typing in the composer, and while a modifier
 * is held so browser find/copy shortcuts stay put.
 */
export function shouldToggleWatchChatOverlay(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  target: EventTarget | null;
}): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) {
    return false;
  }
  if (event.key !== "c" && event.key !== "C") {
    return false;
  }
  return !isTypingTarget(event.target);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== "object") {
    return false;
  }
  const el = target as {
    isContentEditable?: boolean;
    tagName?: string;
  };
  if (el.isContentEditable === true) {
    return true;
  }
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
