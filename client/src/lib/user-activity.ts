/**
 * Is anybody there, and are they in the middle of a sentence.
 *
 * The two questions `update-policy.ts` needs before it may reload a page on its
 * own. Kept out of React (nothing here renders) and out of `App` (an update
 * can come due on the landing page, which never mounts it).
 */

export const TYPING_WINDOW_MS = 20_000;

let lastInputAt = Date.now();
let lastKeyAt = 0;
let installed = false;

/** The last real interaction, or the page load if there has been none. */
export function markActivity(now: number = Date.now(), key = false): void {
  lastInputAt = now;
  if (key) {
    lastKeyAt = now;
  }
}

export function idleForMs(now: number = Date.now()): number {
  return Math.max(0, now - lastInputAt);
}

/**
 * Whether the focused element is one somebody types into and has something in.
 * An empty composer is not "typing": a person who opened the box and went to
 * make tea has nothing to lose, and the draft store keeps what there is.
 */
export function focusedFieldHasText(doc: Document = document): boolean {
  const el = doc.activeElement;
  if (!el || el === doc.body) {
    return false;
  }
  if (el instanceof HTMLTextAreaElement) {
    return el.value.trim() !== "";
  }
  if (el instanceof HTMLInputElement) {
    const textual = ["text", "search", "email", "url", "tel", "password", ""];
    return textual.includes(el.type) && el.value.trim() !== "";
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    return (el.textContent ?? "").trim() !== "";
  }
  return false;
}

/**
 * Typing now: text sitting in the field that has focus, OR a key pressed in the
 * last `TYPING_WINDOW_MS`. The second half covers a rich composer whose DOM is
 * not one of the elements above, and somebody mid-edit who paused.
 */
export function isTypingNow(
  now: number = Date.now(),
  doc: Document | null = typeof document === "undefined" ? null : document,
): boolean {
  if (now - lastKeyAt < TYPING_WINDOW_MS) {
    return true;
  }
  return doc ? focusedFieldHasText(doc) : false;
}

/** Start listening. Idempotent; returns the teardown. */
export function startActivityTracking(): () => void {
  if (typeof window === "undefined" || installed) {
    return () => {};
  }
  installed = true;
  markActivity();
  // `pointermove` is the noisy one; the timestamp write is a number, but a
  // throttle keeps the listener from being the most frequent thing on the page.
  let lastMoveWrite = 0;
  const onKey = () => markActivity(Date.now(), true);
  const onPointer = () => markActivity();
  const onMove = () => {
    const now = Date.now();
    if (now - lastMoveWrite > 1000) {
      lastMoveWrite = now;
      markActivity(now);
    }
  };
  const options = { capture: true, passive: true } as const;
  window.addEventListener("keydown", onKey, options);
  window.addEventListener("pointerdown", onPointer, options);
  window.addEventListener("wheel", onPointer, options);
  window.addEventListener("touchstart", onPointer, options);
  window.addEventListener("pointermove", onMove, options);
  return () => {
    installed = false;
    window.removeEventListener("keydown", onKey, options);
    window.removeEventListener("pointerdown", onPointer, options);
    window.removeEventListener("wheel", onPointer, options);
    window.removeEventListener("touchstart", onPointer, options);
    window.removeEventListener("pointermove", onMove, options);
  };
}

/** Test seam. */
export function resetActivityForTests(now = 0): void {
  lastInputAt = now;
  lastKeyAt = 0;
}
