/**
 * The music queue under the redesign: one recipe for the queue's rows, the
 * history's rows and the search results, in the composer's sheet and in the
 * drawer alike. With the toggle off none of these classes apply, and each
 * row keeps its `composer` or `rail` tone.
 */

/** A row: the control radius (a pill would fight the square cover), the list row's hover. */
export const MUSIC_ROW_REDESIGN =
  "redesign:rounded-[var(--radius-control)] redesign:px-1.5 redesign:hover:bg-[color:var(--list-row-hover)]";

/** The highlighted search result, on the menu's highlight. */
export const MUSIC_ROW_HIGHLIGHT_REDESIGN = "redesign:bg-[color:var(--menu-row-hover)]";

/** A cover: nested inside the row's corner, on the card's fill while it loads. */
export const MUSIC_COVER_REDESIGN =
  "redesign:rounded-[calc(var(--radius-control)-4px)] redesign:bg-[color:var(--card-bg)]";

/** A small icon button in the panel: a round ghost. */
export const MUSIC_ICON_REDESIGN =
  "redesign:rounded-full redesign:text-text-secondary redesign:hover:bg-[color:var(--button-ghost-hover)] redesign:hover:text-text";

/** A heading over a group ("Fila · 3", "Histórico"): sentence case, 13px semibold. */
export const MUSIC_LABEL_REDESIGN =
  "redesign:text-[13px] redesign:font-semibold redesign:normal-case redesign:tracking-normal redesign:text-text-secondary";

/** Body text and secondary text in the drawer, which is on the paper tokens with the toggle off. */
export const MUSIC_TEXT_REDESIGN = "redesign:text-text";
export const MUSIC_MUTED_REDESIGN = "redesign:text-text-secondary";
