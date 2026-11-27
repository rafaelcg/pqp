import { readFileSync } from "node:fs";
import path from "node:path";
import { JAM_INSTRUMENTS } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "@/lib/design-tokens";
import { asInstrument, INSTRUMENT_LOOK, INSTRUMENTS, inkMix, isInstrument } from "./instruments";
import { tabKeeps } from "./use-jam-data";

describe("instruments", () => {
  it("are exactly the contract's, each with a look", () => {
    expect([...INSTRUMENTS].sort()).toEqual([...JAM_INSTRUMENTS].sort());
    for (const instrument of JAM_INSTRUMENTS) {
      expect(INSTRUMENT_LOOK[instrument].token).toBe(`--color-inst-${instrument}`);
    }
  });

  it("reads an instrument a newer server may send as other", () => {
    expect(asInstrument("theremin")).toBe("other");
    expect(asInstrument("bass")).toBe("bass");
    expect(isInstrument("theremin")).toBe(false);
  });
});

describe("the tabs that filter a page", () => {
  it("keep a song by what it still needs", () => {
    expect(tabKeeps("needs", { needs: ["bass"] })).toBe(true);
    expect(tabKeeps("needs", { needs: [] })).toBe(false);
    expect(tabKeeps("done", { needs: [] })).toBe(true);
    expect(tabKeeps("done", { needs: ["bass"] })).toBe(false);
    expect(tabKeeps("top", { needs: ["bass"] })).toBe(true);
    expect(tabKeeps("new", { needs: [] })).toBe(true);
  });
});

/**
 * "Falta uma guitarra." on the light page (launch screenshots, problem 9): the instrument's colour as
 * TEXT. The tokens are read from the stylesheets, so a change to either is measured, and the dark
 * page's recipe is pinned as it was.
 */
describe("an instrument's colour as text (inkMix)", () => {
  const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), "utf8");
  const index = read("src/index.css");
  const site = read("src/jam-site/jam-site.css");
  const lightBlock = index.slice(index.indexOf(':root[data-theme="light"] {'));
  const lightSurfaces = ["--color-surface-0", "--color-surface-1", "--color-surface-2"].map((name) => {
    const match = new RegExp(`${name}: (oklch\\([^)]*\\));`).exec(lightBlock);
    return match![1]!;
  });
  const lightTileInk = (instrument: string) =>
    new RegExp(`--color-tile-${instrument}-ink: (oklch\\([^)]*\\));`).exec(lightBlock)![1]!;

  it("on the light page every instrument's text clears WCAG AA (4.5:1) on all three surfaces", () => {
    expect(lightSurfaces).toHaveLength(3);
    const lightRule = site.slice(site.indexOf('html[data-jam-site][data-theme="light"] {'));
    for (const instrument of INSTRUMENTS) {
      expect(lightRule).toContain(`--jam-ink-${instrument}: var(--color-tile-${instrument}-ink);`);
      for (const surface of lightSurfaces) {
        const ratio = contrastRatio(lightTileInk(instrument), surface);
        expect(ratio, `${instrument} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("the dark page keeps the colour pulled 20% toward the text, exactly as before", () => {
    const darkRule = site.slice(site.indexOf("html[data-jam-site] {"), site.indexOf('html[data-jam-site][data-theme="light"] {'));
    for (const instrument of INSTRUMENTS) {
      expect(darkRule).toContain(
        `--jam-ink-${instrument}: color-mix(in oklab, var(--color-inst-${instrument}) var(--jam-ink-mix), var(--color-text));`,
      );
    }
    expect(darkRule).toContain("--jam-ink-mix: 80%;");
  });

  it("is asked for by name, with the old mix as the fallback", () => {
    expect(inkMix("guitar")).toBe("var(--jam-ink-guitar, color-mix(in oklab, var(--color-inst-guitar) 80%, var(--color-text)))");
  });
});
