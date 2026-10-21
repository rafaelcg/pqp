import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  FALLBACK_BASE,
  fitStage,
  formatScale,
  hasTvAspect,
  measureRoom,
  pixelAspectFor,
  systemForExtension,
  TV_PIXEL_ASPECT,
  type StageSystem,
} from "./stage";

const VIEWS = [
  [1366, 768],
  [1920, 1080],
  [390, 844],
] as const;
const DPRS = [1, 2, 3] as const;

/**
 * The whole number of device pixels per source pixel Pixel perfeito picks, worked out by hand for
 * square pixels (null: under two, so it falls back to Encaixar). Rows are the views in VIEWS, columns dpr 1, 2, 3.
 */
const EXPECTED: Record<"nes" | "gb" | "gba" | "snes", Array<Array<number | null>>> = {
  nes: [
    [3, 6, 9],
    [4, 9, 13],
    [null, 3, 4],
  ],
  gb: [
    [5, 10, 16],
    [7, 15, 22],
    [2, 4, 7],
  ],
  gba: [
    [4, 9, 14],
    [6, 13, 20],
    [null, 3, 4],
  ],
  snes: [
    [3, 6, 10],
    [4, 9, 14],
    [null, 3, 4],
  ],
};

describe("fitStage, Pixel perfeito", () => {
  for (const [system, rows] of Object.entries(EXPECTED)) {
    const [baseW, baseH] = FALLBACK_BASE[system as StageSystem];
    VIEWS.forEach(([viewW, viewH], v) => {
      DPRS.forEach((dpr, d) => {
        const k = rows[v]![d]!;
        it(`${system} in ${viewW}x${viewH} at dpr ${dpr}: ${k === null ? "falls back to fit" : `${k} device pixels per pixel`}`, () => {
          const fit = fitStage({ viewW, viewH, baseW, baseH, par: 1, mode: "pixel", dpr });
          // whatever happens, the picture is inside the room
          expect(fit.width).toBeLessThanOrEqual(viewW + 1e-9);
          expect(fit.height).toBeLessThanOrEqual(viewH + 1e-9);
          if (k === null) {
            expect(fit.applied).toBe("fit");
            expect(fit.integerScale).toBeNull();
            // fitted: one side of the room is filled exactly
            const filled = Math.abs(fit.width - viewW) < 1e-6 || Math.abs(fit.height - viewH) < 1e-6;
            expect(filled).toBe(true);
            return;
          }
          expect(fit.applied).toBe("pixel");
          expect(fit.integerScale).toBe(k);
          expect(fit.scale).toBe(k);
          // each source pixel is exactly k physical pixels, both ways
          expect(fit.width * dpr).toBeCloseTo(baseW * k, 6);
          expect(fit.height * dpr).toBeCloseTo(baseH * k, 6);
          expect(fit.cssScale).toBeCloseTo(k / dpr, 9);
          // and k + 1 would not have fitted
          expect(baseW * (k + 1) > viewW * dpr || baseH * (k + 1) > viewH * dpr).toBe(true);
        });
      });
    });
  }

  it("counts in device pixels: a ratio that is not a whole number still gives whole physical pixels", () => {
    // 1366x768 fits 3.2 rows of NES at dpr 1 (3) and 6.4 at dpr 2 (6 device pixels, 3 CSS pixels): the same picture
    const one = fitStage({ viewW: 1366, viewH: 768, baseW: 256, baseH: 240, par: 1, mode: "pixel", dpr: 1 });
    const two = fitStage({ viewW: 1366, viewH: 768, baseW: 256, baseH: 240, par: 1, mode: "pixel", dpr: 2 });
    expect(one.height).toBe(720);
    expect(two.height).toBe(720);
    // a 1.5 ratio: 1920x1080 is 2880x1620 device pixels, 6 whole rows of NES fit (6.75), which is 4 CSS pixels
    const odd = fitStage({ viewW: 1920, viewH: 1080, baseW: 256, baseH: 240, par: 1, mode: "pixel", dpr: 1.5 });
    expect(odd.scale).toBe(6);
    expect(odd.cssScale).toBe(4);
    expect(odd.height).toBe(960);
  });
});

