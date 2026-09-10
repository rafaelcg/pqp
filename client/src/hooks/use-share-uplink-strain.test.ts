import { describe, expect, it } from "vitest";
import {
  isStrained,
  nextSfuStrainStreak,
  nextStrainStreak,
  shouldMeasureUplink,
  SUSTAINED_SAMPLES,
} from "@/hooks/use-share-uplink-strain";
import type { VideoSenderSample } from "@/lib/voice-stats-probe";

/**
 * When this warning speaks, and — mostly — when it stays quiet.
 *
 * A warning that fires on a ramp-up or a one-off re-probe is worse than no
 * warning at all: people learn to read past it, and then it is not there on
 * the day it is true. So the quiet cases carry more weight here than the loud
 * one. Tested as rules rather than through React, the same way
 * `createIdleChrome` is: the binding is one `useEffect` around these two
 * functions.
 */

function sender(fields: Partial<VideoSenderSample>): VideoSenderSample {
  return {
    peerId: "p1",
    role: "screen",
    width: 1280,
    height: 720,
    fps: 30,
    kbps: 400,
    targetKbps: 400,
    limitedBy: "bandwidth",
    ceilingKbps: 2500,
    limitDurations: null,
    encoder: null,
    framesEncoded: null,
    framesSent: null,
    keyFramesEncoded: null,
    pliCount: null,
    nackCount: null,
    ...fields,
  };
}

/** Target well under the ceiling: the link talking. */
const starved = sender({ targetKbps: 400, ceilingKbps: 2500 });
/** Sitting on the ceiling the user actually picked: the setting talking. */
const atCeiling = sender({ targetKbps: 2980, ceilingKbps: 3000 });
/**
 * A ceiling shrunk purely by the room: five viewers of the starting 5 Mbps
 * budget is 1000 kbps a copy, on a link nobody has measured as weak. Saying
 * "your connection" here would accuse a healthy uplink of the mesh's own
 * arithmetic.
 */
const crowdedRoom = sender({ targetKbps: 990, ceilingKbps: 1000, limitedBy: "none" });
/**
 * Sitting on a ceiling the *budget controller* imposed after measuring a weak
 * link. Identical to `atCeiling` as far as the encoder is concerned, and the
 * opposite thing to say about it.
 */
const atBudgetCeiling = sender({ targetKbps: 495, ceilingKbps: 500 });

/** What "Auto" asks for, which is what the harness runs at. */
const CHOSEN = 3_000_000;

/**
 * Feed a run of identical samples and return the streak it leaves behind.
 *
 * `viewers` matters: a mesh sends one copy per viewer and the rows carry the
 * count, which is how the rule tells a ceiling shrunk by a crowded room from
 * one shrunk by a weak link.
 */
function runOf(
  count: number,
  sample: VideoSenderSample | undefined,
  chosen = CHOSEN,
  viewers = 2,
  /** Rows can lag the room; see the stuck-joiner test. */
  rows = viewers,
): number {
  const screens = sample ? Array.from({ length: rows }, () => sample) : [];
  let streak = 0;
  for (let i = 0; i < count; i += 1) {
    streak = nextStrainStreak(streak, screens, chosen, viewers);
  }
  return streak;
}

