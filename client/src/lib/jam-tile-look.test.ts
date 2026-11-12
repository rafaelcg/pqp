import { describe, expect, it } from "vitest";
import { jamTileLook, JAM_TILE_LOOK, placeItemsOnCells } from "./jam-tile-look";
import { levelHeight, levelTransform } from "./jam-tile-parts";
import { cellAreas, mosaicLayout } from "../jam-site/mosaic";

describe("the one tile look", () => {
  it("has an opaque ground token and an ink for every instrument, and no translucent wash", () => {
    for (const look of Object.values(JAM_TILE_LOOK)) {
      expect(look.ground).toMatch(/^bg-tile-[a-z]+$/);
      expect(look.ink).toMatch(/^text-tile-[a-z]+-ink$/);
      expect(`${look.ground} ${look.ink} ${look.dashed}`).not.toMatch(/color-mix|\/\d+/);
    }
  });

  it("reads an instrument a newer server may send as other", () => {
    expect(jamTileLook("theremin")).toBe(JAM_TILE_LOOK.other);
    expect(jamTileLook("bass")).toBe(JAM_TILE_LOOK.bass);
  });

  it("gives no two instruments the same ground", () => {
    const grounds = Object.values(JAM_TILE_LOOK).map((look) => look.ground);
    expect(new Set(grounds).size).toBe(grounds.length);
  });
});

describe("placeItemsOnCells: an invitation never outranks a recording", () => {
  it("keeps everything where it is when every cell is the same size", () => {
    expect(placeItemsOnCells([1, 1, 1, 1], [false, false, false, true])).toEqual([0, 1, 2, 3]);
  });

  it("puts the slot on the smallest cell, the recordings on the rest in reading order", () => {
    // five items on a 3-over-2: three small cells, then two big ones
    const areas = [2, 2, 2, 3, 3];
    const where = placeItemsOnCells(areas, [false, false, false, false, true]);
    expect(where).toEqual([0, 1, 3, 4, 2]);
    expect(areas[where[4]!]).toBe(Math.min(...areas));
    // every cell is used once
    expect(new Set(where).size).toBe(5);
  });

  it("changes nothing when there is no slot", () => {
    expect(placeItemsOnCells([2, 2, 3, 3], [false, false, false, false])).toEqual([0, 1, 2, 3]);
  });

  it("holds on the real layouts: for every count the slot's cell is no bigger than any recording's", () => {
    for (const aspect of [0.8, 1.6, 2.1]) {
      for (let count = 2; count <= 10; count += 1) {
        const layout = mosaicLayout(count, aspect);
        const areas = cellAreas(layout);
        const slots = Array.from({ length: count }, (_, index) => index === count - 1);
        const where = placeItemsOnCells(areas, slots);
        expect(new Set(where).size).toBe(count);
        const slotArea = areas[where[count - 1]!]!;
        for (let item = 0; item < count - 1; item += 1) {
          expect(slotArea).toBeLessThanOrEqual(areas[where[item]!]!);
        }
      }
    }
  });
});

describe("the level strip", () => {
  it("draws silence as no bar (the strip draws one baseline) and anything audible as a visible one", () => {
    expect(levelHeight(0)).toBe(0);
    expect(levelHeight(0.02)).toBe(0);
    expect(levelHeight(0.05)).toBeGreaterThan(0.14);
    expect(levelHeight(1)).toBe(1);
    expect(levelHeight(Number.NaN)).toBe(0);
    expect(levelTransform(0)).toBe("scaleY(0.000)");
  });
});
