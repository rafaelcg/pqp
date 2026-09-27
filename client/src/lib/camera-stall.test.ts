import { describe, expect, it } from "vitest";
import {
  CAMERA_HEALTHY_MS,
  CAMERA_NUDGE_CHECK_MS,
  CAMERA_REBUILD_BACKOFF_MS,
  CAMERA_STALL_MS,
  CAMERA_STALL_POLL_MS,
  CameraStallWatch,
  cameraProgress,
  type CameraStallAction,
} from "./camera-stall";

/** A watch on a fake clock, sampled every `CAMERA_STALL_POLL_MS`. */
function rig(random = () => 0.5) {
  let now = 0;
  const watch = new CameraStallWatch({ now: () => now, random });
  let t = 0;
  const actions: Array<{ at: number; action: CameraStallAction }> = [];
  const sample = (opts: { advance?: boolean; eligible?: boolean; time?: number } = {}) => {
    now += CAMERA_STALL_POLL_MS;
    if (opts.time !== undefined) {
      t = opts.time;
    } else if (opts.advance) {
      t += CAMERA_STALL_POLL_MS / 1000;
    }
    const action = watch.observe({ position: t, eligible: opts.eligible ?? true });
    if (action !== "none") {
      actions.push({ at: now, action });
    }
    return action;
  };
  /** Sample `ms` worth of polls, all with the same options. */
  const run = (ms: number, opts: Parameters<typeof sample>[0] = {}) => {
    for (let i = 0; i < ms / CAMERA_STALL_POLL_MS; i += 1) {
      sample(opts);
    }
  };
  return { watch, sample, run, actions, now: () => now };
}

