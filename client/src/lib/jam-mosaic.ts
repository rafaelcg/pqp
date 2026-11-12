/**
 * The song view's mosaic: one rectangle divided among the band.
 *
 * Everything here is arithmetic with no React in it. The layout is an INTEGER grid
 * (`cols` x `rows` units, every tile a block of whole units), so the tiles cover the
 * stage exactly by construction: no gaps, no overlap, no rounding. The gutter between
 * tiles is CSS (`gap`), never part of the maths. `cellRect` turns a block into
 * fractions of the stage for anything that wants them (the tests, a measurement).
 *
 * Which arrangement is chosen depends on the stage's aspect ratio: three recordings
 * are one big tile and two small on a wide stage and on a tall one, but the big one
 * sits left on the first and on top in the second; six are three across and two down
 * on a wide stage and two across and three down on a tall one. Each candidate is
 * scored by how far its worst tile is from a comfortable shape, and the best wins.
 */

/** A tile: a block of the integer grid, in whole units. */
export interface MosaicCell {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

export interface MosaicLayout {
  cols: number;
  rows: number;
  /** In reading order: top to bottom, then left to right. */
  cells: MosaicCell[];
}

/** A tile as fractions of the stage: `x + w` and `y + h` never pass 1. */
export interface MosaicRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The most tiles a mosaic draws; past it the last is a "+N" tile. */
export const MOSAIC_MAX_TILES = 9;
/** With a "+N" tile the others are this many. */
export const MOSAIC_TILES_WITH_MORE = MOSAIC_MAX_TILES - 1;

/** The shape a tile is happiest at (a little wider than tall), as width over height. */
const TARGET_TILE_ASPECT = 1.4;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function lcm(a: number, b: number): number {
  return (a / gcd(a, b)) * b;
}

/** `count` tiles over `lines` lines, as even as can be, the lines with fewer tiles (bigger ones) first. */
function spread(count: number, lines: number): number[] {
  const base = Math.floor(count / lines);
  const extra = count % lines;
  return Array.from({ length: lines }, (_, index) => (index >= lines - extra ? base + 1 : base));
}

/** Lines of tiles: each entry is how many tiles that row (or column) holds, equally dividing the stage's width (or height). */
function fromLines(counts: readonly number[], orient: "rows" | "cols"): MosaicLayout {
  const across = counts.reduce(lcm, 1);
  const cells: MosaicCell[] = [];
  counts.forEach((tiles, line) => {
    const span = across / tiles;
    for (let index = 0; index < tiles; index += 1) {
      cells.push(
        orient === "rows"
          ? { col: index * span, row: line, colSpan: span, rowSpan: 1 }
          : { col: line, row: index * span, colSpan: 1, rowSpan: span },
      );
    }
  });
  const layout: MosaicLayout =
    orient === "rows" ? { cols: across, rows: counts.length, cells } : { cols: counts.length, rows: across, cells };
  return { ...layout, cells: layout.cells.sort(byReadingOrder) };
}

function byReadingOrder(a: MosaicCell, b: MosaicCell): number {
  return a.row - b.row || a.col - b.col;
}

/** One big tile and two small: the big one takes two thirds of the long side. */
function bigAndTwo(orient: "wide" | "tall"): MosaicLayout {
  const cells: MosaicCell[] =
    orient === "wide"
      ? [
          { col: 0, row: 0, colSpan: 2, rowSpan: 2 },
          { col: 2, row: 0, colSpan: 1, rowSpan: 1 },
          { col: 2, row: 1, colSpan: 1, rowSpan: 1 },
        ]
      : [
          { col: 0, row: 0, colSpan: 2, rowSpan: 2 },
          { col: 0, row: 2, colSpan: 1, rowSpan: 1 },
          { col: 1, row: 2, colSpan: 1, rowSpan: 1 },
        ];
  return orient === "wide" ? { cols: 3, rows: 2, cells } : { cols: 2, rows: 3, cells };
}

function candidates(count: number, aspect: number): MosaicLayout[] {
  switch (count) {
    case 1:
      return [fromLines([1], "rows")];
    case 2:
      // halves, side by side; stacked only when the stage is not wider than tall
      return [fromLines([2], aspect > 1.05 ? "rows" : "cols")];
    case 3:
      return [fromLines([3], "rows"), fromLines([3], "cols"), bigAndTwo("wide"), bigAndTwo("tall")];
    case 4:
      return [fromLines([2, 2], "rows")];
    case 5:
    case 6:
      return [fromLines(spread(count, 2), "rows"), fromLines(spread(count, 2), "cols")];
    default:
      return [fromLines(spread(count, 3), "rows"), fromLines(spread(count, 3), "cols")];
  }
}

/** How far the worst tile of this layout is from the shape a tile is happiest at (0 is perfect), on a stage `aspect` wide over tall. */
export function layoutCost(layout: MosaicLayout, aspect: number): number {
  let worst = 0;
  for (const cell of layout.cells) {
    const shape = ((cell.colSpan / layout.cols) * aspect) / (cell.rowSpan / layout.rows);
    worst = Math.max(worst, Math.abs(Math.log(shape / TARGET_TILE_ASPECT)));
  }
  return worst;
}

/**
 * The arrangement of `count` tiles (1 to 9; a count past it is nine, because the
 * ninth is the "+N" tile) on a stage `aspect` wide over tall. Zero tiles is an
 * empty grid.
 */
export function mosaicLayout(count: number, aspect: number): MosaicLayout {
  const tiles = Math.min(MOSAIC_MAX_TILES, Math.max(0, Math.floor(count)));
  if (tiles === 0) {
    return { cols: 1, rows: 1, cells: [] };
  }
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  let best: MosaicLayout | null = null;
  let bestCost = Infinity;
  for (const layout of candidates(tiles, safeAspect)) {
    const cost = layoutCost(layout, safeAspect);
    if (cost < bestCost - 1e-9) {
      best = layout;
      bestCost = cost;
    }
  }
  return best!;
}

export function cellRect(layout: MosaicLayout, cell: MosaicCell): MosaicRect {
  return {
    x: cell.col / layout.cols,
    y: cell.row / layout.rows,
    w: cell.colSpan / layout.cols,
    h: cell.rowSpan / layout.rows,
  };
}

/** What a tile holds, for deciding who gets a large cell. */
export type MosaicKind = "video" | "audio" | "missing" | "more";

const PRIORITY: Record<MosaicKind, number> = { video: 0, audio: 1, missing: 2, more: 3 };

/**
 * Which item goes in which cell: for each cell, in reading order, the index of the
 * item it holds. When every cell is the same size the items keep their order. When
 * some are larger (five tiles are two big and three smaller, a big tile and two),
 * the larger cells go to tiles with a video first, then to a take with sound only,
 * then to the "your part here" tile; the "+N" tile always takes the last cell, the
 * smallest of the reading order, and nothing is ever reordered within a kind.
 */
export function assignCells(layout: MosaicLayout, kinds: readonly MosaicKind[]): number[] {
  const cellCount = layout.cells.length;
  const order = layout.cells.map((_, index) => index);
  const result = new Array<number>(cellCount).fill(-1);
  const moreIndex = kinds.lastIndexOf("more");
  const plain = kinds.map((_, index) => index).filter((index) => index !== moreIndex);
  const free = moreIndex >= 0 && cellCount > 0 ? order.slice(0, -1) : order;
  if (moreIndex >= 0 && cellCount > 0) {
    result[cellCount - 1] = moreIndex;
  }
  const area = (index: number) => layout.cells[index]!.colSpan * layout.cells[index]!.rowSpan;
  const uniform = free.every((index) => area(index) === area(free[0]!));
  if (uniform) {
    free.forEach((cell, slot) => {
      result[cell] = plain[slot] ?? -1;
    });
    return result;
  }
  const bigFirst = [...free].sort((a, b) => area(b) - area(a) || a - b);
  const byPriority = [...plain].sort((a, b) => PRIORITY[kinds[a]!] - PRIORITY[kinds[b]!] || a - b);
  bigFirst.forEach((cell, slot) => {
    result[cell] = byPriority[slot] ?? -1;
  });
  return result;
}

/** What a tile row of the stage is: the ratio of the whole stage (width over height) for a stage this wide, in px. */
export function stageAspect(widthPx: number): number {
  if (widthPx > 0 && widthPx < 480) {
    // a phone: square, so the band's lanes stay near the stage instead of a page below it
    return 1;
  }
  if (widthPx > 0 && widthPx < 720) {
    return 4 / 3;
  }
  return 16 / 9;
}

export interface MosaicShown {
  /** How many of the recordings get a tile of their own. */
  tracks: number;
  /** How many "your part here" tiles. */
  missing: number;
  /** The recordings the "+N" tile stands for; 0 means no such tile. */
  more: number;
}

/**
 * What fits: at most nine tiles. Past it the first eight tiles stay and the ninth is
 * "+N". A part somebody may add keeps its place before a recording does (at most two of
 * them), so the tile that asks for something is never the one folded away.
 */
export function mosaicShown(trackCount: number, missingCount: number): MosaicShown {
  if (trackCount + missingCount <= MOSAIC_MAX_TILES) {
    return { tracks: trackCount, missing: missingCount, more: 0 };
  }
  const missing = Math.min(missingCount, 2);
  const tracks = Math.max(0, MOSAIC_TILES_WITH_MORE - missing);
  const more = trackCount - tracks;
  return more > 0 ? { tracks, missing, more } : { tracks: trackCount, missing, more: 0 };
}

export interface LevelTrack {
  peaks: readonly number[];
  offsetMs: number;
  trimStartMs: number;
  trimEndMs: number;
  durationMs: number;
}

/**
 * A strip of `count` loudness values, 0..1, centred on the song clock: the track's own
 * precomputed peaks around `positionMs`, so the strip moves exactly as the track's sound
 * does and costs nothing (no analyser on the audio graph). Outside the stretch the take
 * is audible (before it enters, after its trimmed end) the strip is flat.
 */
export function levelStrip(track: LevelTrack, positionMs: number, count: number): number[] {
  const out = new Array<number>(Math.max(0, count)).fill(0);
  const total = track.peaks.length;
  if (total === 0 || track.durationMs <= 0 || count <= 0) {
    return out;
  }
  const msPerPeak = track.durationMs / total;
  const local = positionMs - track.offsetMs;
  const audibleFrom = track.trimStartMs;
  const audibleTo = track.durationMs - track.trimEndMs;
  const centre = Math.floor(count / 2);
  for (let bar = 0; bar < count; bar += 1) {
    const at = local + (bar - centre) * msPerPeak;
    if (at < audibleFrom || at >= audibleTo) {
      continue;
    }
    out[bar] = Math.min(1, Math.max(0, track.peaks[Math.min(total - 1, Math.floor(at / msPerPeak))] ?? 0));
  }
  return out;
}

/** The whole take as `count` bars, loudest at full height: the still picture for people who ask for no motion. */
export function levelOverview(track: LevelTrack, count: number): number[] {
  const out = new Array<number>(Math.max(0, count)).fill(0);
  const total = track.peaks.length;
  if (total === 0 || count <= 0) {
    return out;
  }
  let loudest = 0;
  for (let bar = 0; bar < count; bar += 1) {
    const from = Math.floor((bar * total) / count);
    const to = Math.max(from + 1, Math.floor(((bar + 1) * total) / count));
    let peak = 0;
    for (let index = from; index < to && index < total; index += 1) {
      peak = Math.max(peak, track.peaks[index] ?? 0);
    }
    out[bar] = peak;
    loudest = Math.max(loudest, peak);
  }
  return loudest > 0 ? out.map((value) => value / loudest) : out;
}
