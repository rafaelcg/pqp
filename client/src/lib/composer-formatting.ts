/**
 * Keyboard formatting for the message composer: Ctrl/Cmd+B and friends wrap
 * the selection in the markdown the bubble actually renders.
 *
 * The composer is a plain textarea, so "bold" here means typing `**` on both
 * sides of the selection, the same thing a person does by hand today. What the
 * shortcuts add is the part that is fiddly by hand: putting both markers in at
 * once, undoing a wrap with the same key (toggle), and leaving the selection on
 * the inner text so a second shortcut stacks (`***bold italic***`).
 *
 * Only markers `message-body.tsx` renders are offered. `remark-gfm` gives us
 * `strong`, `em`, `del` and `code`; there is no underline, and `__text__` is
 * CommonMark's second spelling of bold, so Ctrl+U is deliberately not bound.
 * A shortcut that produced literal underscores would be worse than none.
 *
 * Everything in this file is pure so the unit tests can hit it directly; the
 * composer's keydown handler only decides how to apply the returned edit to
 * the DOM (see `applyFormattingEdit`).
 */

export type FormattingMarker = "**" | "*" | "~~" | "`";

export interface FormattingEdit {
  /** The whole textarea value after the edit. */
  value: string;
  /** Where the selection should land after the edit. */
  selectionStart: number;
  selectionEnd: number;
  /**
   * The smallest span that actually changed, as a replacement of `[replaceStart,
   * replaceEnd)` with `replacement`. The handler applies this span rather than
   * the whole value so the browser records it as one typing step and native
   * undo takes it back on its own.
   */
  replaceStart: number;
  replaceEnd: number;
  replacement: string;
}

/**
 * Count how many of `char` sit immediately before `index` in `value`,
 * or immediately at and after it when `forward` is set.
 */
function runLength(value: string, index: number, char: string, forward: boolean): number {
  let n = 0;
  if (forward) {
    while (value[index + n] === char) n += 1;
  } else {
    while (index - n - 1 >= 0 && value[index - n - 1] === char) n += 1;
  }
  return n;
}

