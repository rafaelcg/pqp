import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyCameraQuality,
  cameraBitrateFor,
  cameraConstraintsFor,
  captureCamera,
  DEFAULT_VIDEO_QUALITY,
  parseVideoQuality,
  screenBitrateFor,
  screenScaleFactor,
  VIDEO_QUALITIES,
} from "./video-quality";

/**
 * The failure paths, mostly.
 *
 * This module sits on the live voice path of a product people are using right
 * now, and its whole promise is that choosing a quality can never be the
 * reason somebody loses their camera. A happy-path test proves nothing about
 * that promise; what follows is mostly hardware saying no in the several ways
 * hardware says no.
 */

beforeEach(() => {
  // The fallbacks warn on purpose. Silenced so a passing run stays readable.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const named = (name: string) => {
  const err = new Error(name);
  err.name = name;
  return err;
};

const fakeStream = (id: string) => ({ id }) as unknown as MediaStream;

describe("cameraConstraintsFor", () => {
  it("asks with ideal, never exact, for every quality", () => {
    for (const quality of VIDEO_QUALITIES) {
      const constraints = cameraConstraintsFor(quality);
      // Serialised rather than inspected field by field: an `exact` anywhere in
      // the tree is the regression, wherever somebody puts it.
      expect(JSON.stringify(constraints)).not.toContain("exact");
      expect(constraints.width).toHaveProperty("ideal");
      expect(constraints.height).toHaveProperty("ideal");
      expect(constraints.frameRate).toHaveProperty("ideal");
    }
  });

  it("asks for 720p on auto rather than leaving it to the browser", () => {
    // The 480p ceiling this whole change exists to remove came from an
    // unconstrained request. Auto must still be a request.
    expect(cameraConstraintsFor("auto")).toEqual(cameraConstraintsFor("720p"));
    expect(cameraConstraintsFor("auto").width).toEqual({ ideal: 1280 });
  });

  it("gives a bigger picture a bigger ceiling, in order", () => {
    const rungs = ["360p", "480p", "720p", "1080p"] as const;
    const bitrates = rungs.map((rung) => cameraBitrateFor(rung));
    expect(bitrates).toEqual([...bitrates].sort((a, b) => a - b));
    expect(new Set(bitrates).size).toBe(rungs.length);
  });
});

describe("parseVideoQuality", () => {
  it("accepts every level it offers", () => {
    for (const quality of VIDEO_QUALITIES) {
      expect(parseVideoQuality(quality)).toBe(quality);
    }
  });

  it("falls back to the default for anything else", () => {
    for (const junk of ["4k", "", null, undefined, 720, {}]) {
      expect(parseVideoQuality(junk)).toBe(DEFAULT_VIDEO_QUALITY);
    }
  });

  it("defaults to auto, which is the only acceptable default", () => {
    expect(DEFAULT_VIDEO_QUALITY).toBe("auto");
  });
});

describe("captureCamera", () => {
  it("asks for the chosen quality first", async () => {
    const getUserMedia = vi.fn().mockResolvedValue(fakeStream("a"));
    await captureCamera(getUserMedia, "1080p");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({
      video: cameraConstraintsFor("1080p"),
      audio: false,
    });
  });

  it("retries bare when the camera refuses the size", async () => {
    // The failure mode this whole file exists for: a webcam that cannot do
    // 720p must give 480p video, not an error and a dead camera button.
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(named("OverconstrainedError"))
      .mockResolvedValueOnce(fakeStream("fallback"));
    const stream = await captureCamera(getUserMedia, "720p");
    expect(stream.id).toBe("fallback");
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: true,
      audio: false,
    });
  });

  it("retries bare for an unrecognised refusal too", async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(named("AbortError"))
      .mockResolvedValueOnce(fakeStream("fallback"));
    await expect(captureCamera(getUserMedia, "480p")).resolves.toMatchObject({
      id: "fallback",
    });
  });

  it("does not ask twice when the person said no", async () => {
    // A second prompt in front of somebody who just denied permission is worse
    // than the failure, and it cannot succeed anyway.
    const getUserMedia = vi.fn().mockRejectedValue(named("NotAllowedError"));
    await expect(captureCamera(getUserMedia, "720p")).rejects.toThrow();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("does not ask twice when there is no camera at all", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(named("NotFoundError"));
    await expect(captureCamera(getUserMedia, "720p")).rejects.toThrow();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("surfaces the bare request's own failure rather than hiding it", async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(named("OverconstrainedError"))
      .mockRejectedValueOnce(named("NotReadableError"));
    await expect(captureCamera(getUserMedia, "720p")).rejects.toMatchObject({
      name: "NotReadableError",
    });
  });
});