describe("fitStage, Encaixar", () => {
  it("fills the room on the tight side, at any scale", () => {
    const fit = fitStage({ viewW: 1366, viewH: 768, baseW: 256, baseH: 240, par: 1, mode: "fit", dpr: 1 });
    expect(fit.applied).toBe("fit");
    expect(fit.height).toBeCloseTo(768, 6);
    // 819.2 wide, rounded DOWN to a whole device pixel: never a hair over the room
    expect(fit.width).toBe(819);
    expect(fit.integerScale).toBe(3);
  });

  it("fits a phone portrait by its width", () => {
    const fit = fitStage({ viewW: 390, viewH: 844, baseW: 240, baseH: 160, par: 1, mode: "fit", dpr: 3 });
    expect(fit.width).toBeCloseTo(390, 6);
    expect(fit.height).toBeCloseTo(260, 6);
  });
});

describe("fitStage, Como na TV", () => {
  it("widens the NES by the 8:7 pixel and still counts whole rows", () => {
    const fit = fitStage({ viewW: 1920, viewH: 1080, baseW: 256, baseH: 240, par: TV_PIXEL_ASPECT, mode: "pixel", dpr: 1 });
    expect(fit.applied).toBe("pixel");
    expect(fit.scale).toBe(4);
    expect(fit.height).toBe(960);
    expect(fit.width).toBe(1170);
  });

  it("is a wider picture than square pixels in the same room", () => {
    const square = fitStage({ viewW: 800, viewH: 800, baseW: 256, baseH: 224, par: 1, mode: "fit", dpr: 1 });
    const tv = fitStage({ viewW: 800, viewH: 800, baseW: 256, baseH: 224, par: TV_PIXEL_ASPECT, mode: "fit", dpr: 1 });
    expect(tv.width / tv.height).toBeCloseTo((square.width / square.height) * TV_PIXEL_ASPECT, 2);
    expect(tv.width).toBeLessThanOrEqual(800 + 1e-9);
  });

  it("only the NES and the SNES have it", () => {
    expect(pixelAspectFor("nes", "tv")).toBe(TV_PIXEL_ASPECT);
    expect(pixelAspectFor("snes", "tv")).toBe(TV_PIXEL_ASPECT);
    for (const handheld of ["gb", "gbc", "gba"] as const) {
      expect(pixelAspectFor(handheld, "tv")).toBe(1);
      expect(hasTvAspect(handheld)).toBe(false);
    }
    expect(pixelAspectFor("nes", "square")).toBe(1);
  });
});

describe("fitStage, bad rooms", () => {
  it("answers nothing for a room with no size, and treats a bad pixel ratio as 1", () => {
    expect(fitStage({ viewW: 0, viewH: 500, baseW: 256, baseH: 240, par: 1, mode: "pixel", dpr: 1 }).width).toBe(0);
    expect(fitStage({ viewW: 500, viewH: 0, baseW: 256, baseH: 240, par: 1, mode: "fit", dpr: 1 }).height).toBe(0);
    const odd = fitStage({ viewW: 1024, viewH: 960, baseW: 256, baseH: 240, par: 1, mode: "pixel", dpr: 0 });
    expect(odd.scale).toBe(4);
  });

  it("a room an exact multiple wide does not lose a step to float error", () => {
    const fit = fitStage({ viewW: 768, viewH: 720, baseW: 256, baseH: 240, par: 1, mode: "pixel", dpr: 1 });
    expect(fit.scale).toBe(3);
  });
});

/**
 * The bug Rafael found in ten seconds: a full-screen GBA picture taller than the display. Whatever the room's
 * shape, the pixel ratio, the console, the mode and the TV pixel, the picture fits BOTH ways; Encaixar fills one
 * side to the device pixel; Pixel perfeito is a whole number of device pixels and only when it fits both ways.
 */
