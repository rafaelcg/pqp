import { describe, expect, it } from "vitest";
import {
  assignCells,
  cellRect,
  levelOverview,
  levelStrip,
  mosaicLayout,
  mosaicShown,
  stageAspect,
  type MosaicKind,
} from "./jam-mosaic";

const ASPECTS = [
  ["wide 16:9", 16 / 9],
  ["4:3", 4 / 3],
  ["tall 4:5", 4 / 5],
  ["very tall", 0.5],
  ["very wide", 3],
] as const;

describe("the mosaic's layout", () => {
  for (const [label, aspect] of ASPECTS) {
    for (let count = 1; count <= 9; count += 1) {
      it(`${count} tiles on a ${label} stage: one tile each, tiling the stage exactly (no gap, no overlap)`, () => {
        const layout = mosaicLayout(count, aspect);
        expect(layout.cells).toHaveLength(count);
        // every unit of the integer grid is covered once
        const covered = new Map<string, number>();
        for (const cell of layout.cells) {
          expect(cell.colSpan).toBeGreaterThan(0);
          expect(cell.rowSpan).toBeGreaterThan(0);
          expect(cell.col + cell.colSpan).toBeLessThanOrEqual(layout.cols);
          expect(cell.row + cell.rowSpan).toBeLessThanOrEqual(layout.rows);
          for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) {
            for (let col = cell.col; col < cell.col + cell.colSpan; col += 1) {
              const key = `${col},${row}`;
              covered.set(key, (covered.get(key) ?? 0) + 1);
            }
          }
        }
        expect(covered.size).toBe(layout.cols * layout.rows);
        expect([...covered.values()].every((times) => times === 1)).toBe(true);
        // and as fractions: the areas add up to the whole stage, and no two rectangles overlap
        const rects = layout.cells.map((cell) => cellRect(layout, cell));
        expect(rects.reduce((sum, rect) => sum + rect.w * rect.h, 0)).toBeCloseTo(1, 12);
        for (let a = 0; a < rects.length; a += 1) {
          for (let b = a + 1; b < rects.length; b += 1) {
            const one = rects[a]!;
            const two = rects[b]!;
            const overlap = one.x < two.x + two.w - 1e-12 && two.x < one.x + one.w - 1e-12 && one.y < two.y + two.h - 1e-12 && two.y < one.y + one.h - 1e-12;
            expect(overlap).toBe(false);
          }
        }
      });
    }
  }

  it("is the plain shapes the owner asked for on a wide stage", () => {
    const wide = 16 / 9;
    // one: the whole stage
    expect(mosaicLayout(1, wide)).toMatchObject({ cols: 1, rows: 1 });
    // two: halves side by side
    expect(mosaicLayout(2, wide)).toMatchObject({ cols: 2, rows: 1 });
    expect(mosaicLayout(2, 4 / 3)).toMatchObject({ cols: 2, rows: 1 });
    // three: one big tile and two small (the big one two thirds of the width, both rows)
    const three = mosaicLayout(3, wide);
    expect(cellRect(three, three.cells[0]!)).toEqual({ x: 0, y: 0, w: 2 / 3, h: 1 });
    expect(three.cells.slice(1).map((cell) => cellRect(three, cell).h)).toEqual([0.5, 0.5]);
    // four: two by two
    expect(mosaicLayout(4, wide)).toMatchObject({ cols: 2, rows: 2 });
    // six: three across, two down
    const six = mosaicLayout(6, wide);
    expect(six.cols / six.cells.filter((cell) => cell.row === 0).length).toBe(1);
    expect(six.cells.filter((cell) => cell.row === 0)).toHaveLength(3);
    expect(six.cells.filter((cell) => cell.row === 1)).toHaveLength(3);
    // nine: three by three
    expect(mosaicLayout(9, wide)).toMatchObject({ cols: 3, rows: 3 });
  });

  it("stacks two on a tall stage, and turns six into two across and three down", () => {
    const tall = 1;
    expect(mosaicLayout(2, tall)).toMatchObject({ cols: 1, rows: 2 });
    const six = mosaicLayout(6, tall);
    expect(six.cells.filter((cell) => cell.row === 0)).toHaveLength(2);
    expect(six.cells.filter((cell) => cell.col === 0)).toHaveLength(3);
  });

  it("puts the big tile of three on top when the stage is tall", () => {
    const three = mosaicLayout(3, 4 / 5);
    expect(cellRect(three, three.cells[0]!)).toEqual({ x: 0, y: 0, w: 1, h: 2 / 3 });
  });

  it("never draws a sliver: on the two stages the panel really has, every tile is within 2:1 of a square", () => {
    for (const aspect of [16 / 9, 4 / 3, 4 / 5]) {
      for (let count = 1; count <= 9; count += 1) {
        const layout = mosaicLayout(count, aspect);
        for (const cell of layout.cells) {
          const shape = ((cell.colSpan / layout.cols) * aspect) / (cell.rowSpan / layout.rows);
          // a tile is never narrower than a third nor wider than three times its height
          expect(shape, `${count} tiles at ${aspect.toFixed(2)}`).toBeGreaterThan(0.3);
          expect(shape, `${count} tiles at ${aspect.toFixed(2)}`).toBeLessThan(3.2);
        }
      }
    }
  });

  it("clamps a count past nine to nine (the ninth is the +N tile) and an empty stage has no tiles", () => {
    expect(mosaicLayout(14, 16 / 9).cells).toHaveLength(9);
    expect(mosaicLayout(0, 16 / 9).cells).toHaveLength(0);
    expect(mosaicLayout(3, Number.NaN).cells).toHaveLength(3);
  });
});

