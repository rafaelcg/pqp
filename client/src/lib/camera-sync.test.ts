import { describe, expect, it } from "vitest";
import {
  CAMERA_SYNC_EDGE_MARGIN_MS,
  CAMERA_SYNC_ENTER_MS,
  CAMERA_SYNC_EXIT_MS,
  CAMERA_SYNC_MAX_NUDGE,
  CAMERA_SYNC_NO_SPEEDUP_EDGE_MS,
  CAMERA_SYNC_SEEK_BUDGET,
  CAMERA_SYNC_SEEK_COOLDOWN_MS,
  CAMERA_SYNC_SEEK_WINDOW_MS,
  CAMERA_SYNC_SETTLE_MS,
  CAMERA_SYNC_TICK_MS,
  CameraSyncController,
  cameraSyncFromConfig,
  elementPlaying,
  hlsEdgeWallMs,
  hlsPlayingWallMs,
  nudgeRate,
  setWatchCameraSync,
  watchCameraSyncActive,
  type CameraSyncDecision,
  type CameraSyncInput,
} from "./camera-sync";

/**
 * THE CAMERA HELD TO THE FILM (2026-10-03). The controller is pure: it is
 * handed both pictures' wall clocks and answers a rate or a seek for the
 * CAMERA. These pin its promises one by one, then a small simulation runs it
 * against the scenarios the real-player rig measured (start 13 s apart, a
 * stall, a frozen tab) and checks it converges without ever oscillating.
 */

const FILM = 1_790_000_000_000;

function input(overrides: Partial<CameraSyncInput> = {}): CameraSyncInput {
  return {
    now: 100_000,
    visible: true,
    filmPlaying: true,
    cameraPlaying: true,
    filmWallMs: FILM,
    cameraWallMs: FILM,
    filmRate: 1,
    cameraEdgeWallMs: FILM + 20_000,
    ...overrides,
  };
}

/** The camera `driftMs` ahead of the film (negative: behind). */
function drift(driftMs: number, overrides: Partial<CameraSyncInput> = {}): CameraSyncInput {
  return input({ cameraWallMs: FILM + driftMs, ...overrides });
}

describe("doing nothing", () => {
  it("leaves a camera within the dead band at the film's rate", () => {
    const sync = new CameraSyncController();
    const decision = sync.observe(drift(CAMERA_SYNC_ENTER_MS - 10));
    expect(decision).toMatchObject({ kind: "rate", rate: 1, reason: "in-sync" });
  });

  it("releases the camera to 1x while either picture is not playing", () => {
    const sync = new CameraSyncController();
    for (const flags of [
      { filmPlaying: false },
      { cameraPlaying: false },
      { filmPlaying: false, cameraPlaying: false },
    ]) {
      expect(sync.observe(drift(-13_000, flags))).toEqual({
        kind: "rate",
        rate: 1,
        driftMs: null,
        reason: "not-playing",
      });
    }
  });

  it("releases it on a hidden page, however far apart they are", () => {
    const sync = new CameraSyncController();
    expect(sync.observe(drift(-60_000, { visible: false }))).toMatchObject({
      kind: "rate",
      rate: 1,
      reason: "hidden",
    });
  });

  it("does nothing without both clocks (no PROGRAM-DATE-TIME, native engine)", () => {
    const sync = new CameraSyncController();
    expect(sync.observe(input({ filmWallMs: null }))).toMatchObject({ reason: "no-clock", rate: 1 });
    expect(sync.observe(input({ cameraWallMs: null }))).toMatchObject({ reason: "no-clock", rate: 1 });
    expect(sync.observe(input({ cameraWallMs: Number.NaN }))).toMatchObject({ reason: "no-clock" });
  });
});

