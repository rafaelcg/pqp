import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyCameraQuality,
  cameraBitrateFor,
  cameraConstraintsFor,
  captureCamera,
  DEFAULT_VIDEO_QUALITY,
  parseVideoQuality,
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
