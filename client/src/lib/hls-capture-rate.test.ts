import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCREEN_FRAME_RATE,
  hlsCaptureMaxFrameRate,
  parseScreenFrameRate,
  publishMaxFrameRateFromTrack,
  screenCaptureMaxFrameRate,
} from "./hls-capture-rate";

describe("hlsCaptureMaxFrameRate", () => {
  it("stays at 30 for a 30 fps ladder", () => {
    expect(
      hlsCaptureMaxFrameRate(
        [{ framerate: 30 }, { framerate: 30 }, { framerate: 30 }],
        true,
      ),
    ).toBe(30);
  });

  it("is 60 once HLS is on and any rung is 60", () => {
    expect(hlsCaptureMaxFrameRate([{ framerate: 60 }], true)).toBe(60);
    expect(
      hlsCaptureMaxFrameRate([{ framerate: 30 }, { framerate: 60 }], true),
    ).toBe(60);
  });

  it("stays at 30 until HLS is confirmed on for this server", () => {
    expect(hlsCaptureMaxFrameRate([{ framerate: 60 }])).toBe(30);
    expect(hlsCaptureMaxFrameRate([{ framerate: 60 }], false)).toBe(30);
    expect(hlsCaptureMaxFrameRate(null, true)).toBe(30);
    expect(hlsCaptureMaxFrameRate(undefined, true)).toBe(30);
    expect(hlsCaptureMaxFrameRate([], true)).toBe(30);
  });
});

describe("screenCaptureMaxFrameRate", () => {
  it("defaults to auto, which follows the ladder", () => {
    expect(DEFAULT_SCREEN_FRAME_RATE).toBe("auto");
    expect(
      screenCaptureMaxFrameRate({ preference: "auto", hlsLadderMax: 60 }),
    ).toBe(60);
    expect(
      screenCaptureMaxFrameRate({ preference: "auto", hlsLadderMax: 30 }),
    ).toBe(30);
  });

  it("lets the presenter pin 30 or 60 regardless of the ladder", () => {
    expect(
      screenCaptureMaxFrameRate({ preference: "30", hlsLadderMax: 60 }),
    ).toBe(30);
    expect(
      screenCaptureMaxFrameRate({ preference: "60", hlsLadderMax: 30 }),
    ).toBe(60);
  });

  it("falls back to auto for anything storage cannot name", () => {
    expect(parseScreenFrameRate("60")).toBe("60");
    expect(parseScreenFrameRate("30")).toBe("30");
    expect(parseScreenFrameRate("auto")).toBe("auto");
    for (const junk of ["120", "", null, undefined, 60, {}]) {
      expect(parseScreenFrameRate(junk)).toBe("auto");
    }
  });
});

describe("publishMaxFrameRateFromTrack", () => {
  it("publishes 60 only when the capture really is", () => {
    expect(
      publishMaxFrameRateFromTrack({ getSettings: () => ({ frameRate: 60 }) }),
    ).toBe(60);
    expect(
      publishMaxFrameRateFromTrack({ getSettings: () => ({ frameRate: 30 }) }),
    ).toBe(30);
    expect(publishMaxFrameRateFromTrack({ getSettings: () => ({}) })).toBe(30);
    expect(publishMaxFrameRateFromTrack({})).toBe(30);
  });
});