describe("nudging", () => {
  it("slows a camera that is ahead and speeds up one that is behind", () => {
    const sync = new CameraSyncController();
    expect(sync.observe(drift(400))).toMatchObject({ kind: "rate", reason: "nudge" });
    expect((sync.observe(drift(400)) as { rate: number }).rate).toBeLessThan(1);
    expect((sync.observe(drift(-400)) as { rate: number }).rate).toBeGreaterThan(1);
  });

  it("never moves the rate more than 5 % from the film's", () => {
    for (const driftMs of [-999, -600, -300, 300, 600, 999]) {
      for (const filmRate of [0.95, 1, 1.05, 1.15]) {
        const rate = nudgeRate(driftMs, filmRate);
        expect(rate).toBeGreaterThanOrEqual(filmRate * (1 - CAMERA_SYNC_MAX_NUDGE) - 0.005);
        expect(rate).toBeLessThanOrEqual(filmRate * (1 + CAMERA_SYNC_MAX_NUDGE) + 0.005);
      }
    }
  });

  it("nudges around the film's own rate, so a film catching up is followed", () => {
    // The conventional film runs at up to 1.15x while it catches up: a camera
    // at 1x beside it would fall behind by itself.
    const sync = new CameraSyncController();
    const decision = sync.observe(drift(0, { filmRate: 1.1 }));
    expect(decision).toMatchObject({ rate: 1.1, reason: "in-sync" });
    expect((sync.observe(drift(-400, { filmRate: 1.1 })) as { rate: number }).rate).toBeGreaterThan(1.1);
  });

  it("has hysteresis: starts past the enter threshold, stops under the exit one", () => {
    const sync = new CameraSyncController();
    const between = (CAMERA_SYNC_ENTER_MS + CAMERA_SYNC_EXIT_MS) / 2;
    // Inside the band, from rest: nothing.
    expect(sync.observe(drift(between)).reason).toBe("in-sync");
    // Past the enter threshold: a correction starts.
    expect(sync.observe(drift(CAMERA_SYNC_ENTER_MS + 30)).reason).toBe("nudge");
    // Back inside the band: still correcting, it has not reached the exit.
    expect(sync.observe(drift(between)).reason).toBe("nudge");
    // Under the exit threshold: done.
    expect(sync.observe(drift(CAMERA_SYNC_EXIT_MS - 10)).reason).toBe("in-sync");
    // And the band again does not restart it.
    expect(sync.observe(drift(between)).reason).toBe("in-sync");
  });

  it("never speeds a camera up into its own newest media", () => {
    const sync = new CameraSyncController();
    const decision = sync.observe(
      drift(-500, { cameraEdgeWallMs: FILM - 500 + CAMERA_SYNC_NO_SPEEDUP_EDGE_MS - 100 }),
    );
    expect(decision).toMatchObject({ kind: "rate", rate: 1, reason: "at-edge" });
  });
});

describe("seeking", () => {
  it("seeks a camera far behind straight onto the film (the LL party: 13 s)", () => {
    const sync = new CameraSyncController();
    const decision = sync.observe(drift(-13_000));
    expect(decision).toMatchObject({ kind: "seek", reason: "seek" });
    expect((decision as { bySeconds: number }).bySeconds).toBeCloseTo(13, 3);
  });

  it("seeks a camera far ahead back onto the film", () => {
    const sync = new CameraSyncController();
    const decision = sync.observe(drift(2_480));
    expect(decision.kind).toBe("seek");
    expect((decision as { bySeconds: number }).bySeconds).toBeCloseTo(-2.48, 3);
  });

  it("ignores its own stale reading right after a seek", () => {
    const sync = new CameraSyncController();
    sync.observe(drift(-13_000, { now: 1_000 }));
    expect(
      sync.observe(drift(-13_000, { now: 1_000 + CAMERA_SYNC_SETTLE_MS - 1 })),
    ).toMatchObject({ kind: "rate", reason: "settling" });
  });

  it("does not seek again inside the cooldown: it nudges instead", () => {
    const sync = new CameraSyncController();
    sync.observe(drift(-5_000, { now: 1_000 }));
    const decision = sync.observe(
      drift(-3_000, { now: 1_000 + CAMERA_SYNC_SEEK_COOLDOWN_MS - 1 }),
    );
    expect(decision).toMatchObject({ kind: "rate", reason: "nudge" });
    expect(
      sync.observe(drift(-3_000, { now: 1_000 + CAMERA_SYNC_SEEK_COOLDOWN_MS })).kind,
    ).toBe("seek");
  });

  it("spends at most its budget of seeks a minute, then only nudges", () => {
    const sync = new CameraSyncController();
    let now = 0;
    for (let i = 0; i < CAMERA_SYNC_SEEK_BUDGET; i += 1) {
      now += CAMERA_SYNC_SEEK_COOLDOWN_MS;
      expect(sync.observe(drift(-5_000, { now })).kind).toBe("seek");
    }
    now += CAMERA_SYNC_SEEK_COOLDOWN_MS;
    expect(sync.observe(drift(-5_000, { now }))).toMatchObject({
      kind: "rate",
      reason: "seek-budget",
    });
    // The window passes and the budget comes back.
    now += CAMERA_SYNC_SEEK_WINDOW_MS;
    expect(sync.observe(drift(-5_000, { now })).kind).toBe("seek");
  });

  it("never seeks closer than the margin to the camera's newest media", () => {
    const sync = new CameraSyncController();
    // Behind by 6 s, but the camera only lists 4 s past where it is.
    const decision = sync.observe(
      drift(-6_000, { cameraEdgeWallMs: FILM - 6_000 + 4_000 }),
    );
    expect(decision.kind).toBe("seek");
    expect((decision as { bySeconds: number }).bySeconds * 1000).toBeCloseTo(
      4_000 - CAMERA_SYNC_EDGE_MARGIN_MS,
      0,
    );
  });

  it("waits at the margin instead of seeking backwards when the film is nearer real time than the camera can be", () => {
    // The camera has played up to 1 s from its newest segment and is still
    // 3 s behind the film: the clamp would land BEHIND where it is. That is
    // the seek loop this must never enter.
    const sync = new CameraSyncController();
    const decision = sync.observe(
      drift(-3_000, { cameraEdgeWallMs: FILM - 3_000 + 1_000 }),
    );
    expect(decision).toMatchObject({ kind: "rate", rate: 1, reason: "at-edge" });
    expect(sync.seeks).toBe(0);
  });
});

