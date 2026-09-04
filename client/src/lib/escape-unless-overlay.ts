/**
 * Escape closes a surface unless a dialog, lightbox, or menu already owns the key.
 */
export function subscribeEscapeUnlessOverlay(onClose: () => void): () => void {
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || event.defaultPrevented) {
      return;
    }
    const origin = event.target;
    if (
      origin instanceof Element &&
      origin.closest('[role="dialog"], [aria-modal="true"], [role="menu"]')
    ) {
      return;
    }
    if (document.querySelector('[aria-modal="true"]')) {
      return;
    }
    event.preventDefault();
    onClose();
  }
  document.addEventListener("keydown", onKeyDown);
  return () => document.removeEventListener("keydown", onKeyDown);
}
