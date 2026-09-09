import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyCameraQuality,
  availableVideoQualities,
  coerceVideoQuality,
  HUGE_ROOM_1080P_LIMIT,
  cameraBitrateFor,
  cameraConstraintsFor,
  cameraProfileFor,
  cameraSimulcastRungs,
  cameraSimulcastRungsFor,
  CAMERA_SIMULCAST_RUNGS,
  captureCamera,
  DEFAULT_VIDEO_QUALITY,
  hlsSourceTopHeight,
  isLargeRoomCapped,
  LARGE_ROOM_PARTICIPANTS,
  parseVideoQuality,
  screenBitrateFor,
  screenScaleFactor,
  screenSimulcastPlan,
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

  it("pins a chosen device with exact, and only then", () => {
    expect(JSON.stringify(cameraConstraintsFor("720p"))).not.toContain("exact");
    expect(cameraConstraintsFor("720p", "cam-1").deviceId).toEqual({
      exact: "cam-1",
    });
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

describe("availableVideoQualities", () => {
  it("keeps 1080p at the limit and drops it one past it", () => {
    expect(
      availableVideoQualities({
        participantCount: HUGE_ROOM_1080P_LIMIT,
        hlsLive: false,
      }),
    ).toContain("1080p");
    expect(
      availableVideoQualities({
        participantCount: HUGE_ROOM_1080P_LIMIT + 1,
        hlsLive: false,
      }),
    ).not.toContain("1080p");
    expect(HUGE_ROOM_1080P_LIMIT).toBe(150);
  });

  it("keeps 1080p while an HLS egress is live: the egress transcodes FROM it", () => {
    const list = availableVideoQualities({ participantCount: 2, hlsLive: true });
    expect(list).toEqual(VIDEO_QUALITIES);
  });

  it("offers the whole ladder to a small room with no egress", () => {
    expect(
      availableVideoQualities({ participantCount: 2, hlsLive: false }),
    ).toEqual(VIDEO_QUALITIES);
  });
});

describe("coerceVideoQuality", () => {
  it("reads an unavailable 1080p as auto and leaves the rest alone", () => {
    const noTop = availableVideoQualities({
      participantCount: HUGE_ROOM_1080P_LIMIT + 1,
      hlsLive: false,
    });
    expect(coerceVideoQuality("1080p", noTop)).toBe("auto");
    expect(coerceVideoQuality("720p", noTop)).toBe("720p");
    expect(coerceVideoQuality("1080p", VIDEO_QUALITIES)).toBe("1080p");
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

  it("retries without a device when the saved one is gone", async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(named("NotFoundError"))
      .mockResolvedValueOnce(fakeStream("any"));
    const stream = await captureCamera(getUserMedia, "720p", "gone");
    expect(stream.id).toBe("any");
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[1]![0]).toEqual({
      video: cameraConstraintsFor("720p"),
      audio: false,
    });
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

describe("screenSimulcastPlan", () => {
  it("puts 360p and 720p under a 1080p top on auto in a small room", () => {
    const plan = screenSimulcastPlan("auto", 4);
    expect(plan.topHeight).toBe(1080);
    expect(plan.topBitrate).toBe(3_000_000);
    expect(plan.lowerLayers.map((l) => [l.height, l.maxBitrate])).toEqual([
      [360, 450_000],
      [720, 1_400_000],
    ]);
    expect(plan.capped).toBe(false);
  });

  it("holds the top at 720p and 1.5 Mbps past the large-room line", () => {
    const plan = screenSimulcastPlan("auto", LARGE_ROOM_PARTICIPANTS + 1);
    expect(plan.topHeight).toBe(720);
    expect(plan.topBitrate).toBe(1_500_000);
    expect(plan.lowerLayers.map((l) => l.height)).toEqual([360]);
    expect(plan.capped).toBe(true);
  });

  it("does not cap at exactly the line", () => {
    expect(isLargeRoomCapped("auto", LARGE_ROOM_PARTICIPANTS)).toBe(false);
    expect(screenSimulcastPlan("auto", LARGE_ROOM_PARTICIPANTS).capped).toBe(
      false,
    );
  });

  it("steps aside for an explicit 1080p", () => {
    const plan = screenSimulcastPlan("1080p", 100);
    expect(plan.topHeight).toBe(1080);
    expect(plan.topBitrate).toBe(4_000_000);
    expect(plan.lowerLayers).toHaveLength(2);
    expect(plan.capped).toBe(false);
  });

  it("does not call a chosen 720p 'capped' in a big room", () => {
    // They are sending what they asked for; the room did not decide it.
    const plan = screenSimulcastPlan("720p", 100);
    expect(plan.topHeight).toBe(720);
    expect(plan.topBitrate).toBe(1_500_000);
    expect(plan.capped).toBe(false);
  });

  it("publishes no lower layer under a 360p top", () => {
    const plan = screenSimulcastPlan("360p", 2);
    expect(plan.topHeight).toBe(360);
    expect(plan.lowerLayers).toEqual([]);
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

  it("starts auto at 720p instead of letting it free-fall", () => {
    // THE REPORTED BUG. Auto used to pin no size at all, on the theory that a
    // naked encoder would climb and fall with the link. Measured at the far end
    // of a two-person mesh call it only falls: the share arrived at roughly
    // 144 lines and 3-5 fps while the arithmetic said 3 Mbps and one peer, so
    // nothing in our own numbers asked for that picture. Auto now asks for the
    // same 720p the camera's auto asks for, and `maintain-framerate` still
    // gives resolution back from there when the link genuinely cannot carry it.
    expect(screenScaleFactor("auto", 1080)).toBeCloseTo(
      screenScaleFactor("720p", 1080),
      2,
    );
    expect(screenScaleFactor("auto", 1440)).toBeCloseTo(
      screenScaleFactor("720p", 1440),
      2,
    );
    expect(screenScaleFactor("auto", null)).toBeCloseTo(
      screenScaleFactor("720p", null),
      2,
    );
  });

  it("never scales auto up to reach 720p", () => {
    // A shared window that is already smaller than 720 lines is handed over
    // untouched, exactly like every named rung: a divisor below 1 spends
    // bitrate inventing pixels that carry no detail.
    expect(screenScaleFactor("auto", 720)).toBe(1);
    expect(screenScaleFactor("auto", 480)).toBe(1);
  });

  it("keeps auto's bitrate where it was", () => {
    // Pinning the 720p *size* must not quietly demote auto onto the 720p
    // bitrate rung. Auto still spends 3 Mbps, which is the point: a smaller
    // picture with the same allowance is a sharper picture.
    expect(screenBitrateFor("auto")).toBe(3_000_000);
    expect(screenBitrateFor("auto")).not.toBe(screenBitrateFor("720p"));
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

describe("the presenter as the ladder's source", () => {
  const LIVE = { ladderTopHeight: 1080, uplinkBps: 10_000_000 };

  it("raises the published top past the large-room cap", () => {
    // Without a watch party this is the case the cap exists for.
    expect(screenSimulcastPlan("auto", 100).topHeight).toBe(720);
    // With one, the cap is aimed at the wrong problem: the audience is on
    // the playlist, and a 720p source cannot produce a 1080p rendition.
    const plan = screenSimulcastPlan("auto", 100, LIVE);
    expect(plan.topHeight).toBe(1080);
    expect(plan.topBitrate).toBe(4_000_000);
    expect(plan.capped).toBe(false);
  });

  it("leaves an ordinary large call alone", () => {
    // The rule that must not move. No egress, no raise, whatever the size.
    for (const hls of [null, { ladderTopHeight: null, uplinkBps: 10_000_000 }]) {
      const plan = screenSimulcastPlan("auto", 100, hls);
      expect(plan.topHeight).toBe(720);
      expect(plan.capped).toBe(true);
    }
  });

  it("does not raise when the measured uplink cannot carry it", () => {
    // 4 Mbit/s plus headroom is the bar; 3 Mbit/s is under it.
    const plan = screenSimulcastPlan("auto", 100, {
      ladderTopHeight: 1080,
      uplinkBps: 3_000_000,
    });
    expect(plan.topHeight).toBe(720);
    expect(plan.capped).toBe(true);
  });

  /**
   * THIS ASSERTION IS THE REVERSE OF WHAT IT WAS, and the reversal is the
   * point. It used to say an unmeasured uplink allows the raise, on the
   * convention `decidePromotion` uses for an SFU it has not probed. A live
   * party on 2026-09-09 showed what that costs here: 1080p published with a
   * 4 Mbit/s target and about 2.35 Mbit/s actually reaching the egress, which
   * is a starved top layer at roughly 20 fps on full-motion content.
   *
   * The two cases are not alike. A promotion that guesses wrong costs the box
   * some headroom. This one costs every viewer the picture, because the egress
   * subscribes with no layer preference and always takes the top layer, so the
   * cleanly delivered 720p one beside it is never used. A guess is not good
   * enough to spend an audience on.
   */
  it("refuses the raise until the uplink has actually been measured", () => {
    expect(
      screenSimulcastPlan("auto", 100, {
        ladderTopHeight: 1080,
        uplinkBps: null,
      }).topHeight,
    ).toBe(720);
    expect(
      hlsSourceTopHeight("auto", { ladderTopHeight: 1080, uplinkBps: null }),
    ).toBeNull();
  });

  it("still raises on a measured uplink that clears the bar", () => {
    expect(
      screenSimulcastPlan("auto", 100, {
        ladderTopHeight: 1080,
        uplinkBps: 6_000_000,
      }).topHeight,
    ).toBe(1080);
  });

  it("never overrules the presenter's own smaller pick", () => {
    expect(screenSimulcastPlan("480p", 100, LIVE).topHeight).toBe(480);
    expect(hlsSourceTopHeight("720p", LIVE)).toBeNull();
  });

  it("a 720p-only ladder does not ask for a 1080p source", () => {
    const plan = screenSimulcastPlan("auto", 100, {
      ladderTopHeight: 720,
      uplinkBps: 10_000_000,
    });
    expect(plan.topHeight).toBe(720);
    expect(hlsSourceTopHeight("auto", { ladderTopHeight: 720, uplinkBps: null })).toBeNull();
  });

  it("a small room is unchanged either way", () => {
    expect(screenSimulcastPlan("auto", 3).topHeight).toBe(1080);
    expect(screenSimulcastPlan("auto", 3, LIVE).topHeight).toBe(1080);
  });
});

/**
 * THE CAMERA'S LADDER (2026-09-08).
 *
 * The camera published one layer, so `adaptiveStream` had nothing to choose
 * from and every viewer received the full picture into whatever size tile they
 * had. In a room of twenty cameras that is twenty full streams into every
 * phone, which is why the product had a headcount cap instead of a room.
 */
describe("the camera's simulcast rungs", () => {
  it("is the same 360p picture the menu names, so a label means one thing", () => {
    const mid = CAMERA_SIMULCAST_RUNGS.find((rung) => rung.height === 360);
    const menu = cameraProfileFor("360p");
    expect(mid?.width).toBe(menu.width);
    expect(mid?.maxBitrate).toBe(menu.maxBitrate);
  });

  it("gives a 720p capture both rungs under it", () => {
    expect(cameraSimulcastRungs(720).map((rung) => rung.height)).toEqual([
      180, 360,
    ]);
  });

  it("never publishes a rung at or above the capture: that is an upscale", () => {
    expect(cameraSimulcastRungs(360).map((rung) => rung.height)).toEqual([180]);
    expect(cameraSimulcastRungs(180)).toEqual([]);
    expect(cameraSimulcastRungs(120)).toEqual([]);
  });

  it("keeps every rung under a 1080p capture", () => {
    expect(cameraSimulcastRungs(1080).map((rung) => rung.height)).toEqual([
      180, 360,
    ]);
  });

  it("plans from the size a quality asks the camera for", () => {
    expect(cameraSimulcastRungsFor("auto").map((r) => r.height)).toEqual([
      180, 360,
    ]);
    expect(cameraSimulcastRungsFor("360p").map((r) => r.height)).toEqual([180]);
  });

  it("is ordered smallest first, which is the order the library wants", () => {
    const heights = CAMERA_SIMULCAST_RUNGS.map((rung) => rung.height);
    expect([...heights].sort((a, b) => a - b)).toEqual(heights);
  });

  it("costs less on every rung than the rung above it", () => {
    const rates = [
      ...CAMERA_SIMULCAST_RUNGS.map((rung) => rung.maxBitrate),
      cameraBitrateFor("auto"),
    ];
    for (let at = 1; at < rates.length; at += 1) {
      expect(rates[at]!).toBeGreaterThan(rates[at - 1]!);
    }
  });
});
