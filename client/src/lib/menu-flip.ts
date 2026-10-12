/**
 * Whether a menu anchored under `anchor` should open above it instead.
 *
 * A message's ⋯ menu is drawn inside the transcript, which scrolls and so
 * clips whatever hangs past its edge: on the last reply the menu ran under
 * the composer and its first item was the only one left to click (forum QA
 * P19, the chat's own behaviour too). It opens upward when the space below,
 * inside the nearest clipping ancestor, is too short for it and the space
 * above is larger.
 */
export function shouldOpenUp(anchor: Element, menuHeight: number): boolean {
  const box = anchor.getBoundingClientRect();
  const bounds = clippingBounds(anchor);
  const below = bounds.bottom - box.bottom;
  const above = box.top - bounds.top;
  return below < menuHeight + MENU_GAP_PX && above > below;
}

/** The menu's offset from its anchor, plus a little air. */
const MENU_GAP_PX = 6;

/** The box that clips `node`: its nearest scrolling or clipping ancestor, or the window. */
export function clippingBounds(node: Element): { top: number; bottom: number } {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const overflowY = getComputedStyle(parent).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden" || overflowY === "clip") {
      const rect = parent.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }
  }
  return { top: 0, bottom: window.innerHeight };
}
