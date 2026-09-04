/**
 * Escape closes a surface unless a dialog, lightbox, or menu already owns the key.
 */
export function escapeOwnedByOverlay(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) {
    return true;
  }
  const origin = event.target;
  if (
    origin instanceof Element &&
    origin.closest('[role="dialog"], [aria-modal="true"], [role="menu"]')
  ) {
    return true;
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
