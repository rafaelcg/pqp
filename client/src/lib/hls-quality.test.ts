import { describe, expect, it } from "vitest";
import {
  AUTO_HLS_QUALITY,
  applyHlsQualityLevel,
  describeHlsLevel,
  levelIndexFor,
  offeredHlsLevels,
  parseHlsQuality,
  readHlsQuality,
  writeHlsQuality,
} from "./hls-quality";

const LADDER = [
  { height: 720, bitrate: 1_928_000 },
  { height: 1080, bitrate: 4_628_000 },
];

describe("parseHlsQuality", () => {
  it("defaults to Auto", () => {
    expect(parseHlsQuality(null)).toEqual(AUTO_HLS_QUALITY);
    expect(parseHlsQuality("")).toEqual(AUTO_HLS_QUALITY);
  });

  it("survives a corrupt entry", () => {
    for (const junk of ["{", "null", "[]", '"720"', '{"height":"720"}']) {
      expect(parseHlsQuality(junk)).toEqual(AUTO_HLS_QUALITY);
    }
  });

  it("refuses a height that is not one", () => {
    expect(parseHlsQuality('{"height":0}')).toEqual(AUTO_HLS_QUALITY);
    expect(parseHlsQuality('{"height":-720}')).toEqual(AUTO_HLS_QUALITY);
  });

  it("reads a real pin", () => {
    expect(parseHlsQuality('{"height":480}')).toEqual({ height: 480 });
  });
});

describe("the stored preference without storage", () => {
  // The unit suite runs in `node`, so there is no `window` at all: exactly
  // what a browser with storage disabled looks like from in here. Neither
  // call may throw, and the read must answer with a working player.
  it("is Auto, and neither call throws", () => {
    expect(() => writeHlsQuality({ height: 720 })).not.toThrow();
    expect(readHlsQuality()).toEqual(AUTO_HLS_QUALITY);
  });
});

describe("offeredHlsLevels", () => {
  it("lists the rungs tallest first", () => {
    expect(offeredHlsLevels(LADDER)).toEqual([
      { height: 1080, index: 1 },
      { height: 720, index: 0 },
    ]);
  });

  it("drops a level with no height rather than showing a blank row", () => {
    expect(offeredHlsLevels([{ bitrate: 1 }, { height: 720 }])).toEqual([
      { height: 720, index: 1 },
    ]);
  });

  it("collapses duplicate heights", () => {
    expect(
      offeredHlsLevels([{ height: 720 }, { height: 720 }, { height: 1080 }]),
    ).toHaveLength(2);
  });
});

describe("levelIndexFor", () => {
  it("Auto is hls.js's own -1, so the caller does no translating", () => {
    expect(levelIndexFor(LADDER, AUTO_HLS_QUALITY)).toBe(-1);
  });

  it("a pin finds its rung by height, not by position", () => {
    expect(levelIndexFor(LADDER, { height: 1080 })).toBe(1);
    expect(levelIndexFor(LADDER, { height: 720 })).toBe(0);
    // Same pin, a ladder that renumbered underneath it (a rung refused for
    // budget, or the operator changed LIVE_HLS_LADDER).
    expect(levelIndexFor([{ height: 1080 }], { height: 1080 })).toBe(0);
  });

  it("a pin this ladder cannot honour falls back to Auto, not to a neighbour", () => {
    // Someone who pinned 480p to save mobile data must not be silently
    // handed 1080p because 480 is gone.
    expect(levelIndexFor(LADDER, { height: 480 })).toBe(-1);
  });
});

describe("describeHlsLevel", () => {
  it("names the rung the way a player names it", () => {
    expect(describeHlsLevel(1080)).toBe("1080p");
    expect(describeHlsLevel(480)).toBe("480p");
  });
});

describe("applyHlsQualityLevel", () => {
  it("a mid-stream pick uses nextLevel so the buffer is not flushed", () => {
    const hls = { currentLevel: 0, nextLevel: 0 };
    applyHlsQualityLevel(hls, 1, "next-fragment");
    expect(hls.nextLevel).toBe(1);
    expect(hls.currentLevel).toBe(0);
  });

  it("Auto on a running player is also nextLevel, so ABR does not flush", () => {
    const hls = { currentLevel: 1, nextLevel: 1 };
    applyHlsQualityLevel(hls, -1, "next-fragment");
    expect(hls.nextLevel).toBe(-1);
    expect(hls.currentLevel).toBe(1);
  });

  it("a fresh attach pins immediately, before the first segment plays", () => {
    const hls = { currentLevel: -1, nextLevel: -1 };
    applyHlsQualityLevel(hls, 1, "immediate");
    expect(hls.currentLevel).toBe(1);
    expect(hls.nextLevel).toBe(-1);
  });
});
