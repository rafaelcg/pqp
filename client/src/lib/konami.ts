/**
 * The Konami code (up up down down left right left right B A), the second
 * door into Modo 2005. Pure: a matcher fed one key at a time, so the rules are
 * unit-tested without a DOM, and a tiny guard for where keys are ignored.
 *
 * Ignored inside anything editable: arrow up in the composer edits the last
 * message, and arrows in a field move the caret. A pause of more than
 * `KONAMI_GAP_MS` between two keys starts over, so ordinary arrow-key use
 * spread over a session never adds up to the code by accident.
 */

export const KONAMI_SEQUENCE = [
  "arrowup",
  "arrowup",
  "arrowdown",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "arrowleft",
  "arrowright",
  "b",
  "a",
] as const;

export const KONAMI_GAP_MS = 3000;

/** `KeyB` and `KeyA` too, so a layout that types another letter there still counts. */
export function konamiKey(key: string, code?: string): string {
  if (code === "KeyB") {
    return "b";
  }
  if (code === "KeyA") {
    return "a";
  }
  return key.toLowerCase();
}

export interface KonamiMatcher {
  /** Feed one key. True exactly when it completes the sequence. */
  push: (key: string, now: number) => boolean;
}

/** A ring of the last ten keys: it matches when the ring IS the sequence. */
export function createKonamiMatcher(): KonamiMatcher {
  let ring: string[] = [];
  let lastAt = Number.NEGATIVE_INFINITY;
  return {
    push(key, now) {
      if (now - lastAt > KONAMI_GAP_MS) {
        ring = [];
      }
      lastAt = now;
      ring.push(key);
      if (ring.length > KONAMI_SEQUENCE.length) {
        ring.shift();
      }
      const hit =
        ring.length === KONAMI_SEQUENCE.length &&
        ring.every((one, index) => one === KONAMI_SEQUENCE[index]);
      if (hit) {
        ring = [];
      }
      return hit;
    },
  };
}

/** Fields, contenteditable and anything inside them. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") {
    return false;
  }
  const element = target as HTMLElement;
  if (element.isContentEditable) {
    return true;
  }
  return (
    element.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]',
    ) !== null
  );
}