describe("the whole picture is always on screen", () => {
  const ROOMS: ReadonlyArray<readonly [string, number, number]> = [
    ["Rafael's laptop, 2000x1270", 2000, 1270],
    ["3:2", 1800, 1200],
    ["3:2 laptop, height limited for a NES", 1500, 1000],
    ["16:10", 1440, 900],
    ["16:10 big", 2560, 1600],
    ["16:9", 1920, 1080],
    ["16:9 small", 1366, 768],
    ["ultrawide 21:9", 3440, 1440],
    ["super ultrawide 32:9", 5120, 1440],
    ["portrait phone", 390, 844],
    ["portrait tablet", 820, 1180],
    ["a short strip", 1600, 300],
    ["odd sizes", 1333, 777],
  ];
  const DPR_VALUES = [1, 1.25, 1.5, 2, 3] as const;
  const SYSTEMS = ["nes", "snes", "gb", "gba"] as const;
  const near = 1e-6;

  for (const [label, viewW, viewH] of ROOMS) {
    for (const dpr of DPR_VALUES) {
      it(`${label} at dpr ${dpr}`, () => {
        for (const system of SYSTEMS) {
          const [baseW, baseH] = FALLBACK_BASE[system];
          for (const par of system === "nes" || system === "snes" ? [1, TV_PIXEL_ASPECT] : [1]) {
            for (const mode of ["pixel", "fit"] as const) {
              const fit = fitStage({ viewW, viewH, baseW, baseH, par, mode, dpr });
              const where = `${system} par ${par.toFixed(3)} ${mode}`;
              // never over the room, either way
              expect(fit.width, where).toBeLessThanOrEqual(viewW + near);
              expect(fit.height, where).toBeLessThanOrEqual(viewH + near);
              // whole device pixels
              expect(Math.abs(fit.width * dpr - Math.round(fit.width * dpr)), where).toBeLessThan(near);
              expect(Math.abs(fit.height * dpr - Math.round(fit.height * dpr)), where).toBeLessThan(near);
              const limit = Math.min((viewW * dpr) / (baseW * par), (viewH * dpr) / baseH);
              if (fit.applied === "pixel") {
                // a whole number of device pixels per row, the largest that fits both ways, and at least two
                expect(Number.isInteger(fit.scale), where).toBe(true);
                expect(fit.scale, where).toBe(Math.floor(limit + 1e-9));
                expect(fit.scale, where).toBeGreaterThanOrEqual(2);
                expect(fit.height * dpr, where).toBe(baseH * fit.scale);
              } else {
                // Encaixar touches the tight side, to within one device pixel
                const gapW = viewW * dpr - fit.width * dpr;
                const gapH = viewH * dpr - fit.height * dpr;
                expect(Math.min(gapW, gapH), where).toBeLessThan(1 + near);
                expect(fit.cssScale, where).toBeCloseTo(limit / dpr, 6);
              }
            }
          }
        }
      });
    }
  }

  it("a height-limited display: GBA on 2000x1270 is 7.9x by fit, never 8.1x, and 15 device pixels by pixel perfect", () => {
    const fit = fitStage({ viewW: 2000, viewH: 1270, baseW: 240, baseH: 160, par: 1, mode: "fit", dpr: 2 });
    expect(fit.height).toBe(1270);
    expect(fit.width).toBe(1905);
    expect(fit.cssScale).toBeCloseTo(1270 / 160, 6);
    const pixel = fitStage({ viewW: 2000, viewH: 1270, baseW: 240, baseH: 160, par: 1, mode: "pixel", dpr: 2 });
    expect(pixel.scale).toBe(15);
    expect([pixel.width, pixel.height]).toEqual([1800, 1200]);
  });

  it("a width-limited display: GBA on a portrait phone fills the width", () => {
    const fit = fitStage({ viewW: 390, viewH: 844, baseW: 240, baseH: 160, par: 1, mode: "fit", dpr: 3 });
    expect(fit.width).toBe(390);
    expect(fit.height).toBe(260);
  });

  it("an ultrawide display is height limited for every console", () => {
    for (const system of SYSTEMS) {
      const [baseW, baseH] = FALLBACK_BASE[system];
      const fit = fitStage({ viewW: 3440, viewH: 1440, baseW, baseH, par: 1, mode: "fit", dpr: 1 });
      expect(fit.height).toBe(1440);
      expect(fit.width).toBeLessThan(3440);
    }
  });
});

