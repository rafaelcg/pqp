/**
 * The two widths the signed-in app changes layout at, written once.
 *
 * They are Tailwind's `sm` (40rem) and `md` (48rem), in rem as Tailwind writes
 * them, so a query here and a `sm:` or `md:` utility switch at the same width
 * even when the browser's base font size is not 16px. A "below" query stops at
 * `.999` so it never overlaps its "from" query at the line itself.
 *
 * CSS cannot import these; a media query in a stylesheet writes the same
 * value (`39.999rem`, `40rem`, `47.999rem`, `48rem`) and names this file.
 */

/** Tailwind's `sm` and up: the settings rail stands as a column, a story plays framed. */
export const SM_UP_QUERY = "(min-width: 40rem)";

/** Below `sm`: a narrow phone. */
export const BELOW_SM_QUERY = "(max-width: 39.999rem)";

/** Tailwind's `md` and up: the desktop shell. */
export const MD_UP_QUERY = "(min-width: 48rem)";

/** Below `md`: the phone layout. Must match the `md:` utilities. */
export const BELOW_MD_QUERY = "(max-width: 47.999rem)";

/** Tailwind's `lg` and up: room for a third column beside the conversation. */
export const LG_UP_QUERY = "(min-width: 64rem)";
