/**
 * The set arithmetic behind the message list's multi-select.
 *
 * Out here rather than inside the component because the interesting behaviour
 * is not the rendering: it is what a Shift-click does when the range crosses
 * the cap, and what happens when the anchor has scrolled out of the loaded
 * window. Both are cheap to get wrong and expensive to notice, since either
 * one only shows up as "the server refused a purge the UI said was fine".
 */

export interface ToggleSelectionOptions {
  /** The row a Shift-click ranges from: the last one clicked on its own. */
  anchorId: string | null;
  /** The click held Shift. */
  extend: boolean;
  /** `MESSAGE_BULK_DELETE_MAX`, passed in so this file owns no policy. */
  max: number;
}

/**
 * Toggle one message, or take the range from the anchor when Shift is held.
 *
 * The cap is applied here so the count the bar shows is always a number the
 * server will accept. A range that would cross it stops rather than refusing
 * the whole gesture: the moderator gets the `max` rows nearest the anchor,
 * which is what they were reaching for, instead of nothing.
 *
 * A range never *deselects*. Shift-click means "and everything up to here",
 * and a version that toggled each row in the range would clear a selection the
 * moment somebody swept back over it.
 */
export function toggleMessageSelection(
  selected: ReadonlySet<string>,
  selectableIds: readonly string[],
  messageId: string,
  { anchorId, extend, max }: ToggleSelectionOptions,
): Set<string> {
  const next = new Set(selected);

  if (extend && anchorId && anchorId !== messageId) {
    const from = selectableIds.indexOf(anchorId);
    const to = selectableIds.indexOf(messageId);
    // An anchor that has been paged out of the loaded window has no index. Fall
    // through to a plain toggle rather than ranging from position -1, which
    // would sweep from the top of the window to wherever the click landed.
    if (from !== -1 && to !== -1) {
      const range = selectableIds.slice(
        Math.min(from, to),
        Math.max(from, to) + 1,
      );
      for (const id of range) {
        if (next.size >= max && !next.has(id)) {
          break;
        }
        next.add(id);
      }
      return next;
    }
  }

  if (next.has(messageId)) {
    next.delete(messageId);
  } else if (next.size < max) {
    next.add(messageId);
  }
  return next;
}