function isHighSurrogate(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Whether a run of `run` marker characters on both sides of the text means the
 * marker is already applied. Bold and italics share the asterisk, so the count
 * matters: `**x**` is bold only, `***x***` is bold and italic, `*x*` is italic
 * only. An odd run always carries italics; a run of two or more always carries
 * bold. Strikethrough and code do not share their character with anything.
 */
function markerPresent(marker: FormattingMarker, run: number): boolean {
  switch (marker) {
    case "*":
      return run % 2 === 1;
    case "**":
      return run >= 2;
    case "~~":
      return run >= 2;
    case "`":
      return run >= 1;
  }
}

/**
 * Wrap the selection in `marker`, or unwrap it when the marker is already
 * there. With no selection, insert the pair and put the caret between them.
 */
export function toggleFormatting(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  marker: FormattingMarker,
): FormattingEdit {
  const len = marker.length;
  const char = marker[0]!;
  let start = Math.max(0, Math.min(selectionStart, selectionEnd, value.length));
  let end = Math.min(value.length, Math.max(selectionStart, selectionEnd));

  // A browser never puts a selection edge between the two halves of a
  // surrogate pair, but a programmatic caller can. Snap outwards rather than
  // split an emoji in two, since a marker between the halves renders as two
  // broken glyphs.
  const caretOnly = start === end;
  if (isLowSurrogate(value, start) && isHighSurrogate(value, start - 1)) start -= 1;
  if (caretOnly) {
    end = start;
  } else if (isLowSurrogate(value, end) && isHighSurrogate(value, end - 1)) {
    end += 1;
  }

  // Caret only. An empty pair the caret is already sitting inside is the
  // result of pressing the shortcut a moment ago with nothing selected, so the
  // same key takes it back out again instead of nesting a second empty pair.
  // The run is counted, not matched exactly, for the same reason as below:
  // the caret inside `****` after Ctrl+B is inside an empty bold pair and
  // not an empty italics pair, so Ctrl+I must add stars there, not strip them.
  if (start === end) {
    const run = Math.min(
      runLength(value, start, char, false),
      runLength(value, start, char, true),
    );
    if (markerPresent(marker, run)) {
      return {
        value: value.slice(0, start - len) + value.slice(start + len),
        selectionStart: start - len,
        selectionEnd: start - len,
        replaceStart: start - len,
        replaceEnd: start + len,
        replacement: "",
      };
    }
    return {
      value: value.slice(0, start) + marker + marker + value.slice(start),
      selectionStart: start + len,
      selectionEnd: start + len,
      replaceStart: start,
      replaceEnd: start,
      replacement: marker + marker,
    };
  }

  // The selection includes the markers themselves (`**word**` selected whole,
  // the natural result of a double-click or Shift+Home). Unwrap in place. An
  // empty pair selected whole (`****`) is the caret case one step later, and
  // comes out the same way: removed, not wrapped in a second pair.
  const selected = value.slice(start, end);
  const innerRun = Math.min(
    runLength(selected, 0, char, true),
    runLength(selected, selected.length, char, false),
  );
  if (selected.length >= 2 * len && markerPresent(marker, innerRun)) {
    const inner = selected.slice(len, selected.length - len);
    return {
      value: value.slice(0, start) + inner + value.slice(end),
      selectionStart: start,
      selectionEnd: start + inner.length,
      replaceStart: start,
      replaceEnd: end,
      replacement: inner,
    };
  }

  // The markers sit just outside the selection: the state a wrap leaves
  // behind, so pressing the same shortcut twice is a no-op overall.
  const outerRun = Math.min(
    runLength(value, start, char, false),
    runLength(value, end, char, true),
  );
  if (markerPresent(marker, outerRun)) {
    return {
      value: value.slice(0, start - len) + selected + value.slice(end + len),
      selectionStart: start - len,
      selectionEnd: start - len + selected.length,
      replaceStart: start - len,
      replaceEnd: end + len,
      replacement: selected,
    };
  }

  // Wrap. Whitespace at either edge is left outside the markers because
  // `** word**` is not bold in CommonMark, and a selection made by dragging
  // usually catches the space after the word.
  const leading = selected.length - selected.trimStart().length;
  const trailing = selected.length - selected.trimEnd().length;
  if (leading + trailing < selected.length) {
    start += leading;
    end -= trailing;
  }
  const inner = value.slice(start, end);
  return {
    value: value.slice(0, start) + marker + inner + marker + value.slice(end),
    selectionStart: start + len,
    selectionEnd: end + len,
    replaceStart: start,
    replaceEnd: end,
    replacement: marker + inner + marker,
  };
}

/** The subset of a keydown event the shortcut table needs. */
export interface ShortcutKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Map a keydown to a marker, or null when the key is not one of ours.
 *
 * Macs use Cmd, everything else Ctrl, and the other one must be up: Ctrl+B on
 * a Mac is Emacs' cursor-left in every text field and Cmd+B on Windows does
 * not exist, so neither should format. Alt is out for the same reason, since
 * Alt+letter types accented characters on several layouts. Shift is part of
 * the strikethrough chord (Discord's Ctrl+Shift+X) and disqualifies the rest.
 */
export function formattingMarkerForKey(
  event: ShortcutKey,
  isMac: boolean,
): FormattingMarker | null {
  const primary = isMac ? event.metaKey : event.ctrlKey;
  const other = isMac ? event.ctrlKey : event.metaKey;
  if (!primary || other || event.altKey) {
    return null;
  }
  const key = event.key.toLowerCase();
  if (event.shiftKey) {
    return key === "x" ? "~~" : null;
  }
  switch (key) {
    case "b":
      return "**";
    case "i":
      return "*";
    case "e":
      return "`";
    default:
      return null;
  }
}

/** Cmd on Apple hardware, Ctrl everywhere else. */
export function isApplePlatform(nav: Pick<Navigator, "platform" | "userAgent"> = navigator): boolean {
  return /Mac|iPhone|iPad|iPod/.test(nav.platform) || /Mac OS X/.test(nav.userAgent);
}

/**
 * Apply an edit to a live textarea in a way the browser's undo stack records.
 *
 * `execCommand("insertText")` is deprecated on paper and universally supported
 * in practice, and it is the only route that both pushes an undo entry and
 * fires an `input` event, which is what lets React's controlled value follow
 * along without a manual `setState`. Where it is missing or refuses (jsdom,
 * some Firefox builds), `setRangeText` makes the same edit; undo history is
 * then browser-dependent, and the caller must sync state from `input.value`
 * itself since no event fires. Returns whether an `input` event was dispatched.
 */
export function applyFormattingEdit(input: HTMLTextAreaElement, edit: FormattingEdit): boolean {
  input.setSelectionRange(edit.replaceStart, edit.replaceEnd);
  let dispatched = false;
  if (typeof document !== "undefined" && typeof document.execCommand === "function") {
    try {
      // `insertText` with an empty string is a no-op in Chromium; removing an
      // empty pair is a delete of the selected range instead.
      dispatched =
        edit.replacement === ""
          ? document.execCommand("delete", false)
          : document.execCommand("insertText", false, edit.replacement);
    } catch {
      dispatched = false;
    }
  }
  if (!dispatched) {
    input.setRangeText(edit.replacement, edit.replaceStart, edit.replaceEnd, "end");
  }
  input.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  return dispatched;
}
