import { describe, expect, it } from "vitest";
import { heroHue, heroTintStyle, initialsFor } from "./hero-tint";

/**
 * The generated field behind a subject with no picture.
 *
 * Two things can actually be wrong here and both are pinned below: the hue must
 * be STABLE (a page that changes colour between loads is a page whose
 * screenshot is a lie) and the style object must name only custom properties —
 * the moment it emits a literal colour, the bench's leak ratchet fails CI and
 * the theme stops being able to reach these surfaces.
 */

describe("heroHue", () => {
  it("is stable for a given seed", () => {
    // The whole value of a generated tint: it does not move between loads,
    // between pages, or between devices.
    expect(heroHue("valorant-brasil")).toBe(heroHue("valorant-brasil"));
  });

  it("stays inside a hue circle", () => {
    for (const seed of ["", "a", "rafa", "valorant-brasil", "🔥".repeat(50)]) {
      const hue = heroHue(seed);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(Number.isInteger(hue)).toBe(true);
    }
  });

  it("spreads different seeds apart", () => {
    // Not a distribution guarantee — just that neighbouring names do not all
    // land on the same colour, which is the failure that makes a grid of cards
    // look like one card repeated.
    const hues = new Set(
      ["rafa", "bia", "joao", "valorant", "futebol", "anime"].map(heroHue),
    );
    expect(hues.size).toBeGreaterThan(4);
  });

  it("hashes an emoji as one character", () => {
    // `charCodeAt` would split a surrogate pair and hash half of it.
    expect(() => heroHue("🔥")).not.toThrow();
    expect(heroHue("🔥")).not.toBe(heroHue("🔥🔥"));
  });
});

describe("heroTintStyle", () => {
  it("names only custom properties, never a colour", () => {
    // If this ever emits `oklch(...)` or a hex, `bench/theme-tokens.mjs` fails
    // CI at BENCH_MAX_LEAKS=0 — and more importantly the theme loses its grip
    // on the largest coloured area on the page.
    const style = heroTintStyle(120, 45) as Record<string, string>;
    const serialized = JSON.stringify(style);
    expect(serialized).not.toMatch(/oklch|rgba?\(|hsla?\(|#[0-9a-f]{3,8}/i);
    expect(style["--hero-hue"]).toBe("120");
    expect(style.backgroundImage).toContain("var(--hero-tint-near)");
    expect(style.backgroundImage).toContain("var(--hero-tint-far)");
  });

  it("keeps the far hue on the circle however far it is pushed", () => {
    const style = heroTintStyle(300, 40) as Record<string, string>;
    expect(Number(style["--hero-hue-far"])).toBeGreaterThanOrEqual(0);
    expect(Number(style["--hero-hue-far"])).toBeLessThan(360);
  });

  it("weakens the far end so the gradient reads as light, not as a cast", () => {
    const style = heroTintStyle(120, 50) as Record<string, string>;
    expect(style["--hero-tint-strength"]).toBe("50%");
    expect(style["--hero-tint-strength-far"]).toBe("35%");
  });
});

describe("initialsFor", () => {
  it("takes the first letter of the first two words", () => {
    expect(initialsFor("Eu Odeio Acordar Cedo")).toBe("EO");
    expect(initialsFor("Rafa")).toBe("R");
  });

  it("does not slice a surrogate pair in half", () => {
    // `name[0]` on an emoji is half a character and renders as a replacement
    // glyph, which is the one thing a fallback must never do.
    expect(initialsFor("🔥 Valorant")).toBe("🔥V");
  });

  it("answers something for a name that is nothing", () => {
    expect(initialsFor("   ")).toBe("?");
    expect(initialsFor("")).toBe("?");
  });
});
