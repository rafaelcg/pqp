/** Classes a row wears for the second after `openSection` lands on it. */
export const ROW_FLASH_CLASSES = [
  "bg-accent-soft",
  "transition-colors",
  "duration-[var(--duration-base)]",
] as const;

export const ROW_FLASH_MS = 1000;

/**
 * Finds a row by its `data-settings-row` id inside `container`, scrolls it to
 * the middle of the pane and flashes it once. Returns a function that removes
 * the flash early, or null when the row is not on screen (yet).
 *
 * Ids are kebab-case by contract; the escape is only a guard against a stray
 * quote, and is skipped where `CSS.escape` does not exist.
 */
export function flashSettingsRow(
  container: ParentNode | null | undefined,
  id: string,
): (() => void) | null {
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(id)
      : id.replace(/["\\]/g, "\\$&");
  const row = container?.querySelector<HTMLElement>(
    `[data-settings-row="${escaped}"]`,
  );
  if (!row) {
    return null;
  }
  row.scrollIntoView?.({ block: "center" });
  // The tab the person came from has unmounted, taking focus with it. Put
  // focus on the row's first control so a keyboard user lands where they
  // were sent, not on <body>.
  row
    .querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    ?.focus({ preventScroll: true });
  row.classList.add(...ROW_FLASH_CLASSES);
  const timer = window.setTimeout(
    () => row.classList.remove(...ROW_FLASH_CLASSES),
    ROW_FLASH_MS,
  );
  return () => {
    window.clearTimeout(timer);
    row.classList.remove(...ROW_FLASH_CLASSES);
  };
}