describe("fitStage follows a frame that changes size (a game switches modes while it plays)", () => {
  const room = { viewW: 2000, viewH: 1270, par: 1, dpr: 2 } as const;

  it("fills the limiting side of the room, and never crops, whatever the frame is now", () => {
    for (const [baseW, baseH] of [[256, 224], [256, 239], [512, 224], [512, 448], [512, 478], [256, 240], [160, 144], [240, 160]] as const) {
      for (const par of [1, TV_PIXEL_ASPECT]) {
        for (const mode of ["pixel", "fit"] as const) {
          const fit = fitStage({ ...room, baseW, baseH, par, mode });
          const tag = `${baseW}x${baseH} par ${par} ${mode}`;
          expect(fit.width, tag).toBeLessThanOrEqual(room.viewW + 1e-9);
          expect(fit.height, tag).toBeLessThanOrEqual(room.viewH + 1e-9);
          // the picture's shape is the frame's, in the pixel's aspect
          expect(fit.width / fit.height, tag).toBeCloseTo((baseW * par) / baseH, 1);
          if (mode === "fit") {
            const filled = Math.abs(fit.width - room.viewW) < 1 || Math.abs(fit.height - room.viewH) < 1;
            expect(filled, tag).toBe(true);
          }
        }
      }
    }
  });

  it("Encaixar: 224 lines then 239 lines in the same room is a new box each time, both height limited", () => {
    const a = fitStage({ ...room, baseW: 256, baseH: 224, mode: "fit" });
    const b = fitStage({ ...room, baseW: 256, baseH: 239, mode: "fit" });
    expect(a.height).toBe(1270);
    expect(b.height).toBe(1270);
    expect(a.width).not.toBe(b.width);
    expect(b.cssScale).toBeLessThan(a.cssScale);
  });

  it("Pixel perfeito takes the whole number of the CURRENT size: 11 rows of 224, 10 of 239", () => {
    const a = fitStage({ ...room, baseW: 256, baseH: 224, mode: "pixel" });
    const b = fitStage({ ...room, baseW: 256, baseH: 239, mode: "pixel" });
    expect(a.scale).toBe(11);
    expect(b.scale).toBe(10);
    expect(b.height * room.dpr).toBe(239 * 10);
    // and a hi-res frame is twice as wide, so it is width limited and a smaller whole number
    const c = fitStage({ ...room, baseW: 512, baseH: 224, mode: "pixel" });
    expect(c.scale).toBe(7);
    expect(c.width * room.dpr).toBe(512 * 7);
  });
});

describe("measureRoom", () => {
  it("is the stage's box, less the bezel's room on every side", () => {
    expect(measureRoom({ stageW: 1336, stageH: 896, windowW: 1400, windowH: 900, margin: 0 })).toEqual({ viewW: 1336, viewH: 896 });
    expect(measureRoom({ stageW: 1336, stageH: 896, windowW: 1400, windowH: 900, margin: 18 })).toEqual({ viewW: 1300, viewH: 860 });
  });

  it("never more than the window: a stage taller than the display (a layout that has not settled) is cut to it", () => {
    expect(measureRoom({ stageW: 2000, stageH: 1330, windowW: 2000, windowH: 1270, margin: 0 })).toEqual({ viewW: 2000, viewH: 1270 });
    expect(measureRoom({ stageW: 2400, stageH: 900, windowW: 2000, windowH: 1270, margin: 0 })).toEqual({ viewW: 2000, viewH: 900 });
  });

  it("a window that reports nothing (a test page, a hidden frame) leaves the stage's box alone", () => {
    expect(measureRoom({ stageW: 800, stageH: 600, windowW: 0, windowH: Number.NaN, margin: 0 })).toEqual({ viewW: 800, viewH: 600 });
    expect(measureRoom({ stageW: 0, stageH: 0, windowW: 0, windowH: 0, margin: 0 })).toEqual({ viewW: 0, viewH: 0 });
    // a hidden stage has no room, however big the window
    expect(measureRoom({ stageW: 0, stageH: 0, windowW: 2000, windowH: 1270, margin: 0 })).toEqual({ viewW: 0, viewH: 0 });
    expect(measureRoom({ stageW: 20, stageH: 20, windowW: 1000, windowH: 1000, margin: 18 })).toEqual({ viewW: 0, viewH: 0 });
  });
});

describe("the rest of the module", () => {
  it("knows the frame of every system and the extension of each", () => {
    expect(FALLBACK_BASE).toEqual({ nes: [256, 240], gb: [160, 144], gbc: [160, 144], gba: [240, 160], snes: [256, 224] });
    expect(systemForExtension(".nes")).toBe("nes");
    expect(systemForExtension(".gbc")).toBe("gbc");
    expect(systemForExtension(".sfc")).toBe("snes");
    expect(systemForExtension(".zip")).toBeNull();
    expect(systemForExtension("toString")).toBeNull();
  });

  it("starts with the TV look off and the scale following the room", () => {
    expect(DEFAULT_SETTINGS).toEqual({ scale: null, aspect: "square", crt: false, ambient: false, bezel: false });
  });

  it("says a scale without trailing zeros", () => {
    expect(formatScale(3)).toBe("3");
    expect(formatScale(2.5)).toBe("2.5");
    expect(formatScale(4 / 3)).toBe("1.33");
  });

  it("draws the canvas with hard pixel edges", () => {
    const css = readFileSync(new URL("./styles/stage.css", import.meta.url), "utf8");
    const rule = /\.loc-game canvas\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(rule).toContain("image-rendering: pixelated");
    expect(rule).toContain("image-rendering: crisp-edges");
  });
});
