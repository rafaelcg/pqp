/**
 * The minimal shape `scrollIntoView` needs — just the method, not a real
 * `Element` — so this can be exercised with a plain spy in a `node` test
 * environment that has no DOM.
 */
export interface ScrollTarget {
  scrollIntoView(options?: ScrollIntoViewOptions): void;
}

/**
 * Scrolls the newly selected row into view, the fix for the slash / mention /
 * emoji menus: the highlighted row used to move without the scroller
 * following, so arrowing past the last visible row kept moving a selection
 * nobody could see.
 *
 * Only fires when the selection actually moved — a hover landing on the row
 * it is already over, or a re-render that changes nothing else, must not
 * re-trigger a scroll. `block: "nearest"` (never `"center"` or `"start"`) is
 * what keeps a row that is already fully visible from being yanked to an
 * edge, which is what made this worth a named option rather than a bare call.
 */
export function scrollSelectionIntoView(
  targets: readonly (ScrollTarget | null | undefined)[],
  previousIndex: number,
  nextIndex: number,
): void {
  if (previousIndex === nextIndex) {
    return;
  }
  targets[nextIndex]?.scrollIntoView({ block: "nearest" });
}
