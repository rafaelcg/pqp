import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROW_HEIGHT,
  WINDOW_CONFIG,
  anchorShift,
  buildOffsets,
  indexAtOffset,
  meanRowHeight,
  planSegments,
  selectionKeepRange,
  topToCenterRow,
  totalHeightOf,
  windowPressure,
  windowRange,
  type WindowConfig,
} from "./message-window";

const uniform = (count: number, height = 50) =>
  buildOffsets(count, () => height);

const small: WindowConfig = {
  overscanPx: 200,
  minOverscanRows: 2,
  maxRows: 40,
  renderAllUpTo: 10,
};

describe("buildOffsets", () => {
  it("is the prefix sums, with the total last", () => {
    const offsets = buildOffsets(4, (i) => [10, 20, 30, 40][i]!);
    expect([...offsets]).toEqual([0, 10, 30, 60, 100]);
    expect(totalHeightOf(offsets)).toBe(100);
  });

  it("treats a bad height as nothing rather than poisoning every offset after it", () => {
    const offsets = buildOffsets(3, (i) => [10, Number.NaN, 10][i]!);
    expect([...offsets]).toEqual([0, 10, 10, 20]);
  });

  it("handles no rows", () => {
    expect(totalHeightOf(buildOffsets(0, () => 1))).toBe(0);
  });
});

describe("indexAtOffset", () => {
  const offsets = buildOffsets(5, () => 100);

  it("finds the row that owns a position, top edge included", () => {
    expect(indexAtOffset(offsets, 0)).toBe(0);
    expect(indexAtOffset(offsets, 99.9)).toBe(0);
    expect(indexAtOffset(offsets, 100)).toBe(1);
    expect(indexAtOffset(offsets, 250)).toBe(2);
  });

  it("clamps past either end", () => {
    expect(indexAtOffset(offsets, -50)).toBe(0);
    expect(indexAtOffset(offsets, 500)).toBe(4);
    expect(indexAtOffset(offsets, 9999)).toBe(4);
  });

  it("answers -1 with no rows", () => {
    expect(indexAtOffset(buildOffsets(0, () => 1), 10)).toBe(-1);
  });

  it("agrees with a linear scan on uneven rows", () => {
    const heights = Array.from({ length: 300 }, (_, i) => 20 + ((i * 37) % 90));
    const uneven = buildOffsets(300, (i) => heights[i]!);
    for (let y = 0; y < totalHeightOf(uneven); y += 97) {
      let expected = 0;
      for (let i = 0; i < 300; i += 1) {
        if (uneven[i]! <= y) {
          expected = i;
        }
      }
      expect(indexAtOffset(uneven, y)).toBe(expected);
    }
  });
});

describe("meanRowHeight", () => {
  it("is the default before anything is measured", () => {
    expect(meanRowHeight([])).toBe(DEFAULT_ROW_HEIGHT);
  });

  it("averages what was measured and ignores junk", () => {
    expect(meanRowHeight([20, 40, 0, Number.NaN, -5])).toBe(30);
  });
});

describe("windowRange", () => {
  it("renders a short transcript whole", () => {
    expect(windowRange(uniform(10), 0, 300, small)).toEqual({ start: 0, end: 10 });
  });

  it("is the visible rows plus the overscan, and nothing else", () => {
    const offsets = uniform(1000);
    // Viewport 25000..25400 is rows 500..507, overscan 200px is 4 rows (the
    // row at 25600 is 512, and the end is exclusive).
    const range = windowRange(offsets, 25_000, 400, small);
    expect(range).toEqual({ start: 496, end: 513 });
  });

  it("clamps at the top and the bottom of the transcript", () => {
    const offsets = uniform(1000);
    expect(windowRange(offsets, 0, 400, small).start).toBe(0);
    const bottom = windowRange(offsets, totalHeightOf(offsets), 400, small);
    expect(bottom.end).toBe(1000);
    expect(bottom.start).toBeGreaterThan(900);
  });

  it("follows the tail when asked for a position past the end", () => {
    const offsets = uniform(1000);
    const range = windowRange(offsets, 10_000_000, 400, small);
    expect(range.end).toBe(1000);
  });

  it("keeps a minimum number of rows around the visible ones even when they are tall", () => {
    const offsets = buildOffsets(200, () => 2000);
    const range = windowRange(offsets, 100 * 2000, 800, small);
    expect(range.start).toBeLessThanOrEqual(98);
    expect(range.end).toBeGreaterThanOrEqual(103);
  });

  it("never asks for more than maxRows, trimming the far side", () => {
    const offsets = buildOffsets(5000, () => 5);
    const range = windowRange(offsets, 10_000, 800, small);
    // 160 rows are visible, over the cap of 40: the cap trims only overscan.
    expect(range.end - range.start).toBe(160);
    // The visible rows (2000..2160) are still inside.
    expect(range.start).toBeLessThanOrEqual(2000);
    expect(range.end).toBeGreaterThanOrEqual(2160);
  });

  it("holds the default config to about two screens either side", () => {
    const offsets = uniform(2000, 55);
    const range = windowRange(offsets, 60_000, 900, WINDOW_CONFIG);
    expect(range.end - range.start).toBeLessThanOrEqual(WINDOW_CONFIG.maxRows);
    expect(range.end - range.start).toBeLessThan(120);
  });
});

