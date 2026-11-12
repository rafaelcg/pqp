import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jamTileLook, JAM_TILE_LOOK, placeItemsOnCells } from "./jam-tile-look";
import { levelHeight, levelTransform } from "./jam-tile-parts";
import { cellAreas, mosaicLayout } from "../jam-site/mosaic";

describe("the one tile look", () => {
  it("has ONE neutral ground for every instrument and an ink of its own, and no translucent wash", () => {
    for (const look of Object.values(JAM_TILE_LOOK)) {
      expect(look.ground).toBe("bg-tile");
      expect(look.ink).toMatch(/^text-tile-[a-z]+-ink$/);
      expect(`${look.ground} ${look.ink} ${look.dashed} ${look.solid}`).not.toMatch(/color-mix|\/\d+/);
    }
  });

  it("reads an instrument a newer server may send as other", () => {
    expect(jamTileLook("theremin")).toBe(JAM_TILE_LOOK.other);
    expect(jamTileLook("bass")).toBe(JAM_TILE_LOOK.bass);
  });

  it("tells instruments apart by ink alone: no two share one", () => {
    const inks = Object.values(JAM_TILE_LOOK).map((look) => look.ink);
    expect(new Set(inks).size).toBe(inks.length);
  });
});

describe("the six instrument fills", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.css"), "utf8");
  const fill = (name: string): [number, number, number] => {
    const match = new RegExp(`--color-inst-${name}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\)`).exec(css);
    if (!match) throw new Error(`no fill for ${name}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const lab = ([l, c, h]: [number, number, number]) => [l, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)] as const;
  const distance = (a: [number, number, number], b: [number, number, number]) => {
    const [l1, a1, b1] = lab(a);
    const [l2, a2, b2] = lab(b);
    return Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 100;
  };
  const names = ["guitar", "bass", "drums", "vocals", "keys", "other"];

  it("gives `other` a colour of its own, not a grey that reads as disabled", () => {
    const [, chroma] = fill("other");
    expect(chroma).toBeGreaterThan(0.1);
  });

  it("keeps every pair of fills apart (OKLab, x100), `other` included", () => {
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        expect(distance(fill(names[i]!), fill(names[j]!)), `${names[i]} vs ${names[j]}`).toBeGreaterThanOrEqual(13);
      }
    }
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