describe("the share uplink warning", () => {
  it("stays quiet while the share is merely ramping up", () => {
    expect(isStrained(runOf(SUSTAINED_SAMPLES - 1, starved))).toBe(false);
  });

  it("speaks once the link has been short for a sustained stretch", () => {
    expect(isStrained(runOf(SUSTAINED_SAMPLES, starved))).toBe(true);
  });

  it("never blames the link for a share sitting on the chosen ceiling", () => {
    // THE FALSE POSITIVE THIS EXISTS TO AVOID. The encoder reports
    // `bandwidth` whenever any rate limit binds, our own `maxBitrate`
    // included, so somebody on fibre who picked 480p would otherwise be told
    // their connection is at fault, for the whole call, forever.
    expect(isStrained(runOf(SUSTAINED_SAMPLES * 3, atCeiling))).toBe(false);
  });

  it("stays quiet for a limit that is the encoder or the machine, not the link", () => {
    for (const reason of ["cpu", "other", "none"]) {
      const sampled = sender({ limitedBy: reason, targetKbps: 100 });
      expect(isStrained(runOf(SUSTAINED_SAMPLES * 2, sampled))).toBe(false);
    }
  });

  it("calls a budget-imposed ceiling the connection, not the setting", () => {
    // THE MISATTRIBUTION THE HARNESS CAUGHT. Once the budget controller cuts
    // the ceiling to fit a measured 1 Mbps link, the encoder sits ON that
    // ceiling and the plain reading says "setting" — telling somebody whose
    // connection is genuinely strained that their own preference is the
    // limit. The ceiling in force is far under what they asked for, and that
    // gap is the whole tell.
    expect(isStrained(runOf(SUSTAINED_SAMPLES, atBudgetCeiling))).toBe(true);
  });

  it("still calls the user's own rung a setting, at any rung", () => {
    // The other side of the same line: picking 480p on fibre must never be
    // reported as a connection problem.
    const picked480p = sender({ targetKbps: 990, ceilingKbps: 1000 });
    expect(isStrained(runOf(SUSTAINED_SAMPLES * 2, picked480p, 1_000_000))).toBe(
      false,
    );
  });

  it("blames the room, not the link, when the room is what shrank the ceiling", () => {
    // Five viewers, un-measured 5 Mbps budget, 1000 kbps a copy. That is the
    // mesh dividing, not a weak uplink, and it must stay silent.
    expect(
      isStrained(runOf(SUSTAINED_SAMPLES * 2, crowdedRoom, CHOSEN, 5)),
    ).toBe(false);
  });

  it("speaks when the ceiling is under what even a crowded room would allow", () => {
    // Two viewers would get 2500 kbps of the starting budget. A 500 kbps
    // ceiling is far under that, so something other than the room did this,
    // and the only other thing is the measurement.
    const measuredWeak = sender({ ceilingKbps: 500, targetKbps: 300, limitedBy: "none" });
    expect(isStrained(runOf(SUSTAINED_SAMPLES, measuredWeak))).toBe(true);
  });

  it("keeps speaking once the controller has adapted and the encoder is content", () => {
    // THE REASON THE RULE IS NOT JUST `limitedBy`. Measured on the 1 Mbps
    // harness run: after the budget cut the ceiling to fit, the encoder was
    // handed a target it could meet and reported `none`, which reset the
    // streak every few seconds and meant the sentence was never said. The
    // adaptation working must not be what silences the explanation for it.
    const adapted = sender({ ceilingKbps: 500, targetKbps: 250, limitedBy: "none" });
    expect(isStrained(runOf(SUSTAINED_SAMPLES * 3, adapted))).toBe(true);
  });

  it("counts the room's viewers, not the sender rows it can see", () => {
    // FOUND IN REVIEW. The manager splits the budget by `peers.size`, which
    // includes a peer still negotiating or sitting in `failed`; those produce
    // no sender row. Dividing by rows instead of viewers made a four-person
    // call with one stuck joiner (ceiling 5000/3, two rows) look like a weak
    // link and fired this warning at somebody on fibre.
    const stuckJoiner = sender({
      ceilingKbps: Math.round(5_000_000 / 3 / 1000),
      targetKbps: 1600,
      limitedBy: "none",
    });
    expect(
      isStrained(runOf(SUSTAINED_SAMPLES * 2, stuckJoiner, CHOSEN, 3, 2)),
    ).toBe(false);
  });

  it("stays quiet when a camera legitimately takes a slice of the room", () => {
    // FOUND IN REVIEW, TWICE. A mesh sends one copy per viewer and a camera on
    // the same uplink takes its own slice, so with both live the screen's
    // ceiling is legitimately two thirds of the share. The first cut had no
    // camera term at all; the second added it to one branch and left the other
    // comparing against the raw rung, so a five-way call on Auto sharing a
    // film with the camera on sat pinned at a perfectly reasonable ceiling and
    // was told its connection was the problem, on fibre, for the whole call.
    const viewers = 5;
    const cameraChosen = 1_500_000;
    // What such a room may spend on the screen: (5 Mbps / 5) x 2/3.
    const legitimate = Math.round((5_000_000 / viewers) * (CHOSEN / (CHOSEN + cameraChosen)));
    const pinned = sender({
      limitedBy: "bandwidth",
      ceilingKbps: Math.round(legitimate / 1000),
      targetKbps: Math.round((legitimate / 1000) * 0.98),
    });
    let streak = 0;
    for (let i = 0; i < SUSTAINED_SAMPLES * 3; i += 1) {
      streak = nextStrainStreak(streak, [pinned], CHOSEN, viewers, cameraChosen);
    }
    expect(isStrained(streak)).toBe(false);
  });

  it("still speaks when the link is short and a camera is on", () => {
    // The other half: the camera term must not silence a real problem. Same
    // room, but the ceiling is far under even the camera-adjusted expectation.
    const starvedWithCamera = sender({
      limitedBy: "bandwidth",
      ceilingKbps: 120,
      targetKbps: 60,
    });
    let streak = 0;
    for (let i = 0; i < SUSTAINED_SAMPLES; i += 1) {
      streak = nextStrainStreak(streak, [starvedWithCamera], CHOSEN, 5, 1_500_000);
    }
    expect(isStrained(streak)).toBe(true);
  });

  it("expects what the manager actually applies in a 1:1 call", () => {
    // The drift the shared `splitShare` removes. This rule used to write the
    // arithmetic out again without the 1:1 exemption, so a 1:1 call with a
    // camera and a 1080p share expected ~3.6 Mbps where the manager applied
    // the full 4. Harmless in that direction, but two copies of one formula
    // is how the screen controller got four different models in a day.
    const chosen1080p = 4_000_000;
    const atManagersCeiling = sender({
      limitedBy: "bandwidth",
      ceilingKbps: chosen1080p / 1000,
      targetKbps: (chosen1080p / 1000) * 0.98,
    });
    let streak = 0;
    for (let i = 0; i < SUSTAINED_SAMPLES * 2; i += 1) {
      streak = nextStrainStreak(streak, [atManagersCeiling], chosen1080p, 1, 1_500_000);
    }
    expect(isStrained(streak)).toBe(false);
  });

  it("forgets the streak the moment the link recovers", () => {
    // One good sample is enough to reset. A warning that lingered after the
    // cause had gone would be the same lie in slower motion.
    let streak = runOf(SUSTAINED_SAMPLES, starved);
    expect(isStrained(streak)).toBe(true);
    streak = nextStrainStreak(streak, [atCeiling, atCeiling], CHOSEN, 2);
    expect(isStrained(streak)).toBe(false);
    expect(streak).toBe(0);
  });

  it("treats a share with no reading yet as quiet, not as broken", () => {
    expect(isStrained(runOf(SUSTAINED_SAMPLES * 2, undefined))).toBe(false);
  });

  it("does not carry a previous share's grievance into the next one", () => {
    const carried = nextStrainStreak(runOf(SUSTAINED_SAMPLES, starved), [], CHOSEN, 2);
    expect(carried).toBe(0);
  });
});

