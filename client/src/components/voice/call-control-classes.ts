/**
 * The call bar's round controls under the redesign (`docs/DESIGN.md`,
 * "The call"). Appended after each control's own classes, so with the toggle
 * off the bar draws exactly what it drew before and with it on these win.
 */
export const CALL_CONTROL_REDESIGN = {
  /** Every control: the keyboard ring, offset from the well. */
  base: "redesign:transition-colors redesign:duration-[var(--duration-fast)] redesign:ease-[var(--ease-standard)] motion-reduce:redesign:transition-none redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-offset-2 redesign:focus-visible:ring-offset-[color:var(--call-bar-bg)] redesign:focus-visible:ring-[color:var(--color-focus-ring)]",
  /** At rest: a quiet well on a text tint. */
  idle: "redesign:bg-[color:var(--call-control-bg)] redesign:text-text redesign:hover:bg-[color:var(--call-control-hover)] redesign:data-[state=open]:bg-[color:var(--call-control-hover)]",
  /** At rest in the composer's dock: a ghost beside the composer's icons. */
  dock: "redesign:bg-transparent redesign:text-text-secondary redesign:hover:bg-[color:var(--call-control-hover)] redesign:hover:text-text redesign:focus-visible:bg-[color:var(--call-control-hover)] redesign:focus-visible:ring-offset-0 redesign:data-[state=open]:bg-[color:var(--call-control-hover)] redesign:data-[state=open]:text-text",
  /** On (camera, share, music open, a raised hand): the soft accent. */
  on: "redesign:bg-[color:var(--call-control-on-bg)] redesign:text-[color:var(--call-control-on-text)] redesign:hover:bg-[color:var(--call-control-on-hover)]",
  /** A muted mic: the soft danger. */
  off: "redesign:bg-[color:var(--call-control-off-bg)] redesign:text-danger redesign:hover:bg-[color:var(--call-control-off-hover)]",
  /** Muted by a moderator: the soft warning, not the person's to lift. */
  warn: "redesign:bg-[color:var(--call-control-warn-bg)] redesign:hover:bg-[color:var(--call-control-warn-hover)] redesign:text-warning",
  /** The hang-up: the one solid red on the bar. */
  leave: "redesign:bg-danger redesign:text-on-danger redesign:hover:bg-[color:var(--call-leave-hover)]",
  /** The dot on a control (music playing unheard, NOVO): ringed in the bar's own fill. */
  pip: "redesign:ring-[color:var(--call-bar-bg)]",
  /** The same dot docked in the composer: ringed in the composer's fill. */
  pipDock: "redesign:ring-[color:var(--call-dock-pip-ring)]",
} as const;

/** The floating bar on the open stage: a popover's surface, edge and lift. */
export const CALL_BAR_REDESIGN =
  "redesign:bg-[color:var(--call-bar-bg)] redesign:ring-[color:var(--call-bar-border)] redesign:shadow-[var(--call-bar-shadow)] redesign:backdrop-blur-none";

/**
 * What floats on a picture (a name, "⋯", fullscreen): a dark glass pill, the
 * same in both looks because a picture is a picture.
 */
export const TILE_GLASS_REDESIGN =
  "redesign:bg-[color:var(--call-badge-bg)] redesign:text-[color:var(--call-badge-text)] redesign:backdrop-blur-sm";

/** A round control on a picture, a step larger than before. */
export const TILE_BUTTON_REDESIGN = `${TILE_GLASS_REDESIGN} redesign:h-8 redesign:w-8 redesign:hover:bg-[color:var(--call-badge-hover)] redesign:data-[state=open]:bg-[color:var(--call-badge-hover)] redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-[color:var(--color-focus-ring)]`;

/** A tile: the raised surface, the card radius, the speaking ring with a gap. */
export const CALL_TILE_REDESIGN = {
  surface: "redesign:bg-[color:var(--call-tile-bg)]",
  rounded: "redesign:rounded-[var(--call-tile-radius)]",
  speaking: "redesign:ring-[color:var(--call-speaking)] redesign:ring-offset-2 redesign:ring-offset-[color:var(--call-stage-bg)]",
} as const;
