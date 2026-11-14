import { POPOVER_SURFACE } from "@/components/ui/popover";

/**
 * A toast: a short note that arrives on its own (a DM, a friend who accepted,
 * a forwarded message, a session about to start) and leaves on its own.
 *
 * Only the look is shared. Each toast keeps its own corner, queue, timer and
 * swipe, because each has its own reason to be where it is; unifying that is
 * a behaviour change with its own tests, not a look.
 *
 * A toast floats above the app like a popover, so its card is the popover's
 * surface: with the toggle off the level-3 card every toast already drew,
 * under the redesign the pane radius, the raised fill, a faint edge and the
 * lift.
 */
export const TOAST_SURFACE = POPOVER_SURFACE;

/**
 * For a toast that draws its own card with the toggle off (the session
 * reminders' `ink-2`, the watch party's `surface-2`): under the redesign it
 * becomes the same card as every other toast.
 */
export const TOAST_SURFACE_REDESIGN =
  "redesign:rounded-[var(--popover-radius)] redesign:border-[color:var(--popover-border)] redesign:bg-[color:var(--popover-surface)] redesign:shadow-[var(--popover-shadow)]";

/**
 * The dismiss button's redesign half alone: IconButton's round ghost and its
 * focus ring. For a dismiss button that drew a different square with the
 * toggle off (the watch party approval's smaller one).
 */
export const TOAST_CLOSE_REDESIGN =
  "redesign:rounded-[var(--icon-button-radius)] redesign:text-[color:var(--icon-button-text)] redesign:hover:bg-[color:var(--icon-button-hover)] redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-[color:var(--icon-button-ring,var(--color-focus-ring))] redesign:focus-visible:ring-offset-[length:var(--icon-button-ring-offset)] redesign:focus-visible:ring-offset-[color:var(--icon-button-ring-offset-color)]";

/**
 * A toast that opens something when clicked as a whole (a DM, a session
 * reminder): under the redesign its button shows the same focus ring as the
 * dismiss button beside it, inside the card's corner.
 */
export const TOAST_OPEN_REDESIGN =
  "redesign:rounded-[var(--radius-control)] redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-[color:var(--icon-button-ring,var(--color-focus-ring))]";

/**
 * The dismiss button in a toast's corner. With the toggle off the small
 * square it always was; under the redesign IconButton's round ghost, with its
 * focus ring.
 */
export const TOAST_CLOSE = `flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-text-tertiary hover:bg-surface-2 hover:text-text ${TOAST_CLOSE_REDESIGN}`;
