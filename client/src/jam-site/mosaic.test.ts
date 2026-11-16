import { describe, expect, it } from "vitest";
import {
  layoutCoversBox,
  MOSAIC_MAX_TILES,
  mosaicLayout,
  spotlightLayout,
} from "./mosaic";

const WIDE = 16 / 9;
const TALL = 0.6;

describe("mosaicLayout", () => {
  it("covers its box exactly once for every count, wide and tall", () => {
    for (let n = 1; n <= MOSAIC_MAX_TILES; n++) {
      for (const aspect of [WIDE, TALL, 4 / 3, 1.0]) {
        const layout = mosaicLayout(n, aspect);
        expect(layout.cells).toHaveLength(n);
        expect(layoutCoversBox(layout), `${n} tiles at ${aspect}`).toBe(true);
      }
    }
  });

  it("is a full frame for one and side by side for two", () => {
    expect(mosaicLayout(1, WIDE).cells).toEqual([{ col: 1, row: 1, colSpan: 1, rowSpan: 1 }]);
    const two = mosaicLayout(2, WIDE);
    expect(two.columns).toHaveLength(2);
    expect(two.rows).toHaveLength(1);
  });

  it("makes three one big tile and two small, wide", () => {
    const three = mosaicLayout(3, WIDE);
    expect(three.cells[0]).toEqual({ col: 1, row: 1, colSpan: 2, rowSpan: 2 });
    expect(three.cells[1]).toMatchObject({ col: 3, row: 1 });
    expect(three.cells[2]).toMatchObject({ col: 3, row: 2 });
  });

  it("makes four a two by two and nine a three by three", () => {
    expect(mosaicLayout(4, WIDE).columns).toHaveLength(2);
    expect(mosaicLayout(4, WIDE).rows).toHaveLength(2);
    expect(mosaicLayout(9, WIDE).columns).toHaveLength(3);
    expect(mosaicLayout(9, WIDE).rows).toHaveLength(3);
  });

  it("gives the first tile the full width when a phone has an odd count", () => {
    expect(mosaicLayout(3, TALL).cells[0]).toMatchObject({ colSpan: 2, rowSpan: 1 });
    expect(mosaicLayout(7, TALL).cells[0]).toMatchObject({ colSpan: 3 });
  });

  it("never makes a sliver: every tile is at least a quarter of its row in width and its box in height", () => {
    for (let n = 1; n <= MOSAIC_MAX_TILES; n++) {
      for (const aspect of [WIDE, TALL]) {
        const layout = mosaicLayout(n, aspect);
        const w = layout.columns.reduce((a, b) => a + b, 0);
        const h = layout.rows.reduce((a, b) => a + b, 0);
        for (const cell of layout.cells) {
          const cw = (cell.colSpan / w) * layout.aspect;
          const ch = cell.rowSpan / h;
          const ratio = cw / ch;
          expect(ratio, `${n} tiles at ${aspect}`).toBeGreaterThan(0.3);
          expect(ratio, `${n} tiles at ${aspect}`).toBeLessThan(5);
        }
      }
    }
  });

  it("keeps a wide aspect between what a stage can be and answers the table's aspect when tall", () => {
    expect(mosaicLayout(4, 4).aspect).toBeLessThanOrEqual(2.1);
    expect(mosaicLayout(4, 1.1).aspect).toBeGreaterThanOrEqual(1.35);
    expect(mosaicLayout(1, TALL).aspect).toBeCloseTo(0.8);
    expect(mosaicLayout(4, TALL).orientation).toBe("tall");
  });

  it("clamps a nonsense count", () => {
    expect(mosaicLayout(0, WIDE).cells).toHaveLength(1);
    expect(mosaicLayout(500, WIDE).cells).toHaveLength(MOSAIC_MAX_TILES);
    expect(mosaicLayout(Number.NaN, WIDE).cells).toHaveLength(1);
  });
});

describe("spotlightLayout", () => {
  it("covers its box for every count and every spotlit tile", () => {
    for (let n = 2; n <= MOSAIC_MAX_TILES; n++) {
      for (let spot = 0; spot < n; spot++) {
        for (const aspect of [WIDE, TALL]) {
          const layout = spotlightLayout(n, spot, aspect);
          expect(layout.cells, `${n}/${spot}/${aspect}`).toHaveLength(n);
          expect(layoutCoversBox(layout), `${n}/${spot}/${aspect}`).toBe(true);
        }
      }
    }
  });

  it("puts the spotlit tile big on the left, wide, wherever it is in the list", () => {
    const layout = spotlightLayout(4, 2, WIDE);
    expect(layout.cells[2]).toEqual({ col: 1, row: 1, colSpan: 1, rowSpan: 3 });
    expect(layout.columns).toEqual([3, 1]);
    // the others stack on the right, in list order
    expect(layout.cells[0]).toMatchObject({ col: 2, row: 1 });
    expect(layout.cells[1]).toMatchObject({ col: 2, row: 2 });
    expect(layout.cells[3]).toMatchObject({ col: 2, row: 3 });
  });

  it("uses two small columns past four others, the odd one spanning both", () => {
    const layout = spotlightLayout(6, 0, WIDE);
    expect(layout.columns).toEqual([3, 1, 1]);
    expect(layout.cells[5]).toMatchObject({ colSpan: 2 });
  });

  it("puts it on top, tall, with the others as squares under it", () => {
    const layout = spotlightLayout(4, 1, TALL);
    expect(layout.cells[1]).toEqual({ col: 1, row: 1, colSpan: 3, rowSpan: 1 });
    expect(layout.cells[0]).toMatchObject({ row: 2, col: 1 });
    expect(layout.cells[3]).toMatchObject({ row: 2, col: 3 });
    expect(layout.aspect).toBeLessThan(1);
  });

  it("falls back to the plain mosaic for one tile or a spot that is not there", () => {
    expect(spotlightLayout(1, 0, WIDE)).toEqual(mosaicLayout(1, WIDE));
    expect(spotlightLayout(4, 9, WIDE)).toEqual(mosaicLayout(4, WIDE));
    expect(spotlightLayout(4, -1, WIDE)).toEqual(mosaicLayout(4, WIDE));
  });
});
