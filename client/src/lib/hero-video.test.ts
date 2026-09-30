import { describe, expect, it } from "vitest";
import { HERO_VIDEO_MEDIA, heroVideoAllowed } from "./hero-video";

function win(opts: {
  matches: boolean;
  connection?: { saveData?: boolean; effectiveType?: string };
  throws?: boolean;
}): Window {
  return {
    matchMedia: (query: string) => {
      if (opts.throws) throw new Error("no matchMedia");
      expect(query).toBe(HERO_VIDEO_MEDIA);
      return { matches: opts.matches };
    },
    navigator: { connection: opts.connection },
  } as unknown as Window;
}

describe("heroVideoAllowed", () => {
  it("is for a wide window with a mouse, and asks the browser for exactly that", () => {
    expect(heroVideoAllowed(win({ matches: true }))).toBe(true);
    expect(HERO_VIDEO_MEDIA).toContain("min-width: 1024px");
    expect(HERO_VIDEO_MEDIA).toContain("hover: hover");
    expect(HERO_VIDEO_MEDIA).toContain("pointer: fine");
  });

  it("is not for phones and tablets", () => {
    expect(heroVideoAllowed(win({ matches: false }))).toBe(false);
  });

  it("respects Data Saver", () => {
    expect(
      heroVideoAllowed(win({ matches: true, connection: { saveData: true } })),
    ).toBe(false);
  });

  it("is not for a slow connection", () => {
    for (const effectiveType of ["slow-2g", "2g", "3g"]) {
      expect(
        heroVideoAllowed(win({ matches: true, connection: { effectiveType } })),
        effectiveType,
      ).toBe(false);
    }
    expect(
      heroVideoAllowed(win({ matches: true, connection: { effectiveType: "4g" } })),
    ).toBe(true);
  });

  it("says no where the browser cannot answer", () => {
    expect(heroVideoAllowed(win({ matches: true, throws: true }))).toBe(false);
  });
});
