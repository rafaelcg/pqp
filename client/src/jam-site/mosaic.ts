/**
 * THE MOSAIC: where every tile of a song goes, as arithmetic. No React, no DOM.
 *
 * Every part of a song is one tile (a video, or a square in the instrument's
 * colour), and the "your part here" tile joins them when the song still asks
 * for somebody. The box is split by how many tiles there are, never by how
 * many there could be, so one person is a full frame and nine are a grid.
 *
 * `mosaicLayout(count, containerAspect)` answers with a grid: weighted
 * columns and rows (`fr` units) and, per tile, where it sits on the grid
 * lines. A caller draws it with CSS grid and the aspect it is given back:
 *
 *   grid-template-columns: columns.map(w => `${w}fr`)
 *   grid-template-rows:    rows.map(w => `${w}fr`)
 *   aspect-ratio:          layout.aspect
 *   tile i:                grid-column: col / span colSpan; grid-row: row / span rowSpan
 *
 * WIDE (`containerAspect >= 1`) fills a landscape stage: 1 is full, 2 side by
 * side, 3 is one big tile and two small, 4 a 2x2, 5 three over two, up to
 * 3x3 for nine. TALL (a phone held upright) is the same idea turned: the
 * stack grows downward and the first tile takes the full width when the count
 * is odd, so no tile is a sliver.
 *
 * SPOTLIGHT (`spotlightLayout`): one tile large, the rest small beside it
 * (wide) or under it (tall). The spotlit tile keeps its place in the list, so
 * the DOM order, and with it the keyboard order, never changes.
 *
 * More than nine tiles (a song nobody has stopped adding to) fall to a
 * generic filled grid; the tests pin that every layout covers its box exactly
 * once, with no gap and no overlap, for every count.
 */

export type MosaicOrientation = "wide" | "tall";

