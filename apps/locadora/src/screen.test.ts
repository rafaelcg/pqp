import { describe, expect, it } from "vitest";
import { createScreens, SCREENS, type Screen } from "./screen";

describe("the screen machine", () => {
  it("starts connecting and tells every listener where it came from", () => {
    const screens = createScreens();
    const seen: Array<[Screen, Screen]> = [];
    screens.onChange((next, previous) => seen.push([next, previous]));
    expect(screens.current).toBe("connecting");
    expect(screens.go("balcao")).toBe(true);
    expect(screens.go("loading")).toBe(true);
    expect(screens.go("palco")).toBe(true);
    expect(seen).toEqual([
      ["balcao", "connecting"],
      ["loading", "balcao"],
      ["palco", "loading"],
    ]);
  });

  it("stays quiet when the screen does not change", () => {
    const screens = createScreens("balcao");
    let calls = 0;
    screens.onChange(() => (calls += 1));
    expect(screens.go("balcao")).toBe(true);
    expect(calls).toBe(0);
  });

  it("lets nothing leave outside or ended", () => {
    for (const dead of ["outside", "ended"] as const) {
      const screens = createScreens("connecting");
      screens.go(dead);
      for (const next of SCREENS) {
        if (next !== dead) expect(screens.go(next), `${dead} -> ${next}`).toBe(false);
      }
      expect(screens.current).toBe(dead);
    }
  });
});