describe("CameraStallWatch", () => {
  it("says nothing while the camera plays", () => {
    const r = rig();
    r.run(120_000, { advance: true });
    expect(r.actions).toEqual([]);
  });

  it("nudges once after the stall threshold, then rebuilds as soon as the nudge moved nothing", () => {
    const r = rig();
    r.run(20_000, { advance: true });
    const frozeAt = r.now();
    r.run(40_000);
    expect(r.actions.map((a) => a.action)).toEqual(["nudge", "rebuild", "rebuild"]);
    // Nudge after CAMERA_STALL_MS of no movement (plus the baseline poll).
    expect(r.actions[0]!.at - frozeAt).toBeGreaterThanOrEqual(CAMERA_STALL_MS);
    expect(r.actions[0]!.at - frozeAt).toBeLessThanOrEqual(
      CAMERA_STALL_MS + CAMERA_STALL_POLL_MS,
    );
    // random 0.5 is zero jitter. Rehearsal E (2026-09-25): the nudge ran,
    // moved nothing, and the face stayed frozen for the whole first backoff
    // step. A failed nudge now escalates after `CAMERA_NUDGE_CHECK_MS`.
    const toRebuild = r.actions[1]!.at - r.actions[0]!.at;
    expect(toRebuild).toBeGreaterThanOrEqual(CAMERA_NUDGE_CHECK_MS);
    expect(toRebuild).toBeLessThanOrEqual(CAMERA_NUDGE_CHECK_MS + CAMERA_STALL_POLL_MS);
    expect(toRebuild).toBeLessThan(CAMERA_REBUILD_BACKOFF_MS[0]!);
    // The rebuild after that still waits out a backoff step.
    expect(r.actions[2]!.at - r.actions[1]!.at).toBeGreaterThanOrEqual(
      CAMERA_REBUILD_BACKOFF_MS[1]!,
    );
  });

  it("does not take the nudge's own seek to the live edge for recovery", () => {
    const r = rig();
    r.run(20_000, { advance: true });
    r.run(CAMERA_STALL_MS + CAMERA_STALL_POLL_MS);
    expect(r.actions.map((a) => a.action)).toEqual(["nudge"]);
    const nudgedAt = r.actions[0]!.at;
    // The seek lands 20 s ahead (one step of "movement"), then nothing.
    r.sample({ time: 60 });
    r.run(CAMERA_NUDGE_CHECK_MS + CAMERA_STALL_POLL_MS);
    expect(r.actions.map((a) => a.action)).toEqual(["nudge", "rebuild"]);
    expect(r.actions[1]!.at - nudgedAt).toBeLessThanOrEqual(
      CAMERA_NUDGE_CHECK_MS + CAMERA_STALL_POLL_MS,
    );
  });

  it("never rebuilds when the nudge got frames moving again", () => {
    const r = rig();
    r.run(20_000, { advance: true });
    r.run(CAMERA_STALL_MS + CAMERA_STALL_POLL_MS);
    expect(r.actions.map((a) => a.action)).toEqual(["nudge"]);
    // The nudge worked: frames move from the very next poll on.
    r.run(120_000, { advance: true });
    expect(r.actions.map((a) => a.action)).toEqual(["nudge"]);
  });

  it("backs off between rebuilds and never loops tightly", () => {
    const r = rig();
    r.run(4_000, { advance: true });
    r.run(20 * 60_000);
    const rebuilds = r.actions.filter((a) => a.action === "rebuild").map((a) => a.at);
    expect(rebuilds.length).toBeGreaterThan(4);
    const gaps = rebuilds.slice(1).map((at, i) => at - rebuilds[i]!);
    for (let i = 1; i < gaps.length; i += 1) {
      expect(gaps[i]!).toBeGreaterThanOrEqual(gaps[i - 1]!);
    }
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(CAMERA_REBUILD_BACKOFF_MS[1]!);
    // Settles at the ceiling: about one rebuild every two minutes.
    expect(gaps.at(-1)).toBeGreaterThanOrEqual(CAMERA_REBUILD_BACKOFF_MS.at(-1)!);
    // Only one nudge per episode.
    expect(r.actions.filter((a) => a.action === "nudge")).toHaveLength(1);
  });

  it("keeps the backoff when a rebuild paints briefly and freezes again", () => {
    const r = rig();
    r.run(4_000, { advance: true });
    r.run(60_000);
    const before = r.watch.rebuilds;
    expect(before).toBeGreaterThanOrEqual(2);
    // The rebuilt player lands on the live edge and plays for 4 s: not healthy.
    r.sample({ time: 0 });
    r.sample({ time: 30 });
    r.run(4_000, { advance: true });
    r.run(200_000);
    const rebuilds = r.actions.filter((a) => a.action === "rebuild").map((a) => a.at);
    const gaps = rebuilds.slice(1).map((at, i) => at - rebuilds[i]!);
    // No gap after the brief paint drops back to the first step.
    expect(Math.min(...gaps.slice(before - 1))).toBeGreaterThanOrEqual(
      CAMERA_REBUILD_BACKOFF_MS[before]!,
    );
  });

  it("starts over (nudge first, short delay) once the camera played healthily", () => {
    const r = rig();
    r.run(4_000, { advance: true });
    r.run(120_000);
    expect(r.watch.rebuilds).toBeGreaterThanOrEqual(3);
    r.run(CAMERA_HEALTHY_MS + 2 * CAMERA_STALL_POLL_MS, { advance: true });
    expect(r.watch.rebuilds).toBe(0);
    const count = r.actions.length;
    r.run(CAMERA_STALL_MS + CAMERA_REBUILD_BACKOFF_MS[0]! + 2 * CAMERA_STALL_POLL_MS);
    expect(r.actions.slice(count).map((a) => a.action)).toEqual(["nudge", "rebuild"]);
  });

  it("does not count a hidden page or an element waiting for a gesture", () => {
    const r = rig();
    r.run(4_000, { advance: true });
    r.run(10 * 60_000, { eligible: false });
    expect(r.actions).toEqual([]);
    // Back on the page: a fresh stall clock, not ten minutes of stall.
    r.sample();
    r.sample();
    expect(r.actions).toEqual([]);
  });

  it("reads a rebuild's drop to zero as a new baseline, not as movement", () => {
    const r = rig();
    r.run(4_000, { advance: true });
    r.run(CAMERA_STALL_MS + CAMERA_REBUILD_BACKOFF_MS[0]! + 2 * CAMERA_STALL_POLL_MS);
    expect(r.actions.map((a) => a.action)).toEqual(["nudge", "rebuild"]);
    // The element was torn down: 0 and stuck there (the manifest 503s).
    r.run(CAMERA_REBUILD_BACKOFF_MS[1]! * 1.3 + CAMERA_STALL_MS, { time: 0 });
    expect(r.actions.map((a) => a.action)).toEqual(["nudge", "rebuild", "rebuild"]);
  });

  it("spreads rebuilds across viewers with jitter", () => {
    const early = rig(() => 0);
    const late = rig(() => 1);
    for (const r of [early, late]) {
      r.run(4_000, { advance: true });
      r.run(40_000);
    }
    const firstRebuild = (r: ReturnType<typeof rig>) =>
      r.actions.find((a) => a.action === "rebuild")!.at;
    expect(firstRebuild(late) - firstRebuild(early)).toBeGreaterThanOrEqual(
      CAMERA_STALL_POLL_MS,
    );
  });
});

describe("cameraProgress", () => {
  const withFrames = (frames: number, currentTime: number) => ({
    currentTime,
    getVideoPlaybackQuality: () => ({ totalVideoFrames: frames }),
  });

  it("counts frames when a picture is expected, so a voice track cannot hide a frozen face", () => {
    expect(cameraProgress(withFrames(537, 42.5), true)).toBe(537);
  });

  it("uses the clock for the voice-only shape, which has no picture", () => {
    expect(cameraProgress(withFrames(0, 42.5), false)).toBe(42.5);
  });

  it("falls back to the clock where frame counts do not exist", () => {
    expect(cameraProgress({ currentTime: 7 }, true)).toBe(7);
    expect(
      cameraProgress(
        {
          currentTime: 7,
          getVideoPlaybackQuality: () => {
            throw new Error("nope");
          },
        },
        true,
      ),
    ).toBe(7);
  });
});
