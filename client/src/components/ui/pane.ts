/**
 * The app frame under the redesign (direction B, Salas): the rail sits on a
 * dark canvas, and the sidebar, the conversation and the right column are
 * rounded panes floating on it with a gutter between them.
 *
 * Each string is redesign-only, appended after the classes a pane already
 * draws, so the toggle off changes nothing. From `md` up the panes float;
 * below it the sidebar and the right column are drawers and keep their
 * edges, and the gutter is zero (`--space-gutter`).
 */

/** The app's root row: the canvas, and the gutter around the panes. */
export const FRAME_REDESIGN =
  "redesign:bg-canvas md:redesign:gap-[var(--space-gutter)] md:redesign:py-[var(--space-gutter)] md:redesign:pr-[var(--space-gutter)]";

/** A row of panes inside the frame: the same gutter between them. */
export const PANE_ROW_REDESIGN = "md:redesign:gap-[var(--space-gutter)]";

/** The server rail: on the canvas itself, no edge. A drawer on a phone. */
export const RAIL_REDESIGN =
  "redesign:border-r-0 redesign:bg-canvas md:redesign:bg-transparent";

/** The sidebar and the right column. */
export const PANE_SIDE_REDESIGN =
  "redesign:bg-pane-side md:redesign:rounded-[var(--radius-pane)] md:redesign:border-0";

/** The conversation: the brightest pane, clipped to its corners. */
export const PANE_MAIN_REDESIGN =
  "redesign:bg-pane-main md:redesign:overflow-clip md:redesign:rounded-[var(--radius-pane)]";

/**
 * A pane docked inside the conversation (a forum post open beside its list):
 * its own rounded pane, inset by the gutter, on the side panes' colour.
 */
export const PANE_INSET_REDESIGN =
  "md:redesign:my-[var(--space-gutter)] md:redesign:mr-[var(--space-gutter)] md:redesign:h-auto md:redesign:rounded-[calc(var(--radius-pane)-var(--space-gutter))] md:redesign:border-0 md:redesign:bg-pane-side md:redesign:overflow-clip";
