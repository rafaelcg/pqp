/**
 * The blocks the channel list draws above its channels (stories, a watch
 * party, the Baú) under the redesign, so the three read as one family.
 *
 * Each string is redesign-only, appended after the classes a block already
 * draws, so the toggle off changes nothing.
 */

/** A card that holds something to look at: a live party, the Baú's newest post. */
export const SIDEBAR_CARD_REDESIGN =
  "redesign:rounded-[var(--sidebar-card-radius)] redesign:border-[color:var(--card-border)] redesign:bg-[color:var(--card-bg)] redesign:hover:border-[color:var(--card-border)] redesign:hover:bg-[color:var(--card-row-hover)]";

/**
 * An invitation to make something (start a party, post the first story or
 * the first Baú post): a dashed outline, no fill until the pointer is on it.
 */
export const SIDEBAR_INVITE_REDESIGN =
  "redesign:rounded-[var(--sidebar-card-radius)] redesign:border-dashed redesign:border-[color:var(--sidebar-invite-border)] redesign:bg-transparent redesign:text-text-secondary redesign:hover:border-[color:var(--sidebar-invite-border)] redesign:hover:bg-row-hover redesign:hover:text-text";

/** A one-line row that opens a block: the list row's pill and fills. */
export const SIDEBAR_ROW_REDESIGN =
  "redesign:rounded-[var(--radius-row)] redesign:px-[var(--list-row-px,0.75rem)] redesign:hover:bg-row-hover";

/** The same row when it is the open one. */
export const SIDEBAR_ROW_SELECTED_REDESIGN = "redesign:bg-row-selected redesign:hover:bg-row-selected";

/**
 * A card in the sidebar's footer (the voice strip, the music player): inset
 * above the user panel on the card tint, so the footer reads as cards, as
 * the blocks above the channels do.
 */
export const SIDEBAR_FOOTER_CARD_REDESIGN =
  "redesign:mx-2 redesign:mb-1.5 redesign:rounded-[var(--sidebar-card-radius)] redesign:border redesign:border-[color:var(--card-border)] redesign:bg-[color:var(--card-bg)]";

/** The same card in the 72px strip, with its narrower margin. */
export const SIDEBAR_FOOTER_CARD_COMPACT_REDESIGN =
  "redesign:mx-1.5 redesign:mb-1.5 redesign:rounded-[var(--sidebar-card-radius)] redesign:border redesign:border-[color:var(--card-border)] redesign:bg-[color:var(--card-bg)]";
