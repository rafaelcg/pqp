/**
 * The arithmetic of dragging a server on the rail, kept out of the component so
 * it can be tested without a browser. Nothing here touches the DOM.
 *
 * Everything is in one coordinate space: pixels from the top of the rail's
 * scrollable content (`getBoundingClientRect().top - nav.top + nav.scrollTop`),
 * which is the only space that stays put while the rail autoscrolls under a
 * held pointer.
 */

/** One tile's place, measured when the drag starts. */
export interface RailSlot {
  top: number;
  height: number;
}

/** A move of `id` to `index` in `ids`, or the same array when it is a no-op. */
export function moveId(ids: readonly string[], id: string, index: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) {
    return [...ids];
  }
  const to = Math.max(0, Math.min(ids.length - 1, index));
  if (to === from) {
    return [...ids];
  }
  const next = ids.filter((one) => one !== id);
  next.splice(to, 0, id);
  return next;
}

/**
 * Which slot a dragged tile would land in: the one whose centre is nearest the
 * dragged tile's centre. Past either end of the list the answer is the end
 * slot, so dropping above the first tile or below the last one always works.
 */
export function targetSlot(slots: readonly RailSlot[], draggedCentre: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  slots.forEach((slot, index) => {
    const distance = Math.abs(slot.top + slot.height / 2 - draggedCentre);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/**
 * Where the drop line sits (content px), or null when dropping would change
 * nothing. Moving down lands AFTER the tile now in the target slot, moving up
 * lands BEFORE it, so the line is at the edge the dragged tile will touch.
 */
export function dropLineY(
  slots: readonly RailSlot[],
  from: number,
  target: number,
  gap: number,
): number | null {
  if (target === from) {
    return null;
  }
  const slot = slots[target];
  if (!slot) {
    return null;
  }
  return target > from ? slot.top + slot.height + gap / 2 : slot.top - gap / 2;
}

/** Keep the dragged tile inside the list: its top between the first and last slot. */
export function clampTop(slots: readonly RailSlot[], top: number): number {
  const first = slots[0]?.top ?? 0;
  const last = slots[slots.length - 1]?.top ?? 0;
  return Math.max(first, Math.min(last, top));
}

/** Pixels the rail should scroll this frame; negative is up. Zero outside the edges. */
export function autoscrollStep(
  pointerY: number,
  railTop: number,
  railBottom: number,
  edge = 56,
  maxStep = 18,
): number {
  const intoTop = railTop + edge - pointerY;
  if (intoTop > 0) {
    return -Math.round(maxStep * Math.min(1, intoTop / edge));
  }
  const intoBottom = pointerY - (railBottom - edge);
  if (intoBottom > 0) {
    return Math.round(maxStep * Math.min(1, intoBottom / edge));
  }
  return 0;
}

export type RailKeyMove = "up" | "down" | "first" | "last";

/**
 * The reorder a key asks for, or null. Alt is the whole gesture: plain arrows
 * move focus, and Alt+Shift+arrow is the app's "next unread channel".
 */
export function railKeyMove(event: {
  key: string;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): RailKeyMove | null {
  if (!event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) {
    return null;
  }
  switch (event.key) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "Home":
      return "first";
    case "End":
      return "last";
    default:
      return null;
  }
}

/** Where a key move puts the tile at `from` in a list of `count`. */
export function keyMoveTarget(move: RailKeyMove, from: number, count: number): number {
  switch (move) {
    case "up":
      return Math.max(0, from - 1);
    case "down":
      return Math.min(count - 1, from + 1);
    case "first":
      return 0;
    case "last":
      return count - 1;
  }
}

/**
 * A random id for THIS tab, sent with a save and echoed on the frame, so the tab
 * that saved can skip its own echo. Not an identity: it is never stored.
 */
export function newRailOrigin(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
