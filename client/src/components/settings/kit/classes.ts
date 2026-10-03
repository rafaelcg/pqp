/**
 * Class recipes the kit blocks share. Exported so a tab that genuinely needs
 * one of these on its own element (an icon button inside a row) spells it the
 * same way the kit does, rather than a near copy.
 */

/**
 * Focus inside a group box. The box clips, so an outer ring would be cut in
 * half; the ring goes inside and the offset band goes away.
 */
export const SETTINGS_INSET_FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring focus-visible:ring-offset-0";

/** Focus anywhere else: the four-part ring from DESIGN.md. */
export const SETTINGS_FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring";

/** Colour transitions on an interactive row or card. */
export const SETTINGS_TRANSITION =
  "transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]";

/** A row's label and its quieter second line. */
export const SETTINGS_LABEL = "text-sm text-text";
export const SETTINGS_DESCRIPTION = "text-xs text-pretty text-text-tertiary";