describe("windowPressure", () => {
  const offsets = uniform(1000);
  const rendered = { start: 400, end: 440 }; // 20000..22000

  it("is none with room on both sides", () => {
    expect(windowPressure(offsets, rendered, 20_900, 400, 300)).toBe("none");
  });

  it("is soon when the overscan on one side runs low", () => {
    expect(windowPressure(offsets, rendered, 20_100, 400, 300)).toBe("soon");
    expect(windowPressure(offsets, rendered, 21_500, 400, 300)).toBe("soon");
  });

  it("is now when the viewport has left the rendered rows", () => {
    expect(windowPressure(offsets, rendered, 19_800, 400, 300)).toBe("now");
    expect(windowPressure(offsets, rendered, 21_800, 400, 300)).toBe("now");
  });

  it("never asks for more past the first or last row", () => {
    expect(windowPressure(offsets, { start: 0, end: 40 }, 0, 400, 300)).toBe("none");
    expect(windowPressure(offsets, { start: 960, end: 1000 }, 49_700, 400, 300)).toBe("none");
  });

  it("is none for a transcript rendered whole", () => {
    expect(windowPressure(offsets, { start: 0, end: 1000 }, 25_000, 400, 300)).toBe("none");
  });
});

describe("topToCenterRow", () => {
  const offsets = uniform(1000);

  it("puts the row in the middle of the viewport", () => {
    // Row 500 spans 25000..25050; a 450px viewport centred on it starts at 24800.
    expect(topToCenterRow(offsets, 500, 450)).toBe(24_800);
  });

  it("stops at the ends instead of asking for a position nobody can reach", () => {
    expect(topToCenterRow(offsets, 0, 450)).toBe(0);
    expect(topToCenterRow(offsets, 999, 450)).toBe(totalHeightOf(offsets) - 450);
  });
});

describe("planSegments", () => {
  const offsets = uniform(100, 10);

  it("is a leading gap, the rows, a trailing gap", () => {
    const segments = planSegments(offsets, { start: 30, end: 33 });
    expect(segments).toEqual([
      { kind: "gap", from: 0, to: 30, height: 300 },
      { kind: "row", index: 30 },
      { kind: "row", index: 31 },
      { kind: "row", index: 32 },
      { kind: "gap", from: 33, to: 100, height: 670 },
    ]);
  });

  it("has no gap where the window touches an end", () => {
    const segments = planSegments(offsets, { start: 0, end: 100 });
    expect(segments.every((segment) => segment.kind === "row")).toBe(true);
  });

  it("keeps a far row mounted between two gaps, in order", () => {
    const segments = planSegments(offsets, { start: 50, end: 52 }, [5]);
    expect(segments.map((s) => (s.kind === "row" ? s.index : `gap${s.from}-${s.to}`))).toEqual([
      "gap0-5",
      5,
      "gap6-50",
      50,
      51,
      "gap52-100",
    ]);
  });

  it("does not double a kept row that is already in the window, and ignores bad indices", () => {
    const segments = planSegments(offsets, { start: 10, end: 12 }, [11, -1, 500, 3.5]);
    expect(segments.filter((s) => s.kind === "row")).toHaveLength(2);
  });

  it("always adds up to the whole height, so mounted rows sit where they would unwindowed", () => {
    const uneven = buildOffsets(60, (i) => 20 + ((i * 13) % 70));
    const segments = planSegments(uneven, { start: 20, end: 30 }, [3, 55]);
    let height = 0;
    for (const segment of segments) {
      height +=
        segment.kind === "gap"
          ? segment.height
          : uneven[segment.index + 1]! - uneven[segment.index]!;
    }
    expect(height).toBeCloseTo(totalHeightOf(uneven), 6);
  });

  it("handles an empty transcript", () => {
    expect(planSegments(buildOffsets(0, () => 1), { start: 0, end: 0 })).toEqual([]);
  });
});

describe("anchorShift", () => {
  it("is zero when nothing but the reader's own scroll moved the row", () => {
    expect(
      anchorShift({ offsetNow: 70, offsetThen: 100, scrollTopNow: 530, scrollTopThen: 500 }),
    ).toBe(0);
  });

  it("is the growth of rows above the anchor", () => {
    // Rows above grew by 40px with no scroll: the anchor row is 40px lower.
    expect(
      anchorShift({ offsetNow: 140, offsetThen: 100, scrollTopNow: 500, scrollTopThen: 500 }),
    ).toBe(40);
  });

  it("separates layout shift from scrolling that happened in the same frame", () => {
    expect(
      anchorShift({ offsetNow: 100, offsetThen: 100, scrollTopNow: 560, scrollTopThen: 500 }),
    ).toBe(60);
  });
});

describe("selectionKeepRange", () => {
  it("covers both ends and everything between, whichever way it was dragged", () => {
    expect(selectionKeepRange(10, 14, 100)).toEqual({ start: 10, end: 15 });
    expect(selectionKeepRange(14, 10, 100)).toEqual({ start: 10, end: 15 });
  });

  it("is null for an end outside the rows or a selection too long to keep", () => {
    expect(selectionKeepRange(-1, 4, 100)).toBeNull();
    expect(selectionKeepRange(0, 500, 100)).toBeNull();
  });
});
