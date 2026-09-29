/**
 * How far to slide a menu sideways so it sits inside the window.
 *
 * `rect` is where the menu is drawn right now, `applied` is the slide already
 * in effect, and the return value is the slide that makes it fit. Zero when it
 * already fits. A window narrower than the menu keeps the left edge visible.
 */
export function horizontalShiftIntoView(
  rect: { left: number; right: number },
  applied: number,
  viewportWidth: number,
  padding: number,
): number {
  const left = rect.left - applied;
  const right = rect.right - applied;
  if (left < padding) return padding - left;
  if (right > viewportWidth - padding) {
    return Math.max(viewportWidth - padding - right, padding - left);
  }
  return 0;
}
