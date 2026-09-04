/**
 * Escape closes a surface unless a dialog, lightbox, or menu already owns the key.
 * Pass `own` when this surface is itself a menu, so Tab-into-it then Escape
 * still closes it instead of matching its own `role="menu"`.
 */
export function escapeOwnedByOverlay(
  event: KeyboardEvent,
  own?: Element | null,
): boolean {
  if (event.defaultPrevented) {
    return true;
  }
  const origin = event.target;
  if (origin instanceof Element) {
    const overlay = origin.closest(
      '[role="dialog"], [aria-modal="true"], [role="menu"]',
    );
    if (overlay && overlay !== own && !own?.contains(overlay)) {
      return true;
    }
  }
  return Boolean(document.querySelector('[aria-modal="true"]'));
}

export function subscribeEscapeUnlessOverlay(onClose: () => void): () => void {
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || escapeOwnedByOverlay(event)) {
      return;
    }
    event.preventDefault();
    onClose();
  }
  document.addEventListener("keydown", onKeyDown);
  return () => document.removeEventListener("keydown", onKeyDown);
}
