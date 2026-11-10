// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What the row's stylesheet promises, read as text: jsdom has no animation
 * engine, so these are the rules that cannot drift unnoticed.
 */
const css = readFileSync(new URL("./jam-row.css", import.meta.url), "utf8");

function block(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("jam-row.css", () => {
  it("the wash drifts at rest: running unless the row is off screen or the tab is hidden", () => {
    expect(block(".jam-row-art {")).toContain("--jam-run: running;");
    expect(block('.jam-row-art[data-alive="false"]')).toContain("--jam-run: paused !important;");
  });

  it("the wash carries the whole palette at rest", () => {
    const aurora = block(".jam-aurora {");
    for (const inst of ["vocals", "guitar", "drums", "keys", "bass", "other"]) {
      expect(aurora).toContain(`--color-inst-${inst}`);
    }
  });

  it("only transform and opacity are ever animated", () => {
    for (const keyframes of css.matchAll(/@keyframes [\w-]+ \{([\s\S]*?)\n\}/g)) {
      const props = [...keyframes[1]!.matchAll(/^\s{4}([a-z-]+):/gm)].map((match) => match[1]);
      for (const prop of props) {
        expect(["transform", "opacity"], `${prop} in ${keyframes[0].split("{")[0]}`).toContain(prop);
      }
    }
  });

  it("is stepped, so a slow drift does not ask the compositor for a frame per refresh", () => {
    expect(block(".jam-aurora {")).toMatch(/steps\(\d+\)/);
  });

  it("the livelier states drift faster than rest: hover, news, playing", () => {
    const speed = (selector: string) => Number(/--jam-speed: ([\d.]+);/.exec(block(selector))?.[1]);
    const rest = speed(".jam-row-art {");
    expect(speed("[data-jam-card]:hover .jam-row-art,")).toBeLessThan(rest);
    expect(speed('.jam-row-art[data-mood="news"] {')).toBeLessThan(speed("[data-jam-card]:hover .jam-row-art,"));
    expect(speed('.jam-row-art[data-mood="playing"] {')).toBeLessThan(speed('.jam-row-art[data-mood="news"] {'));
  });

  it("reduced motion removes the wash, the sheen, the hop and the equaliser", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const selector of [".jam-aurora", ".jam-art-sheen", ".jam-icon-eq > span", ".jam-icon-note"]) {
      expect(reduced).toContain(selector);
    }
    expect(reduced).toContain("animation: none !important;");
  });

  it("keeps the name and the count on a plain base: the scrim is solid across the left of the row", () => {
    expect(block(".jam-art-scrim {")).toMatch(/var\(--jam-base\) 4\d%/);
  });
});