/**
 * THE SEAM WITH ROOM PROMOTION.
 *
 * A room promoted onto the SFU mid-share keeps measuring. The SFU session
 * registers its own sender rows, and those carry the published plan as the
 * ceiling, so `describeLimitation` can tell fibre sitting on 4 Mbps from
 * a starving uplink. The mesh leftovers are gone with the mesh.
 */
describe("what is worth measuring at all", () => {
  it("measures a mesh share", () => {
    expect(shouldMeasureUplink(true, "mesh")).toBe(true);
  });

  it("measures a share on a server too old to state the transport", () => {
    // `null` is a room whose transport was never stated. Mesh is what those
    // deployments run, and it is what this warning was written against.
    expect(shouldMeasureUplink(true, null)).toBe(true);
  });

  it("keeps measuring after a live room is promoted to the voice server", () => {
    expect(shouldMeasureUplink(true, "livekit")).toBe(true);
  });

  it("measures nothing when this machine is not the one sharing", () => {
    expect(shouldMeasureUplink(false, "mesh")).toBe(false);
    expect(shouldMeasureUplink(false, "livekit")).toBe(false);
  });
});

describe("the SFU streak, one upload, no room split", () => {
  it("counts a sender the encoder says is bandwidth-limited", () => {
    expect(nextSfuStrainStreak(0, [starved])).toBe(1);
    expect(nextSfuStrainStreak(4, [starved])).toBe(5);
  });

  it("resets when the sender is sitting on the published ceiling", () => {
    expect(nextSfuStrainStreak(4, [atCeiling])).toBe(0);
  });

  it("resets when there is no screen sender yet", () => {
    expect(nextSfuStrainStreak(4, [])).toBe(0);
  });

  it("does not treat a paused layer as a strained uplink", () => {
    const paused = sender({ fps: 0, kbps: 0, targetKbps: 0, limitedBy: "bandwidth" });
    expect(nextSfuStrainStreak(4, [paused])).toBe(0);
  });
});
