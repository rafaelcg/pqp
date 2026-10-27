/**
 * A sheet: a panel that rises from the bottom edge of a phone. Dialog draws
 * one below `sm`, the app launcher draws one as its phone form, and the
 * cinema stage's picker draws one.
 *
 * Only the look is shared, and only under the redesign: with the toggle off
 * each sheet keeps the surface it always drew (an elevation-3 dialog, the
 * launcher's bordered `surface-1`, the stage picker's `ink-2`). Under the
 * redesign every sheet takes the popover's fill, a larger top radius, a
 * hairline along its top edge only, and a shadow cast upwards, so the three
 * read as one thing on a phone.
 *
 * `SHEET_SURFACE` is for a panel that is a sheet at every width;
 * `SHEET_SURFACE_PHONE` for one that is a sheet only below `sm` (a dialog
 * that is centred on a larger screen). The strings are written out in full
 * because Tailwind only generates classes it can read in the source.
 */
export const SHEET_SURFACE =
  "redesign:rounded-t-[var(--sheet-radius)] redesign:rounded-b-[0px] redesign:border-x-0 redesign:border-b-0 redesign:border-t redesign:border-t-[color:var(--sheet-edge)] redesign:bg-[color:var(--sheet-surface)] redesign:shadow-[var(--sheet-shadow)]";

export const SHEET_SURFACE_PHONE =
  "redesign:max-sm:rounded-t-[var(--sheet-radius)] redesign:max-sm:rounded-b-[0px] redesign:max-sm:border-x-0 redesign:max-sm:border-b-0 redesign:max-sm:border-t redesign:max-sm:border-t-[color:var(--sheet-edge)] redesign:max-sm:bg-[color:var(--sheet-surface)] redesign:max-sm:shadow-[var(--sheet-shadow)]";

/**
 * Clear of the home indicator on a phone sheet with no footer of its own,
 * with a floor for a device whose inset is zero.
 */
export const SHEET_SAFE_BOTTOM = "redesign:max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]";

/** The scrim behind a sheet that draws its own (a dialog draws its own scrim). */
export const SHEET_SCRIM =
  "redesign:bg-[color:var(--sheet-scrim)] redesign:backdrop-blur-[var(--sheet-scrim-blur)]";
