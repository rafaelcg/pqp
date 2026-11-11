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
  it("the waveform scrolls at rest: running unless the row is off screen or the tab is hidden", () => {
    expect(block(".jam-row-art {")).toContain("--jam-run: running;");
    expect(block('.jam-row-art[data-alive="false"]')).toContain("--jam-run: paused !important;");
  });

  it("the waveform carries the whole palette, each bar at its instrument's full colour", () => {
    for (const inst of ["vocals", "guitar", "drums", "keys", "bass", "other"]) {
      expect(block(`.jam-wave-svg [data-inst="${inst}"]`)).toContain(`fill: var(--color-inst-${inst});`);
    }
    // Never a translucent blend of the fills: that is what turned to mud.
    expect(css).not.toMatch(/color-mix\([^)]*--color-inst-(vocals|drums|keys|bass|other)/);
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
    expect(block(".jam-wave-scroll {")).toMatch(/steps\(\d+\)/);
    expect(block('.jam-row-art[data-mood="playing"] .jam-wave-beat')).toMatch(/steps\(\d+\)/);
  });

  it("the livelier states drift faster than rest: hover, news, playing", () => {
    const speed = (selector: string) => Number(/--jam-speed: ([\d.]+);/.exec(block(selector))?.[1]);
    const rest = speed(".jam-row-art {");
    expect(speed("[data-jam-card]:hover .jam-row-art,")).toBeLessThan(rest);
    expect(speed('.jam-row-art[data-mood="news"] {')).toBeLessThan(speed("[data-jam-card]:hover .jam-row-art,"));
    expect(speed('.jam-row-art[data-mood="playing"] {')).toBeLessThan(speed('.jam-row-art[data-mood="news"] {'));
  });

  it("reduced motion removes the scroll, the beat, the sheen, the hop and the equaliser", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const selector of [".jam-wave-scroll", ".jam-wave-beat", ".jam-art-sheen", ".jam-icon-eq > span", ".jam-icon-note"]) {
      expect(reduced).toContain(selector);
    }
    expect(reduced).toContain("animation: none !important;");
  });

  it("keeps the name and the count on a plain base: no bar is drawn across the left of the row", () => {
    expect(block(".jam-wave {")).toMatch(/mask-image: linear-gradient\(90deg, transparent 4\d%/);
    expect(block("[data-jam-card]:hover .jam-wave,")).toMatch(/transparent 4\d%/);
  });

  it("one scroll loop is exactly the width of the bars drawn", () => {
    expect(block("@keyframes jam-row-wave")).toBeDefined();
    expect(css).toContain("translateX(-216px)");
  });
});