/**
 * A toy party: both pictures' wall clocks advance with their rates, the
 * controller is asked once a tick, its answers are applied to the camera, and
 * every reading carries a little jitter. What the real rig measured, in
 * miniature, and fast enough to run on every commit.
 */
function simulate({
  startDriftMs,
  ticks,
  events = {},
  filmRate = () => 1,
  edgeAheadMs = 15_000,
}: {
  startDriftMs: number;
  ticks: number;
  events?: Record<number, "camera-stall-6s" | "hide-page-20s">;
  filmRate?: (tick: number) => number;
  edgeAheadMs?: number;
}) {
  const sync = new CameraSyncController();
  let film = FILM;
  let camera = FILM + startDriftMs;
  let cameraRate = 1;
  let cameraStalledFor = 0;
  let hiddenFor = 0;
  let seed = 7;
  const jitter = () => {
    seed = (seed * 48271) % 2147483647;
    return ((seed / 2147483647) - 0.5) * 30; // +/-15 ms
  };
  const drifts: number[] = [];
  const decisions: CameraSyncDecision[] = [];
  for (let tick = 0; tick < ticks; tick += 1) {
    const event = events[tick];
    if (event === "camera-stall-6s") cameraStalledFor = 6;
    if (event === "hide-page-20s") hiddenFor = 20;
    const rate = filmRate(tick);
    const step = CAMERA_SYNC_TICK_MS / 1000;
    film += 1000 * step * rate;
    if (cameraStalledFor > 0) {
      cameraStalledFor -= step;
    } else if (hiddenFor > 0) {
      // A hidden tab: the browser keeps playing both (desktop Chrome), but
      // the camera is left at 1x while the film may catch up.
      camera += 1000 * step;
    } else {
      camera += 1000 * step * cameraRate;
    }
    const visible = hiddenFor <= 0;
    if (hiddenFor > 0) hiddenFor -= step;
    const decision = sync.observe({
      now: tick * CAMERA_SYNC_TICK_MS,
      visible,
      filmPlaying: true,
      cameraPlaying: cameraStalledFor <= 0,
      filmWallMs: film + jitter(),
      cameraWallMs: camera + jitter(),
      filmRate: rate,
      cameraEdgeWallMs: film + edgeAheadMs,
    });
    if (decision.kind === "seek") {
      camera += decision.bySeconds * 1000;
    }
    cameraRate = decision.rate;
    decisions.push(decision);
    drifts.push(camera - film);
  }
  const seeks = decisions.filter((d) => d.kind === "seek").length;
  // How often the camera's rate crossed the film's: a controller that
  // oscillates flips it back and forth, one that converges does not.
  let flips = 0;
  let lastSide = 0;
  for (const d of decisions) {
    const side = Math.sign(Math.round((d.rate - 1) * 1000));
    if (side !== 0 && lastSide !== 0 && side !== lastSide) flips += 1;
    if (side !== 0) lastSide = side;
  }
  return { drifts, seeks, flips };
}

