/**
 * The header across the top of a pane under the redesign: the chat, a
 * forum, the Baú, friends, Novidades on a phone, and the loading skeleton
 * all draw it, so the seven headers read as one.
 *
 * Every string is redesign-only and goes after the classes a header always
 * drew, so the toggle off changes nothing. Each header keeps its own markup
 * (what sits in it differs too much to be one component); what is shared is
 * the bar, the title, the line under or beside it, and the action tiles.
 */

/**
 * The bar: 56px, a faint rule of the text under it, the pane's inset. The
 * rule only shows where the header draws a base `border-b`; the forum leaves
 * it off on purpose, a quiet bar over its own large title.
 */
export const PANE_HEADER_REDESIGN =
  "redesign:h-14 redesign:gap-2 redesign:border-[color:var(--pane-header-rule)] redesign:px-[var(--pane-header-px)]";

/** The title: the display face at 16px in the text colour. */
export const PANE_HEADER_TITLE_REDESIGN =
  "redesign:text-[length:var(--pane-bar-title-size)] redesign:text-text";

/** The topic, the count or the members line: 13px secondary text. */
export const PANE_HEADER_DETAIL_REDESIGN = "redesign:text-[13px] redesign:text-text-secondary";

/**
 * An icon action in a header (pins, settings, members, a call): a 36px round
 * tile in the row's icon colour, a tint of the text on hover.
 */
export const PANE_HEADER_ACTION_REDESIGN =
  "redesign:h-9 redesign:w-9 redesign:max-sm:h-11 redesign:max-sm:w-11 redesign:rounded-full redesign:text-[color:var(--list-row-icon)] redesign:hover:bg-[color:var(--list-row-hover)] redesign:hover:text-text redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-accent redesign:focus-visible:ring-offset-2 redesign:focus-visible:ring-offset-pane-main";

/**
 * The same tile while its panel is open (the member list): the selected
 * row's fill, so it never reads as a hovered tile.
 */
export const PANE_HEADER_ACTION_ON_REDESIGN =
  "redesign:bg-[color:var(--list-row-selected)] redesign:text-[color:var(--list-row-selected-text)] redesign:hover:bg-[color:var(--list-row-selected)] redesign:hover:text-[color:var(--list-row-selected-text)]";

/** The phone's "open the navigation" button at a header's start. */
export const PANE_HEADER_NAV_REDESIGN = `${PANE_HEADER_ACTION_REDESIGN} redesign:flex redesign:items-center redesign:justify-center redesign:p-0`;