export interface MosaicCell {
  /** 1-based grid line the tile starts on. */
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

export interface MosaicLayout {
  orientation: MosaicOrientation;
  /** Relative width of each column, for `grid-template-columns` in `fr`. */
  columns: number[];
  /** Relative height of each row. */
  rows: number[];
  /** Width over height of the whole box. */
  aspect: number;
  cells: MosaicCell[];
}

/** The widest a wide box is allowed to get, and the tallest a tall one. */
const WIDE_MIN_ASPECT = 1.35;
const WIDE_MAX_ASPECT = 2.1;

export const MOSAIC_MAX_TILES = 16;

type Spec = [cols: number, rows: number, spans: Array<[number, number]>, aspect?: number];
const repeat = (span: [number, number], n: number): Array<[number, number]> =>
  Array.from({ length: n }, () => span);

/** Landscape stage, `[columns, rows, [colSpan, rowSpan] per tile]`. A tile with no entry spans 1x1. */
const WIDE: Record<number, Spec> = {
  1: [1, 1, []],
  2: [2, 1, []],
  3: [3, 2, [[2, 2]]],
  4: [2, 2, []],
  5: [6, 2, [...repeat([2, 1], 3), ...repeat([3, 1], 2)]],
  6: [3, 2, []],
  7: [12, 2, [...repeat([3, 1], 4), ...repeat([4, 1], 3)]],
  8: [4, 2, []],
  9: [3, 3, []],
  10: [5, 2, []],
};

/** Phone upright, with the box's own aspect (width over height). */
const TALL: Record<number, Spec> = {
  1: [1, 1, [], 4 / 5],
  2: [1, 2, [], 4 / 5],
  3: [2, 2, [[2, 1]], 1],
  4: [2, 2, [], 1],
  5: [2, 3, [[2, 1]], 2 / 3],
  6: [2, 3, [], 2 / 3],
  7: [3, 3, [[3, 1]], 1],
  8: [6, 3, [...repeat([2, 1], 6), ...repeat([3, 1], 2)], 1],
  9: [3, 3, [], 1],
  10: [3, 4, [[3, 1]], 3 / 4],
};

function place(spec: Spec, count: number): MosaicCell[] {
  const [columns, , spans] = spec;
  const cells: MosaicCell[] = [];
  let col = 1;
  let row = 1;
  // Row by row: a tile that spans two rows (the big one of three) is carried
  // as an occupied block, so the next tiles flow around it.
  const taken = new Set<string>();
  const free = (c: number, r: number, cs: number, rs: number) => {
    for (let y = r; y < r + rs; y++) {
      for (let x = c; x < c + cs; x++) {
        if (taken.has(`${x},${y}`)) return false;
      }
    }
    return true;
  };
  for (let i = 0; i < count; i++) {
    const [colSpan, rowSpan] = spans[i] ?? [1, 1];
    while (!free(col, row, colSpan, rowSpan) || col + colSpan - 1 > columns) {
      col += 1;
      if (col > columns) {
        col = 1;
        row += 1;
      }
    }
    for (let y = row; y < row + rowSpan; y++) {
      for (let x = col; x < col + colSpan; x++) taken.add(`${x},${y}`);
    }
    cells.push({ col, row, colSpan, rowSpan });
    col += colSpan;
    if (col > columns) {
      col = 1;
      row += 1;
    }
  }
  return cells;
}

const ones = (n: number) => Array.from({ length: n }, () => 1);

function lcm(a: number, b: number): number {
  const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
  return (a / gcd(a, b)) * b;
}

/** Any count: rows as even as they can be, each row's tiles sharing the width. */
function generic(count: number, orientation: MosaicOrientation): Spec {
  const rowsN = Math.max(1, Math.round(Math.sqrt(count * (orientation === "wide" ? 0.6 : 1.6))));
  const base = Math.floor(count / rowsN);
  const extra = count % rowsN;
  const perRow = Array.from({ length: rowsN }, (_, r) => base + (r < extra ? 1 : 0));
  const columns = perRow.reduce((acc, n) => lcm(acc, Math.max(1, n)), 1);
  const spans: Array<[number, number]> = [];
  for (const n of perRow) {
    for (let k = 0; k < n; k++) spans.push([columns / n, 1]);
  }
  return [columns, rowsN, spans, orientation === "wide" ? 16 / 9 : 3 / 4];
}

function specFor(count: number, orientation: MosaicOrientation): Spec {
  const table = orientation === "wide" ? WIDE : TALL;
  return table[count] ?? generic(count, orientation);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The layout for `count` tiles in a box whose available width over height is
 * `containerAspect`. At or above 1 the stage is wide, below it tall.
 */
export function mosaicLayout(count: number, containerAspect: number): MosaicLayout {
  const n = clamp(Math.floor(count) || 1, 1, MOSAIC_MAX_TILES);
  const orientation: MosaicOrientation = containerAspect >= 1 ? "wide" : "tall";
  const spec = specFor(n, orientation);
  const [columns, rows] = spec;
  const aspect =
    orientation === "wide"
      ? clamp(Number.isFinite(containerAspect) ? containerAspect : 16 / 9, WIDE_MIN_ASPECT, WIDE_MAX_ASPECT)
      : (spec[3] ?? 3 / 4);
  return {
    orientation,
    columns: ones(columns),
    rows: ones(rows),
    aspect,
    cells: place(spec, n),
  };
}

/**
 * One tile large, the others small. `spot` is the index of the tile in the
 * caller's list. Wide: the big one on the left over every row, the others in
 * one or two columns on the right. Tall: the big one on top at 4:3, the
 * others as squares under it (at most four to a row).
 */
export function spotlightLayout(
  count: number,
  spot: number,
  containerAspect: number,
): MosaicLayout {
  const n = clamp(Math.floor(count) || 1, 1, MOSAIC_MAX_TILES);
  if (n === 1 || spot < 0 || spot >= n) {
    return mosaicLayout(n, containerAspect);
  }
  const others = n - 1;
  const orientation: MosaicOrientation = containerAspect >= 1 ? "wide" : "tall";
  const cells: MosaicCell[] = new Array<MosaicCell>(n);
  if (orientation === "tall") {
    // The others in rows of at most four, as even as they can be; a row with
    // fewer tiles gives each one more of the width.
    const rowCount = Math.ceil(others / 4);
    const base = Math.floor(others / rowCount);
    const extra = others % rowCount;
    const perRow = Array.from({ length: rowCount }, (_, r) => base + (r < extra ? 1 : 0));
    const columns = perRow.reduce((acc, c) => lcm(acc, c), 1);
    cells[spot] = { col: 1, row: 1, colSpan: columns, rowSpan: 1 };
    const order: number[] = [];
    for (let i = 0; i < n; i++) if (i !== spot) order.push(i);
    let k = 0;
    perRow.forEach((count, r) => {
      for (let c = 0; c < count; c++) {
        cells[order[k++]!] = {
          col: 1 + c * (columns / count),
          row: 2 + r,
          colSpan: columns / count,
          rowSpan: 1,
        };
      }
    });
    // The big tile is 4:3 of the box's width; a small row is as tall as its widest tile is wide.
    const bigRow = 0.75;
    const smallRows = perRow.map((count) => 1 / count);
    return {
      orientation,
      columns: ones(columns),
      rows: [bigRow, ...smallRows],
      aspect: 1 / (bigRow + smallRows.reduce((a, b) => a + b, 0)),
      cells,
    };
  }
  const two = others > 4;
  const rowCount = two ? Math.ceil(others / 2) : others;
  cells[spot] = { col: 1, row: 1, colSpan: 1, rowSpan: rowCount };
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (i === spot) continue;
    const lastOdd = two && others % 2 === 1 && k === others - 1;
    cells[i] = {
      col: 2 + (two && !lastOdd ? k % 2 : 0),
      row: 1 + (two ? Math.floor(k / 2) : k),
      colSpan: lastOdd ? 2 : 1,
      rowSpan: 1,
    };
    k += 1;
  }
  return {
    orientation,
    columns: two ? [3, 1, 1] : [3, 1],
    rows: ones(rowCount),
    aspect: clamp(Number.isFinite(containerAspect) ? containerAspect : 16 / 9, WIDE_MIN_ASPECT, WIDE_MAX_ASPECT),
    cells,
  };
}

/** For the tests, and for anything that wants to know a layout is whole. */
export function layoutCoversBox(layout: MosaicLayout): boolean {
  const seen = new Set<string>();
  for (const cell of layout.cells) {
    for (let y = cell.row; y < cell.row + cell.rowSpan; y++) {
      for (let x = cell.col; x < cell.col + cell.colSpan; x++) {
        if (x < 1 || y < 1 || x > layout.columns.length || y > layout.rows.length) return false;
        const key = `${x},${y}`;
        if (seen.has(key)) return false;
        seen.add(key);
      }
    }
  }
  return seen.size === layout.columns.length * layout.rows.length;
}
