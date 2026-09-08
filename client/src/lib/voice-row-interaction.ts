/**
 * What a click, a double click, or a key on a channel row means, kept as pure
 * decisions so they can be pinned without a DOM: a click always selects,
 * unless the row is already the selected one and joining is on the table, in
 * which case it reads as "no, really, join" (a touch device's stand-in for a
 * double click). A double click always joins when joining is on the table,
 * regardless of prior selection — the guard on `selected` lives in the click
 * branch, not here, so a double click that outraces its own first click's
 * state update still joins exactly once. Enter joins when it can, Space
 * always just selects, matching Discord's own row semantics.
 *
 * `joinable` is `onJoinVoice && !connected` at the call site: no join handler
 * (a text channel), or a channel the caller is already in, and every branch
 * here degrades to "select" or "do nothing" — the same shape a plain text row
 * has always had.
 */
export type VoiceRowAction = "select" | "join" | null;

export function resolveVoiceRowClick(options: {
  selected: boolean;
  joinable: boolean;
}): VoiceRowAction {
  if (options.selected && options.joinable) {
    return "join";
  }
  return "select";
}

export function resolveVoiceRowDoubleClick(options: {
  selected: boolean;
  joinable: boolean;
}): VoiceRowAction {
  // Already selected: the click branch above already joined on the second
  // click of this same double click, so joining again here would fire twice.
  if (!options.selected && options.joinable) {
    return "join";
  }
  return null;
}

export function resolveVoiceRowKey(
  key: string,
  options: { joinable: boolean },
): VoiceRowAction {
  if (key === "Enter") {
    return options.joinable ? "join" : "select";
  }
  if (key === " " || key === "Spacebar") {
    return "select";
  }
  return null;
}