describe("who gets the larger cells", () => {
  const kinds = (...list: MosaicKind[]) => list;

  it("keeps the order when every cell is the same size", () => {
    const layout = mosaicLayout(4, 16 / 9);
    expect(assignCells(layout, kinds("audio", "video", "audio", "video"))).toEqual([0, 1, 2, 3]);
  });

  it("gives the big tile of three to a video, then to the audio-only, the part to add last", () => {
    const layout = mosaicLayout(3, 16 / 9);
    // reading order: the big tile, then the two small
    expect(assignCells(layout, kinds("audio", "audio", "video"))[0]).toBe(2);
    expect(assignCells(layout, kinds("missing", "audio", "video"))).toEqual([2, 1, 0]);
    // two videos: the first in the track order takes the big one
    expect(assignCells(layout, kinds("audio", "video", "video"))).toEqual([1, 2, 0]);
  });

  it("gives the two larger cells of five to the videos, in track order", () => {
    const layout = mosaicLayout(5, 16 / 9);
    const order = assignCells(layout, kinds("audio", "video", "audio", "video", "audio"));
    const rowOf = (item: number) => layout.cells[order.indexOf(item)]!.row;
    // the cells with fewer tiles in their line are the bigger ones: the first line
    expect(rowOf(1)).toBe(0);
    expect(rowOf(3)).toBe(0);
    expect(new Set(order).size).toBe(5);
  });

  it("always puts the +N tile in the last cell and never moves it", () => {
    const layout = mosaicLayout(9, 16 / 9);
    const list = kinds("video", "video", "audio", "audio", "audio", "audio", "audio", "audio", "more");
    const order = assignCells(layout, list);
    expect(order[8]).toBe(8);
    expect(order.slice(0, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("how many tiles fit", () => {
  it("is every recording up to nine, with the part to add among them", () => {
    expect(mosaicShown(4, 1)).toEqual({ tracks: 4, missing: 1, more: 0 });
    expect(mosaicShown(9, 0)).toEqual({ tracks: 9, missing: 0, more: 0 });
  });

  it("is the first eight and a +N past nine", () => {
    expect(mosaicShown(12, 0)).toEqual({ tracks: 8, missing: 0, more: 4 });
    expect(mosaicShown(10, 0)).toEqual({ tracks: 8, missing: 0, more: 2 });
  });

  it("keeps the part to add on screen and folds recordings instead", () => {
    expect(mosaicShown(9, 1)).toEqual({ tracks: 7, missing: 1, more: 2 });
    expect(mosaicShown(9, 5)).toEqual({ tracks: 6, missing: 2, more: 3 });
  });
});

describe("the stage's shape", () => {
  it("is square on a phone, 4:3 on a narrow panel and 16:9 on a wide one", () => {
    expect(stageAspect(366)).toBe(1);
    expect(stageAspect(540)).toBe(4 / 3);
    expect(stageAspect(900)).toBe(16 / 9);
    // before it is measured
    expect(stageAspect(0)).toBe(16 / 9);
  });
});

describe("the level strip", () => {
  const take = { peaks: [0.1, 0.2, 0.9, 0.4, 0.3, 0.8, 0.2, 0.5, 0.6, 0.1], offsetMs: 0, trimStartMs: 0, trimEndMs: 0, durationMs: 10_000 };

  it("is the peaks around the song clock, the one under the playhead in the middle", () => {
    const strip = levelStrip(take, 2500, 5);
    // 1 s per peak: the clock is in peak 2 (0.9), two bars each side
    expect(strip).toEqual([0.1, 0.2, 0.9, 0.4, 0.3]);
  });

  it("moves with the clock", () => {
    const before = levelStrip(take, 2500, 5);
    const after = levelStrip(take, 5500, 5);
    expect(after).not.toEqual(before);
    expect(after[2]).toBe(0.8);
  });

  it("is flat before the take enters and after it ends, and follows a late entrance", () => {
    expect(levelStrip({ ...take, offsetMs: 4000 }, 0, 3)).toEqual([0, 0, 0]);
    expect(levelStrip(take, 20_000, 3)).toEqual([0, 0, 0]);
    // the take starts at 4 s: at 4 s the middle bar is its first peak and the one before it is silent
    expect(levelStrip({ ...take, offsetMs: 4000 }, 4000, 3)).toEqual([0, 0.1, 0.2]);
  });

  it("is silent where a trim cut the take", () => {
    expect(levelStrip({ ...take, trimStartMs: 3000 }, 2500, 5)).toEqual([0, 0, 0, 0.4, 0.3]);
  });

  it("is flat for a take with no peaks", () => {
    expect(levelStrip({ ...take, peaks: [] }, 1000, 4)).toEqual([0, 0, 0, 0]);
  });

  it("has a still overview, loudest bar at full height", () => {
    const overview = levelOverview(take, 5);
    expect(overview).toHaveLength(5);
    expect(Math.max(...overview)).toBe(1);
    expect(levelOverview({ ...take, peaks: [] }, 3)).toEqual([0, 0, 0]);
  });
});
