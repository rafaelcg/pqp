/**
 * The arithmetic behind the windowed transcript (`message-list.tsx`).
 *
 * A transcript can hold thousands of rows and each mounted row costs about
 * 50 DOM nodes and 175 KB of heap, so only the rows near the viewport are in
 * the DOM and the rest are one spacer. Everything here is a pure function of
 * row heights and a scroll position, so it is testable without a browser.
 *
 * Rows have no fixed height. A row that has been on screen is measured and its
 * height remembered; one that never was is guessed at the running mean of the
 * measured ones. The guess is corrected when the row first mounts, and the
 * component re-anchors the scroll position on the row the reader is looking at,
 * so a wrong guess above the viewport never moves what they are reading.
 *
 * Coordinates: `offsets[i]` is the top of row `i` in the rows area, in px, and
 * `offsets[count]` is the total height. A scroll position is `scrollTop` minus
 * wherever the rows area starts inside the scroller.
 */

/** Height guessed for a row nobody has measured yet, before any is. */
export const DEFAULT_ROW_HEIGHT = 56;

/**
 * Tuning. Pixels, not rows, so a transcript of one-line stream chat and one of
 * tall embeds both keep about two screens either side of the viewport.
 */
export interface WindowConfig {
  /** Rendered beyond the viewport on each side. */
  overscanPx: number;
  /** At least this many rows beyond the visible ones on each side. */
  minOverscanRows: number;
  /** Never render more than this many rows in the contiguous window. */
  maxRows: number;
  /**
   * A transcript of at most this many rows is rendered whole: below it the
   * window saves nothing and every row stays findable by the browser.
   */
  renderAllUpTo: number;
}

export const WINDOW_CONFIG: WindowConfig = {
  overscanPx: 1400,
  minOverscanRows: 12,
  maxRows: 220,
  renderAllUpTo: 80,
};

/** A half-open range of row indices. */
export interface RowRange {
  start: number;
  end: number;
}

/** Prefix sums of the row heights: `offsets[count]` is the total height. */
export function buildOffsets(
  count: number,
  heightAt: (index: number) => number,
): Float64Array {
  const offsets = new Float64Array(count + 1);
  let running = 0;
  for (let index = 0; index < count; index += 1) {
    offsets[index] = running;
    const height = heightAt(index);
    running += Number.isFinite(height) && height > 0 ? height : 0;
  }
  offsets[count] = running;
  return offsets;
}

/** How many rows the offsets describe. */
export function rowCountOf(offsets: Float64Array): number {
  return Math.max(0, offsets.length - 1);
}

/** The height of the whole rows area. */
export function totalHeightOf(offsets: Float64Array): number {
  return offsets[offsets.length - 1] ?? 0;
}

/**
 * The row containing `y`, clamped into `[0, count - 1]`. -1 when there are no
 * rows at all. A row owns its top edge and everything below it up to the next.
 */
export function indexAtOffset(offsets: Float64Array, y: number): number {
  const count = rowCountOf(offsets);
  if (count === 0) {
    return -1;
  }
  if (y <= 0) {
    return 0;
  }
  if (y >= offsets[count]) {
    return count - 1;
  }
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid] <= y) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/**
 * The mean of the measured heights, or the default before any exists. Used as
 * the guess for every row not measured yet.
 */
export function meanRowHeight(measured: Iterable<number>): number {
  let sum = 0;
  let count = 0;
  for (const height of measured) {
    if (Number.isFinite(height) && height > 0) {
      sum += height;
      count += 1;
    }
  }
  return count === 0 ? DEFAULT_ROW_HEIGHT : sum / count;
}

/**
 * The rows to mount for a viewport `[top, top + viewport]`: the visible ones
 * plus the overscan, capped at `maxRows` around what is visible. A transcript
 * at or under `renderAllUpTo` rows is whole.
 */
export function windowRange(
  offsets: Float64Array,
  top: number,
  viewport: number,
  config: WindowConfig = WINDOW_CONFIG,
): RowRange {
  const count = rowCountOf(offsets);
  if (count <= config.renderAllUpTo) {
    return { start: 0, end: count };
  }
  const total = totalHeightOf(offsets);
  const clampedTop = Math.min(Math.max(0, top), Math.max(0, total - viewport));
  const bottom = clampedTop + viewport;
  const firstVisible = indexAtOffset(offsets, clampedTop);
  const lastVisible = indexAtOffset(offsets, Math.max(clampedTop, bottom - 1));
  let start = Math.min(
    indexAtOffset(offsets, clampedTop - config.overscanPx),
    firstVisible - config.minOverscanRows,
  );
  let end = Math.max(
    indexAtOffset(offsets, bottom + config.overscanPx) + 1,
    lastVisible + 1 + config.minOverscanRows,
  );
  start = Math.max(0, start);
  end = Math.min(count, end);
  // A viewport of tiny rows would otherwise ask for thousands: trim the side
  // that is farther from the visible rows first.
  // The visible rows are never trimmed, however many there are.
  while (end - start > config.maxRows) {
    const above = firstVisible - start;
    const below = end - 1 - lastVisible;
    if (above <= 0 && below <= 0) {
      break;
    }
    if (above >= below) {
      start += 1;
    } else {
      end -= 1;
    }
  }
  return { start, end };
}

