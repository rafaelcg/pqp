/**
 * Keystrokes typed while a deferred dialog's chunk is still on its way.
 *
 * Ctrl/Cmd+K is handled by the always-loaded shell, which opens the quick
 * switcher at once; the switcher itself is a separate chunk, so for a moment
 * after load there is no input to receive what the person types next ("bora"
 * right after the chord). While the chunk is pending a tiny capture holds the
 * printable keys (and Backspace) here, and the dialog starts with them in its
 * field when it mounts. Nothing here knows about any one dialog.
 */

/** Longest buffer kept; a held key on a slow connection must not grow forever. */
const MAX_LENGTH = 200;

let buffer = "";

/** Apply one keydown to the buffer. True when the key was consumed. */
export function captureTypeAheadKey(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
    return false;
  }
  if (event.key === "Backspace") {
    buffer = buffer.slice(0, -1);
    return true;
  }
  // A printable character is exactly one code point; named keys ("Enter",
  // "ArrowDown", "Shift") are longer and are not held.
  if ([...event.key].length === 1) {
    buffer = (buffer + event.key).slice(0, MAX_LENGTH);
    return true;
  }
  return false;
}

/** What was typed while waiting, once; the buffer is empty afterwards. */
export function takeTypeAhead(): string {
  const held = buffer;
  buffer = "";
  return held;
}

export function clearTypeAhead(): void {
  buffer = "";
}
