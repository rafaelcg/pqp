/*
 * The people pickers under the redesign (docs/redesign/LOG.md, `f-new-dm`):
 * the classic new conversation dialog, Nova conversa and the quick switcher.
 * Every string is redesign-only and goes after the classes a part always
 * drew, so the toggle off changes nothing.
 */

/** A picked person: an accent pill with their face, the X to drop them. */
export const PICKED_CHIP_REDESIGN =
  "redesign:h-7 redesign:gap-1.5 redesign:border-0 redesign:bg-accent-soft redesign:py-0 redesign:pl-1 redesign:pr-2 redesign:text-[13px] redesign:font-medium redesign:text-on-accent-soft redesign:transition-colors redesign:hover:bg-[color:color-mix(in_oklab,var(--color-accent-soft)_82%,var(--color-text))] redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-[color:var(--list-row-ring)]";

/**
 * The presence dot and the face cut inside a dialog: the dialog's own
 * surface, so the ring reads as a gap.
 */
export const DIALOG_CUT_REDESIGN =
  "redesign:bg-[color:var(--elevation-3-surface)] redesign:ring-[color:var(--elevation-3-surface)]";

/** The quick switcher's field: the input's round well, as `UserSearch` draws it. */
export const SWITCHER_FIELD_REDESIGN =
  "redesign:h-[var(--input-h)] redesign:gap-2.5 redesign:rounded-full redesign:border-[color:var(--input-border)] redesign:bg-[color:var(--input-bg)] redesign:px-[var(--input-px)] redesign:hover:border-[color:var(--input-hover-border)] redesign:focus-within:border-[color:var(--input-border)] redesign:focus-within:ring-2 redesign:focus-within:ring-offset-2 redesign:focus-within:ring-offset-ring-offset redesign:focus-within:ring-[color:var(--input-ring,var(--color-focus-ring))]";