/**
 * Whether the viewport has run out of rendered rows.
 *
 * `now`: part of the viewport is past the rendered rows, so blank space would
 * be on screen this frame. `soon`: less than `marginPx` of overscan is left on
 * a side that has more rows beyond it, so the window should move before the
 * reader gets there. `none` otherwise. A side that ends at the first or last
 * row never asks for more.
 */
export function windowPressure(
  offsets: Float64Array,
  rendered: RowRange,
  top: number,
  viewport: number,
  marginPx: number,
): "none" | "soon" | "now" {
  const count = rowCountOf(offsets);
  if (count === 0 || (rendered.start === 0 && rendered.end >= count)) {
    return "none";
  }
  const bottom = top + viewport;
  const above = rendered.start > 0 ? top - offsets[rendered.start] : Infinity;
  const below =
    rendered.end < count ? offsets[rendered.end] - bottom : Infinity;
  const slack = Math.min(above, below);
  if (slack < 0) {
    return "now";
  }
  return slack < marginPx ? "soon" : "none";
}

/**
 * The `top` that puts row `index` in the middle of a viewport, for revealing a
 * row that is not mounted yet.
 */
export function topToCenterRow(
  offsets: Float64Array,
  index: number,
  viewport: number,
): number {
  const count = rowCountOf(offsets);
  if (count === 0) {
    return 0;
  }
  const row = Math.min(Math.max(0, index), count - 1);
  const height = offsets[row + 1] - offsets[row];
  const total = totalHeightOf(offsets);
  return Math.min(
    Math.max(0, total - viewport),
    Math.max(0, offsets[row] - (viewport - height) / 2),
  );
}

/** What to draw between the rows: a row, or the space standing for rows not mounted. */
export type WindowSegment =
  | { kind: "row"; index: number }
  | { kind: "gap"; from: number; to: number; height: number };

/**
 * The window as a flat run of rows and gaps: the contiguous `range` plus any
 * `keep` rows that must stay mounted wherever they are (the one the keyboard
 * is on, one being edited, an open picker, a text selection). The gaps stand
 * for the rows between, at their remembered or guessed height, so every mounted
 * row sits exactly where it would with the whole transcript mounted.
 */
export function planSegments(
  offsets: Float64Array,
  range: RowRange,
  keep: Iterable<number> = [],
): WindowSegment[] {
  const count = rowCountOf(offsets);
  const wanted = new Set<number>();
  for (let index = Math.max(0, range.start); index < Math.min(count, range.end); index += 1) {
    wanted.add(index);
  }
  for (const index of keep) {
    if (Number.isInteger(index) && index >= 0 && index < count) {
      wanted.add(index);
    }
  }
  const indices = [...wanted].sort((a, b) => a - b);
  const segments: WindowSegment[] = [];
  let cursor = 0;
  for (const index of indices) {
    if (index > cursor) {
      segments.push({
        kind: "gap",
        from: cursor,
        to: index,
        height: offsets[index] - offsets[cursor],
      });
    }
    segments.push({ kind: "row", index });
    cursor = index + 1;
  }
  if (cursor < count) {
    segments.push({
      kind: "gap",
      from: cursor,
      to: count,
      height: offsets[count] - offsets[cursor],
    });
  }
  return segments;
}

/**
 * How far a mounted row has moved against where the reader last saw it, once
 * the reader's own scrolling since is subtracted: the layout shift to undo.
 *
 * `offsetNow` is the row's top relative to the scroller's top edge right now,
 * `offsetThen` the same when the anchor was taken at `scrollTopThen`, and
 * `scrollTopNow` the scroller's position now. Scrolling by `d` moves every row
 * by `-d`, so the row should be at `offsetThen - d`; anything else is shift.
 */
export function anchorShift(input: {
  offsetNow: number;
  offsetThen: number;
  scrollTopNow: number;
  scrollTopThen: number;
}): number {
  const expected =
    input.offsetThen - (input.scrollTopNow - input.scrollTopThen);
  return input.offsetNow - expected;
}

/**
 * A range of row indices to keep mounted for a text selection, from the rows
 * holding its two ends, or null when it is collapsed, outside the rows, or so
 * long that keeping it would defeat the window.
 */
export function selectionKeepRange(
  anchorIndex: number,
  focusIndex: number,
  maxRows: number,
): RowRange | null {
  if (anchorIndex < 0 || focusIndex < 0) {
    return null;
  }
  const start = Math.min(anchorIndex, focusIndex);
  const end = Math.max(anchorIndex, focusIndex) + 1;
  return end - start > maxRows ? null : { start, end };
}