describe("a party, simulated", () => {
  it("an LL viewer whose camera starts 13 s behind is in sync in one seek", () => {
    const { drifts, seeks, flips } = simulate({ startDriftMs: -13_000, ticks: 60 });
    expect(seeks).toBe(1);
    expect(Math.abs(drifts[3]!)).toBeLessThan(300);
    expect(Math.max(...drifts.slice(10).map(Math.abs))).toBeLessThan(150);
    expect(flips).toBeLessThanOrEqual(1);
  });

  it("a 600 ms start is closed by nudging alone, with no cut in the picture", () => {
    const { drifts, seeks, flips } = simulate({ startDriftMs: -600, ticks: 60 });
    expect(seeks).toBe(0);
    expect(Math.max(...drifts.slice(30).map(Math.abs))).toBeLessThan(150);
    expect(flips).toBeLessThanOrEqual(1);
  });

  it("a camera stall is paid back once it plays again, and only then", () => {
    const { drifts, seeks } = simulate({
      startDriftMs: 0,
      ticks: 60,
      events: { 20: "camera-stall-6s" },
    });
    // During the stall it is left alone (and falls behind).
    expect(drifts[24]!).toBeLessThan(-3_000);
    expect(seeks).toBe(1);
    expect(Math.max(...drifts.slice(35).map(Math.abs))).toBeLessThan(150);
  });

  it("a hidden page is left alone and caught up on return", () => {
    const { drifts } = simulate({
      startDriftMs: 0,
      ticks: 80,
      events: { 10: "hide-page-20s" },
      // The film catches up at 1.1x while the page is hidden.
      filmRate: (tick) => (tick >= 10 && tick < 30 ? 1.1 : 1),
    });
    expect(drifts[29]!).toBeLessThan(-1_000);
    expect(Math.max(...drifts.slice(45).map(Math.abs))).toBeLessThan(150);
  });

  it("follows a film that is itself catching up, without seeking", () => {
    const { drifts, seeks } = simulate({
      startDriftMs: 0,
      ticks: 60,
      filmRate: (tick) => (tick < 30 ? 1.1 : 1),
    });
    expect(seeks).toBe(0);
    expect(Math.max(...drifts.map(Math.abs))).toBeLessThan(150);
  });

  it("parks at its edge, without a seek loop, when the film is nearer real time than the camera can be", () => {
    const { drifts, seeks, flips } = simulate({
      startDriftMs: -8_000,
      ticks: 120,
      edgeAheadMs: -2_000,
    });
    // One seek to the margin, at most, and then it waits.
    expect(seeks).toBeLessThanOrEqual(1);
    expect(flips).toBe(0);
    expect(drifts.at(-1)!).toBeLessThan(0);
  });
});

describe("the readings", () => {
  it("reads hls.js's own wall clock, or null", () => {
    expect(hlsPlayingWallMs({ playingDate: new Date(FILM) })).toBe(FILM);
    expect(hlsPlayingWallMs({ playingDate: null })).toBeNull();
    expect(hlsPlayingWallMs(null)).toBeNull();
    expect(hlsPlayingWallMs({ playingDate: new Date(Number.NaN) })).toBeNull();
  });

  it("reads the end of the newest listed fragment as the camera's edge", () => {
    expect(
      hlsEdgeWallMs({
        levels: [
          {
            details: {
              fragments: [
                { programDateTime: FILM, duration: 4 },
                { programDateTime: FILM + 4_000, duration: 4 },
              ],
            },
          },
        ],
      }),
    ).toBe(FILM + 8_000);
    expect(hlsEdgeWallMs({ levels: [{ details: { fragments: [{ duration: 4 }] } }] })).toBeNull();
    expect(hlsEdgeWallMs({ levels: [] })).toBeNull();
    expect(hlsEdgeWallMs(null)).toBeNull();
  });

  it("calls an element playing only when it is moving with media ahead", () => {
    const base = { paused: false, seeking: false, ended: false, readyState: 4 };
    expect(elementPlaying(base as HTMLVideoElement)).toBe(true);
    expect(elementPlaying({ ...base, paused: true } as HTMLVideoElement)).toBe(false);
    expect(elementPlaying({ ...base, seeking: true } as HTMLVideoElement)).toBe(false);
    expect(elementPlaying({ ...base, readyState: 2 } as HTMLVideoElement)).toBe(false);
    expect(elementPlaying(null)).toBe(false);
  });
});

describe("the flag", () => {
  it("starts off, before any config has answered", () => {
    expect(watchCameraSyncActive()).toBe(false);
  });

  it("is on only when the server says true: no answer and an older API are off", () => {
    expect(cameraSyncFromConfig(null)).toBe(false);
    expect(cameraSyncFromConfig(undefined)).toBe(false);
    expect(cameraSyncFromConfig({})).toBe(false);
    expect(cameraSyncFromConfig({ cameraSync: false })).toBe(false);
    expect(cameraSyncFromConfig({ cameraSync: true })).toBe(true);
  });

  it("follows the store both ways", () => {
    setWatchCameraSync(true);
    expect(watchCameraSyncActive()).toBe(true);
    setWatchCameraSync(false);
    expect(watchCameraSyncActive()).toBe(false);
  });
});
