import { describe, expect, it } from "vitest";
import {
  hlsCaptureMaxFrameRate,
  publishMaxFrameRateFromTrack,
} from "./hls-capture-rate";

describe("hlsCaptureMaxFrameRate", () => {
  it("stays at 30 for the default 30 fps ladder", () => {
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
