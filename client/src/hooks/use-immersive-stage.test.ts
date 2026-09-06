import { describe, expect, it } from "vitest";
import {
  IMMERSIVE_MAX_HEIGHT_PX,
  IMMERSIVE_MEDIA_QUERY,
  resolveImmersive,
} from "./use-immersive-stage";

describe("resolveImmersive", () => {
  const base = {
    shareFocused: true,
    fullscreen: false,
    smallLandscape: true,
    dismissed: false,
  };

  it("a share on a phone held sideways takes the window", () => {
    expect(resolveImmersive(base)).toBe(true);
  });

  it("fullscreen always wins, dismissed or not, share or camera", () => {
    expect(
      resolveImmersive({ ...base, fullscreen: true, dismissed: true }),
    ).toBe(true);
    expect(
      resolveImmersive({
        shareFocused: false,
        fullscreen: true,
        smallLandscape: false,
        dismissed: false,
      }),
    ).toBe(true);
  });

  it("portrait, a tall window, or no share keeps the columns", () => {
    expect(resolveImmersive({ ...base, smallLandscape: false })).toBe(false);
    expect(resolveImmersive({ ...base, shareFocused: false })).toBe(false);
  });

  it("asking for the chat back is honoured until fullscreen", () => {
    expect(resolveImmersive({ ...base, dismissed: true })).toBe(false);
  });

  it("the media query names the phone-height ceiling", () => {
    expect(IMMERSIVE_MEDIA_QUERY).toContain("orientation: landscape");
    expect(IMMERSIVE_MEDIA_QUERY).toContain(`max-height: ${IMMERSIVE_MAX_HEIGHT_PX}px`);
    // An iPhone 14 sideways is 390 tall and a Pixel 7 is 412; a small laptop is 700+.
    expect(IMMERSIVE_MAX_HEIGHT_PX).toBeGreaterThan(412);
    expect(IMMERSIVE_MAX_HEIGHT_PX).toBeLessThan(700);
  });
});
