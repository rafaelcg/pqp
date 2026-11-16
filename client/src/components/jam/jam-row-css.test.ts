// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What the row's stylesheet promises, read as text: jsdom has no animation
 * engine, so these are the rules that cannot drift unnoticed.
 */
const css = readFileSync(new URL("./jam-row.css", import.meta.url), "utf8");

describe("jam-row.css", () => {
  it("the plate is plain: no waveform, no sheen, no edge marker, no instrument colour on it", () => {
    for (const gone of [".jam-wave", ".jam-art-sheen", ".jam-art-here", "jam-row-wave", "jam-row-hop"]) {
      expect(css, gone).not.toContain(gone);
    }
    const plate = css.slice(0, css.indexOf("/* ---- the icon"));
    expect(plate).not.toContain("--color-inst-");
    expect(plate).not.toContain("animation:");
  });

  it("the only animation is the icon's equaliser, on transform alone", () => {
    const names = [...css.matchAll(/@keyframes ([\w-]+)/g)].map((match) => match[1]);
    expect(names).toEqual(["jam-row-eq-icon"]);
    for (const keyframes of css.matchAll(/@keyframes [\w-]+ \{([\s\S]*?)\n\}/g)) {
      const props = [...keyframes[1]!.matchAll(/^\s{4}([a-z-]+):/gm)].map((match) => match[1]);
      expect(props.every((prop) => prop === "transform")).toBe(true);
    }
  });

  it("reduced motion stops the equaliser", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".jam-icon-eq > span");
    expect(reduced).toContain("animation: none !important;");
  });
});
