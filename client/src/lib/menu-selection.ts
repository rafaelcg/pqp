/**
 * Moves a menu's highlighted index by `delta`, wrapping around either edge —
 * arrow-down past the last row lands back on the first, arrow-up past the
 * first lands on the last. Pulled out of the composer's key handler so the
 * arithmetic can be pinned without rendering anything: this repo's vitest
 * suite runs in a `node` environment and cannot measure layout, but it can
 * call a pure function.
 */
export function wrapSelection(
  current: number,
  delta: number,
  count: number,
): number {
  if (count <= 0) {
    return 0;
  }
  return (((current + delta) % count) + count) % count;
}
