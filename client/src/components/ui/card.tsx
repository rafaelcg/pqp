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
 * whatever their surface (as the buttons' fills do).
 */
export const CARD_SURFACE =
  "rounded-[var(--radius-card)] border border-[color:var(--card-border,var(--color-border))] bg-[color:var(--card-bg,var(--color-surface-card))]";
