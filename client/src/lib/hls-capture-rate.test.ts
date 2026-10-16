import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCREEN_FRAME_RATE,
  hlsCaptureMaxFrameRate,
  parseScreenFrameRate,
  publishMaxFrameRateFromTrack,
  screenCaptureMaxFrameRate,
  shareLadderMaxFrameRate,
} from "./hls-capture-rate";
import { screenCaptureOptions } from "./screen-capture-audio";

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

describe("shareLadderMaxFrameRate", () => {
  const defaultLadder = [{ framerate: 30 }, { framerate: 30 }];

  it("does not hold an ordinary share to a 30 fps watch-party ladder", () => {
    // Bug 123. Production's ladder is 720p30,480p30 and the server has HLS on,
    // which used to answer 30 for a share in a plain voice channel, a DM call
    // and anywhere else. Auto on such a share must ask the capture for 60.
    const ladderMax = shareLadderMaxFrameRate({
      feedsHls: false,
      hlsEnabled: true,
      ladder: defaultLadder,
    });
    expect(ladderMax).toBe(60);
    expect(
      screenCaptureMaxFrameRate({ preference: "auto", hlsLadderMax: ladderMax }),
    ).toBe(60);
  });

  it("still follows the ladder for a share that feeds the egress", () => {
    expect(
      shareLadderMaxFrameRate({
        feedsHls: true,
        hlsEnabled: true,
        ladder: defaultLadder,
      }),
    ).toBe(30);
    expect(
      shareLadderMaxFrameRate({
        feedsHls: true,
        hlsEnabled: true,
        ladder: [{ framerate: 60 }, { framerate: 30 }],
      }),
    ).toBe(60);
  });

  it("is 60 whenever HLS is off or unanswered for the party's server", () => {
    for (const hlsEnabled of [false, null, undefined]) {
      expect(
        shareLadderMaxFrameRate({
          feedsHls: true,
          hlsEnabled,
          ladder: defaultLadder,
        }),
      ).toBe(60);
    }
  });

  it("an explicit 30 is still honoured on an ordinary share", () => {
    expect(
      screenCaptureMaxFrameRate({
        preference: "30",
        hlsLadderMax: shareLadderMaxFrameRate({
          feedsHls: false,
          hlsEnabled: true,
          ladder: defaultLadder,
        }),
      }),
    ).toBe(30);
  });
});

describe("what a Windows desktop share is finally asked for (bug 123)", () => {
  // The Windows shell, a server with live HLS on and the production ladder.
  const windowsShell = {
    isDesktopShell: true,
    shellPlatform: "win32",
    supportsRestrictOwnAudio: false,
    osCanExcludeCallAudio: false,
    sharePickerOffersAudio: false,
    shellSystemAudio: null,
    shellRestrictOwnAudio: null,
  };
  const productionLadder = [{ framerate: 30 }, { framerate: 30 }];

  function askedFrameRate(feedsHls: boolean, preference: "auto" | "30" | "60") {
    const maxFrameRate = screenCaptureMaxFrameRate({
      preference,
      hlsLadderMax: shareLadderMaxFrameRate({
        feedsHls,
        hlsEnabled: true,
        ladder: productionLadder,
      }),
    });
    const video = screenCaptureOptions(false, windowsShell, { maxFrameRate })
      .video as { frameRate: { ideal: number; max: number } };
    return video.frameRate;
  }

  it("Auto in an ordinary voice channel captures at 60", () => {
    expect(askedFrameRate(false, "auto")).toEqual({ ideal: 60, max: 60 });
  });

  it("Auto in a watch party on a 30 fps ladder still captures at 30", () => {
    expect(askedFrameRate(true, "auto")).toEqual({ ideal: 30, max: 30 });
  });

  it("an explicit 60 wins even inside a watch party", () => {
    expect(askedFrameRate(true, "60")).toEqual({ ideal: 60, max: 60 });
  });
});
