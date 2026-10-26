/**
 * A card: a bounded group inside a pane or a dialog (a bot's summary, a list
 * of checks, an empty note, a pinned preview). Not a popover: a card sits
 * in the page and does not float.
 *
 * Only the surface is shared; the element (a `div`, a `ul`, a `section`)
 * and the padding are the caller's, passed beside it through `cn`.
 *
 * With the toggle off it is the card every caller drew: the card radius, the
 * plain border, `surface-card`. Under the redesign its fill and edge are
 * tints of the text, so the same card reads on a pane and on a dialog,
 * whatever their surface (as the buttons' fills do). A list inside it
 * takes `CARD_LIST` beside it, so its rules take the same edge, which the
 * plain border colour would lose on a dialog.
 */
export const CARD_SURFACE =
  "rounded-[var(--radius-card)] border border-[color:var(--card-border,var(--color-border))] bg-[color:var(--card-bg,var(--color-surface-card))]";

/**
 * A card holding a list of rows: a rule between rows in the card's edge
 * (the plain border with the toggle off), clipped to the corners.
 */
export const CARD_LIST =
  "divide-y divide-[color:var(--card-border,var(--color-border))] overflow-hidden";