describe("applyCameraQuality", () => {
  const trackThat = (applyConstraints: () => Promise<void>) =>
    ({ applyConstraints }) as unknown as MediaStreamTrack;

  it("re-shapes a live track without re-capturing it", async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const track = trackThat(applyConstraints);
    await expect(applyCameraQuality(track, "1080p")).resolves.toBe(true);
    expect(applyConstraints).toHaveBeenCalledWith(
      cameraConstraintsFor("1080p"),
    );
  });

  it("never rejects when the driver refuses mid-call", async () => {
    // Changing this setting during a live call must not be able to end the
    // call. A refusal leaves the picture the size it already was.
    const track = trackThat(() =>
      Promise.reject(named("OverconstrainedError")),
    );
    await expect(applyCameraQuality(track, "360p")).resolves.toBe(false);
  });
});

describe("screenBitrateFor", () => {
  it("gives a bigger choice a bigger ceiling, in order, with no ties", () => {
    // `auto` sits between 720p and 1080p on purpose: better than the 2.5 Mbps
    // every share used to get, cheaper than the most the product can spend.
    const rungs = ["360p", "480p", "720p", "auto", "1080p"] as const;
    const rates = rungs.map((rung) => screenBitrateFor(rung));
    expect(rates).toEqual([...rates].sort((a, b) => a - b));
    expect(new Set(rates).size).toBe(rungs.length);
  });

  it("answers for every quality the UI can produce", () => {
    // A missing rung would be `undefined` reaching `encoding.maxBitrate`, which
    // most browsers accept and silently read as "no ceiling at all".
    for (const quality of VIDEO_QUALITIES) {
      const rate = screenBitrateFor(quality);
      expect(Number.isFinite(rate)).toBe(true);
      expect(rate).toBeGreaterThan(0);
    }
  });

  it("beats the old hard-coded 2.5 Mbps once somebody asks for 1080p", () => {
    // The report, in one line: picking 1080p has to buy a sharper share.
    expect(screenBitrateFor("1080p")).toBeGreaterThan(2_500_000);
    expect(screenBitrateFor("auto")).toBeGreaterThan(2_500_000);
  });

  it("spends more on a screen than on a camera at the same rung", () => {
    // Because "1080p" names a picture, not a bitrate, and a game or a film at
    // 1080p30 costs roughly twice what a talking head does. Reusing the
    // camera's ladder here is precisely how a share stays blurry at 1080p.
    for (const quality of VIDEO_QUALITIES) {
      expect(screenBitrateFor(quality)).toBeGreaterThan(
        cameraBitrateFor(quality),
      );
    }
  });

  it("stays inside a modest Brazilian uplink even at its most expensive", () => {
    // The ceiling exists to be reachable, not to saturate a 5 to 10 Mbps home
    // upload and starve the audio riding on the same link.
    expect(screenBitrateFor("1080p")).toBeLessThanOrEqual(4_000_000);
  });
});

describe("screenScaleFactor", () => {
  it("scales a 1080p capture to the size each label names", () => {
    // THE REPORTED BUG, as arithmetic. "I picked 360p and it was clearly not
    // 360p": nothing divided the resolution, so the encoder held 1920x1080 and
    // spent the smaller ceiling on a worse-looking version of the same frame.
    expect(screenScaleFactor("1080p", 1080)).toBe(1);
    expect(screenScaleFactor("720p", 1080)).toBeCloseTo(1.5, 2);
    expect(screenScaleFactor("480p", 1080)).toBeCloseTo(2.25, 2);
    expect(screenScaleFactor("360p", 1080)).toBeCloseTo(3, 2);
  });

  it("computes the divisor from the screen in front of the user", () => {
    // `scaleResolutionDownBy` is a divisor, not a size, so a hard-coded 3 means
    // 360p on a 1080p monitor and 480p on a 1440p one. The same label has to
    // mean the same picture on both.
    expect(screenScaleFactor("360p", 1440)).toBeCloseTo(4, 2);
    expect(screenScaleFactor("720p", 1440)).toBeCloseTo(2, 2);
    expect(screenScaleFactor("360p", 720)).toBeCloseTo(2, 2);
  });

  it("never scales a capture up to meet a bigger label", () => {
    // Somebody sharing a small window and picking 1080p gets the window, not a
    // blown-up one: a divisor below 1 is an upscale, which costs bitrate to add
    // no detail at all.
    expect(screenScaleFactor("1080p", 720)).toBe(1);
    expect(screenScaleFactor("720p", 480)).toBe(1);
    expect(screenScaleFactor("360p", 360)).toBe(1);
  });

  it("leaves auto to the connection", () => {
    // Auto is the one rung that names no size, so it pins none: the encoder
    // adapts up and down on its own, which is the whole meaning of the word.
    for (const height of [1080, 1440, 720, null]) {
      expect(screenScaleFactor("auto", height)).toBe(1);
    }
  });

  it("assumes the capture ceiling when the track will not say", () => {
    // `getSettings()` can answer with nothing at all in the first moments after
    // a capture starts. Guessing 1 there would silently ship 1080p to somebody
    // who asked for 360p, which is the bug; the requested capture height is the
    // honest guess, and the next re-tune corrects it either way.
    expect(screenScaleFactor("360p", null)).toBeCloseTo(3, 2);
    expect(screenScaleFactor("360p", undefined)).toBeCloseTo(3, 2);
    expect(screenScaleFactor("360p", 0)).toBeCloseTo(3, 2);
  });
});
