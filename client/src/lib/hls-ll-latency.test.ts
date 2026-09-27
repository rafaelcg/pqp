import { describe, expect, it } from "vitest";
import {
  LL_CEILING_HEADROOM_SECONDS,
  LL_PARTS_MIN_TARGET_SECONDS,
  LL_PARTS_OPT_IN_KEY,
  LL_SEGMENT_CADENCE_WINDOW,
  LL_SEGMENTS_CATCH_UP_RATE,
  LL_SEGMENTS_FETCH_MARGIN_SECONDS,
  LL_SEGMENTS_MIN_SESSION_AGE_MS,
  LL_SEGMENTS_SLOW_DOWN_RATE,
  LL_SEGMENTS_TARGET_SECONDS,
  LL_TARGET_DECAY_AFTER_MS,
  LL_TARGET_DECAY_SECONDS,
  LL_TARGET_MAX_SECONDS,
  LL_TARGET_STEP_SECONDS,
  LlLatencyGovernor,
  llPartsOptedIn,
  llSegmentsCatchUpRate,
  hlsSessionStartedAtMs,
  llStartDelayMs,
} from "./hls-ll-latency";

const T0 = 1_000_000;

describe("LlLatencyGovernor", () => {
  it("starts LL-lite on whole segments ~8 s behind, with the ceiling well clear", () => {
    const g = new LlLatencyGovernor({ delivery: "segments", now: T0 });
    expect(g.state()).toEqual({
      delivery: "segments",
      targetSeconds: LL_SEGMENTS_TARGET_SECONDS,
      ceilingSeconds: LL_SEGMENTS_TARGET_SECONDS + LL_CEILING_HEADROOM_SECONDS,
    });
    // Under the 10 s latency bar the investigation set for merging.
    expect(LL_SEGMENTS_TARGET_SECONDS).toBeLessThan(10);
  });

  it("never lets a parts manifest pull the target under its floor, but obeys one asking for more", () => {
    const g = new LlLatencyGovernor({ delivery: "parts", now: T0 });
    g.onManifest({ partHoldBackSeconds: 3.072 });
    expect(g.state().targetSeconds).toBe(LL_PARTS_MIN_TARGET_SECONDS);
    g.onManifest({ partHoldBackSeconds: 7 });
    expect(g.state().targetSeconds).toBe(7);
  });

  it("buys room on every stall and caps it", () => {
    const g = new LlLatencyGovernor({ delivery: "segments", now: T0 });
    g.onStall(T0 + 1_000);
    expect(g.state().targetSeconds).toBe(
      LL_SEGMENTS_TARGET_SECONDS + LL_TARGET_STEP_SECONDS,
    );
    for (let i = 0; i < 20; i += 1) {
      g.onStall(T0 + 2_000 + i * 70_000);
    }
    expect(g.state().targetSeconds).toBe(LL_TARGET_MAX_SECONDS);
  });

  it("gives room back slowly while healthy, never under the floor", () => {
    const g = new LlLatencyGovernor({ delivery: "segments", now: T0 });
    g.onStall(T0);
    g.tick(T0 + LL_TARGET_DECAY_AFTER_MS - 1);
    expect(g.state().targetSeconds).toBe(
      LL_SEGMENTS_TARGET_SECONDS + LL_TARGET_STEP_SECONDS,
    );
    g.tick(T0 + LL_TARGET_DECAY_AFTER_MS);
    expect(g.state().targetSeconds).toBe(
      LL_SEGMENTS_TARGET_SECONDS + LL_TARGET_STEP_SECONDS - LL_TARGET_DECAY_SECONDS,
    );
    for (let i = 2; i < 20; i += 1) {
      g.tick(T0 + i * LL_TARGET_DECAY_AFTER_MS);
    }
    expect(g.state().targetSeconds).toBe(LL_SEGMENTS_TARGET_SECONDS);
  });

  it("never gives room back during a freeze that is still going (Farol, PR 785)", () => {
    const g = new LlLatencyGovernor({ delivery: "segments", now: T0 });
    g.onStall(T0);
    // A long freeze: every tick reports it, and the target holds.
    for (let t = 1_000; t <= 3 * LL_TARGET_DECAY_AFTER_MS; t += 1_000) {
      g.tick(T0 + t, true);
    }
    const held = LL_SEGMENTS_TARGET_SECONDS + LL_TARGET_STEP_SECONDS;
    expect(g.state().targetSeconds).toBe(held);
    // The clean minute counts from the end of the freeze, not its start.
    const end = T0 + 3 * LL_TARGET_DECAY_AFTER_MS;
    g.tick(end + LL_TARGET_DECAY_AFTER_MS - 1);
    expect(g.state().targetSeconds).toBe(held);
    g.tick(end + LL_TARGET_DECAY_AFTER_MS);
    expect(g.state().targetSeconds).toBe(held - LL_TARGET_DECAY_SECONDS);
  });

  it("moves parts to segments on the third stall inside a minute, not the second", () => {
    const g = new LlLatencyGovernor({ delivery: "parts", now: T0 });
    expect(g.onStall(T0 + 1_000)).toBe(false);
    expect(g.onStall(T0 + 20_000)).toBe(false);
    expect(g.onStall(T0 + 40_000)).toBe(true);
    expect(g.state().delivery).toBe("segments");
    expect(g.state().targetSeconds).toBeGreaterThanOrEqual(LL_SEGMENTS_TARGET_SECONDS);
  });

  it("does not count stalls a minute apart toward the switch", () => {
    const g = new LlLatencyGovernor({ delivery: "parts", now: T0 });
    g.onStall(T0);
    g.onStall(T0 + 61_000);
    g.onStall(T0 + 122_000);
    expect(g.state().delivery).toBe("parts");
  });

  it("moves parts to segments on two part-load errors inside 10 s (the old pin rule, in place)", () => {
    const g = new LlLatencyGovernor({ delivery: "parts", now: T0 });
    expect(g.onPartLoadError(T0)).toBe(false);
    expect(g.onPartLoadError(T0 + 10_001)).toBe(false);
    expect(g.onPartLoadError(T0 + 15_000)).toBe(true);
    expect(g.state().delivery).toBe("segments");
    // Already on segments: nothing further to switch.
    expect(g.onPartLoadError(T0 + 15_500)).toBe(false);
  });
});

// Rehearsal 2026-09-25 (one LL show, one UK viewer): the manifest said
// EXT-X-TARGETDURATION 8, and 12 after the presenter reloaded, while an
// LL-lite viewer aimed 8 s behind the edge. On whole segments the newest
// media a viewer can load ends where the newest COMPLETE segment ends, so a
// target shorter than a segment runs the buffer dry every time a long one
// is being written. Lab (tools/ll-loss-harness, the real player, a keyframe
// every 8.3 s, TARGETDURATION 9 to 13): 14 s of stalls in 4 min on a CLEAN
// link.
describe("LlLatencyGovernor on segments: the manifest's segment length is a floor", () => {
  it("never aims closer than one target duration plus a fetch", () => {
    const g = new LlLatencyGovernor({ delivery: "segments", now: T0 });
    g.onManifest({ targetDurationSeconds: 8 });
    expect(g.state().targetSeconds).toBe(8 + LL_SEGMENTS_FETCH_MARGIN_SECONDS);
    g.onManifest({ targetDurationSeconds: 12 });
    expect(g.state().targetSeconds).toBe(12 + LL_SEGMENTS_FETCH_MARGIN_SECONDS);
  });

  it("keeps the 8 s start when segments are short, and ignores nonsense", () => {
    const g = new LlLatencyGovernor({ delivery: "segments", now: T0 });
    g.onManifest({ targetDurationSeconds: 4 });
    expect(g.state().targetSeconds).toBe(LL_SEGMENTS_TARGET_SECONDS);
    g.onManifest({ targetDurationSeconds: Number.NaN });
    g.onManifest({ targetDurationSeconds: -3 });
    g.onManifest({ targetDurationSeconds: 999 });
    expect(g.state().targetSeconds).toBe(LL_SEGMENTS_TARGET_SECONDS);
  });

  it("does not lower the floor when a manifest reports a shorter target", () => {
    const g = new LlLatencyGovernor({ delivery: "segments", now: T0 });
    g.onManifest({ targetDurationSeconds: 12 });
    g.onManifest({ targetDurationSeconds: 8 });
    expect(g.state().targetSeconds).toBe(12 + LL_SEGMENTS_FETCH_MARGIN_SECONDS);
  });

  it("gives decayed room back only down to that floor", () => {
    const g = new LlLatencyGovernor({ delivery: "segments", now: T0 });
    g.onManifest({ targetDurationSeconds: 8 });
    g.onStall(T0 + 1_000);
    for (let i = 2; i < 20; i += 1) {
      g.tick(T0 + i * LL_TARGET_DECAY_AFTER_MS);
    }
    expect(g.state().targetSeconds).toBe(8 + LL_SEGMENTS_FETCH_MARGIN_SECONDS);
  });

  it("lets a stall still buy room above a floor that is already past the old cap", () => {
    const g = new LlLatencyGovernor({ delivery: "segments", now: T0 });
    g.onManifest({ targetDurationSeconds: 13 });
    const floor = 13 + LL_SEGMENTS_FETCH_MARGIN_SECONDS;
    expect(floor).toBeGreaterThan(LL_TARGET_MAX_SECONDS);
    g.onStall(T0 + 1_000);
    expect(g.state().targetSeconds).toBe(floor + LL_TARGET_STEP_SECONDS);
  });

  it("puts the force-seek ceiling a whole segment above the target", () => {
    // Latency is measured to the edge of the OPEN segment, which a segments
    // viewer cannot load. With the ceiling 6 s above an 11 s target and 12 s
    // segments, hls.js force-seeked forward past the buffer (lab: a 6.4 s
    // stall that the seek itself caused).
    const g = new LlLatencyGovernor({ delivery: "segments", now: T0 });
    g.onManifest({ targetDurationSeconds: 12 });
    const s = g.state();
    expect(s.ceilingSeconds - s.targetSeconds).toBeGreaterThanOrEqual(12);
  });

  it("leaves parts delivery alone: parts can load inside the open segment", () => {
    const g = new LlLatencyGovernor({ delivery: "parts", now: T0 });
    g.onManifest({ targetDurationSeconds: 12 });
    expect(g.state()).toEqual({
      delivery: "parts",
      targetSeconds: LL_PARTS_MIN_TARGET_SECONDS,
      ceilingSeconds: LL_PARTS_MIN_TARGET_SECONDS + LL_CEILING_HEADROOM_SECONDS,
    });
  });

  it("applies the remembered segment length when a parts viewer moves to segments", () => {
    const g = new LlLatencyGovernor({ delivery: "parts", now: T0 });
    g.onManifest({ targetDurationSeconds: 9 });
    g.onPartLoadError(T0);
    g.onPartLoadError(T0 + 1_000);
    expect(g.state().delivery).toBe("segments");
    expect(g.state().targetSeconds).toBe(9 + LL_SEGMENTS_FETCH_MARGIN_SECONDS);
  });
});

// The flag is off by default, and off means BYTE FOR BYTE the ratchet
// above ("gives decayed room back only down to that floor" never moves
// `floorSeconds`). On (`segmentCadenceDecay: () => true`), a manifest that once
// recorded a slow segment may still give room back, but never past what
// recent REAL segments prove is happening now, and never faster than the
// ordinary decay step.
describe("LlLatencyGovernor's segment-cadence decay (LIVE_HLS_LL_SEGMENT_CADENCE_DECAY)", () => {
  it("does nothing at all while the flag is off, whatever segments report", () => {
    const g = new LlLatencyGovernor({ delivery: "segments", now: T0 });
    g.onManifest({ targetDurationSeconds: 13 });
    for (let i = 0; i < LL_SEGMENT_CADENCE_WINDOW + 5; i += 1) {
      g.onSegmentDuration(4.1);
    }
    for (let i = 1; i < 20; i += 1) {
      g.tick(T0 + i * LL_TARGET_DECAY_AFTER_MS);
    }
    expect(g.state().targetSeconds).toBe(13 + LL_SEGMENTS_FETCH_MARGIN_SECONDS);
  });

  it("waits for a full window of real segments before it lowers anything", () => {
    const g = new LlLatencyGovernor({
      delivery: "segments",
      now: T0,
      segmentCadenceDecay: () => true,
    });
    g.onManifest({ targetDurationSeconds: 13 });
    const stuckFloor = 13 + LL_SEGMENTS_FETCH_MARGIN_SECONDS;
    for (let i = 0; i < LL_SEGMENT_CADENCE_WINDOW - 1; i += 1) {
      g.onSegmentDuration(4.1);
      g.tick(T0 + (i + 1) * LL_TARGET_DECAY_AFTER_MS);
    }
    expect(g.state().targetSeconds).toBe(stuckFloor);
  });

  it("gives the floor back once a full window of short segments lands, one step per clean tick", () => {
    const g = new LlLatencyGovernor({
      delivery: "segments",
      now: T0,
      segmentCadenceDecay: () => true,
    });
    g.onManifest({ targetDurationSeconds: 13 });
    const stuckFloor = 13 + LL_SEGMENTS_FETCH_MARGIN_SECONDS; // 16
    const evidencedFloor = 6 + LL_SEGMENTS_FETCH_MARGIN_SECONDS; // 9, above the hard 8 s minimum
    for (let i = 0; i < LL_SEGMENT_CADENCE_WINDOW; i += 1) {
      g.onSegmentDuration(6);
    }
    let tickN = 1;
    g.tick(T0 + tickN * LL_TARGET_DECAY_AFTER_MS);
    tickN += 1;
    expect(g.state().targetSeconds).toBe(stuckFloor - LL_TARGET_DECAY_SECONDS);
    // Keeps stepping down, never overshooting the evidenced floor.
    for (let i = 0; i < 20; i += 1) {
      g.tick(T0 + tickN * LL_TARGET_DECAY_AFTER_MS);
      tickN += 1;
    }
    expect(g.state().targetSeconds).toBe(evidencedFloor);
  });

  it("never lowers past LL_SEGMENTS_TARGET_SECONDS even with tiny real segments", () => {
    const g = new LlLatencyGovernor({
      delivery: "segments",
      now: T0,
      segmentCadenceDecay: () => true,
    });
    g.onManifest({ targetDurationSeconds: 13 });
    for (let i = 0; i < LL_SEGMENT_CADENCE_WINDOW; i += 1) {
      g.onSegmentDuration(0.5);
    }
    for (let i = 1; i < 40; i += 1) {
      g.tick(T0 + i * LL_TARGET_DECAY_AFTER_MS);
    }
    expect(g.state().targetSeconds).toBe(LL_SEGMENTS_TARGET_SECONDS);
  });

  it("a single slow segment reappearing raises the floor again on the very next manifest update", () => {
    const g = new LlLatencyGovernor({
      delivery: "segments",
      now: T0,
      segmentCadenceDecay: () => true,
    });
    g.onManifest({ targetDurationSeconds: 13 });
    for (let i = 0; i < LL_SEGMENT_CADENCE_WINDOW; i += 1) {
      g.onSegmentDuration(6);
    }
    for (let i = 1; i < 30; i += 1) {
      g.tick(T0 + i * LL_TARGET_DECAY_AFTER_MS);
    }
    expect(g.state().targetSeconds).toBe(6 + LL_SEGMENTS_FETCH_MARGIN_SECONDS);
    // A slow segment lands (its own EXTINF pushes the manifest's own
    // targetduration up too) -- the raise is instant, same tick.
    g.onManifest({ targetDurationSeconds: 15 });
    expect(g.state().targetSeconds).toBe(15 + LL_SEGMENTS_FETCH_MARGIN_SECONDS);
  });

  it("only ever tracks the last LL_SEGMENT_CADENCE_WINDOW segments (max, not average)", () => {
    const g = new LlLatencyGovernor({
      delivery: "segments",
      now: T0,
      segmentCadenceDecay: () => true,
    });
    g.onManifest({ targetDurationSeconds: 13 });
    // One slow segment, then enough short ones to push it out of the window.
    g.onSegmentDuration(20);
    for (let i = 0; i < LL_SEGMENT_CADENCE_WINDOW; i += 1) {
      g.onSegmentDuration(6);
    }
    for (let i = 1; i < 30; i += 1) {
      g.tick(T0 + i * LL_TARGET_DECAY_AFTER_MS);
    }
    // The 20 s outlier has aged out of the window entirely.
    expect(g.state().targetSeconds).toBe(6 + LL_SEGMENTS_FETCH_MARGIN_SECONDS);
  });

  it("is a no-op on parts delivery and ignores nonsense durations", () => {
    const g = new LlLatencyGovernor({
      delivery: "parts",
      now: T0,
      segmentCadenceDecay: () => true,
    });
    g.onSegmentDuration(4.1);
    g.onSegmentDuration(Number.NaN);
    g.onSegmentDuration(-1);
    g.onSegmentDuration(0);
    // Still parts-mode behaviour, untouched.
    g.onManifest({ partHoldBackSeconds: 7 });
    expect(g.state().targetSeconds).toBe(7);
  });

  // Farol, this PR: an observed segment longer than the CURRENT floor must
  // raise it immediately, not only bound how far a later decay may lower
  // it -- otherwise a genuinely slow segment sitting inside an
  // already-decayed window is invisible until the next `onManifest` call
  // happens to catch up (and `EXT-X-TARGETDURATION` is an integer that can
  // stay unchanged while real segments already got longer).
  it("raises the floor the instant an observed segment needs more room than the floor currently gives", () => {
    const g = new LlLatencyGovernor({
      delivery: "segments",
      now: T0,
      segmentCadenceDecay: () => true,
    });
    // No onManifest call at all: the floor starts at its bare minimum.
    expect(g.state().targetSeconds).toBe(LL_SEGMENTS_TARGET_SECONDS);
    g.onSegmentDuration(10);
    expect(g.state().targetSeconds).toBe(10 + LL_SEGMENTS_FETCH_MARGIN_SECONDS);
    // A shorter reading right after does not undo the raise.
    g.onSegmentDuration(4);
    expect(g.state().targetSeconds).toBe(10 + LL_SEGMENTS_FETCH_MARGIN_SECONDS);
  });

  it("the exact Farol scenario: 10 s segments after the floor decayed to 9 s on 6 s segments", () => {
    const g = new LlLatencyGovernor({
      delivery: "segments",
      now: T0,
      segmentCadenceDecay: () => true,
    });
    g.onManifest({ targetDurationSeconds: 13 }); // stuck floor 16
    for (let i = 0; i < LL_SEGMENT_CADENCE_WINDOW; i += 1) {
      g.onSegmentDuration(6);
    }
    let tickN = 1;
    for (let i = 0; i < 30; i += 1) {
      g.tick(T0 + tickN * LL_TARGET_DECAY_AFTER_MS);
      tickN += 1;
    }
    // Decayed all the way to the 6 s evidence, exactly as the earlier test
    // already pins.
    expect(g.state().targetSeconds).toBe(6 + LL_SEGMENTS_FETCH_MARGIN_SECONDS); // 9
    // Cadence slows to 10 s. `EXT-X-TARGETDURATION` (13 in this scenario)
    // does not change -- 10 s segments still fit under it -- so `onManifest`
    // alone would never raise the floor back up. The observation itself
    // must.
    g.onSegmentDuration(10);
    expect(g.state().targetSeconds).toBe(10 + LL_SEGMENTS_FETCH_MARGIN_SECONDS); // 13
    // And it does not decay back down on the next clean tick either: the
    // evidence in the window (six 6 s readings plus a fresh 10 s one) has a
    // max of 10, so the evidenced floor IS 13 -- nothing to give back yet.
    g.tick(T0 + tickN * LL_TARGET_DECAY_AFTER_MS);
    expect(g.state().targetSeconds).toBe(10 + LL_SEGMENTS_FETCH_MARGIN_SECONDS);
  });

  it("a live getter: turning the flag on mid-session (no reconstruction) is enough, no rebuild needed", () => {
    let flagOn = false;
    const g = new LlLatencyGovernor({
      delivery: "segments",
      now: T0,
      // A FUNCTION READ FRESH EACH TIME, exactly like
      // `settledDeploymentLiveHlsConfig()?.llSegmentCadenceDecay` in
      // `hls-watch-player.tsx` -- this is the property that construction-
      // time snapshot did not have (Farol, this PR): the SAME governor
      // instance has to notice the flag turning on mid-attach.
      segmentCadenceDecay: () => flagOn,
    });
    g.onManifest({ targetDurationSeconds: 13 }); // floor 16
    // While the flag reads false: byte-for-byte today's shipped
    // behaviour. `onSegmentDuration` is a complete no-op (not even
    // recorded into the window), same as construction never having
    // received `segmentCadenceDecay` at all.
    g.onSegmentDuration(6);
    g.tick(T0 + LL_TARGET_DECAY_AFTER_MS);
    expect(g.state().targetSeconds).toBe(16);
    // The deployment config settles true (`loadLiveHlsConfig()` resolving
    // in the real caller) -- no new governor, no attach rebuild, same
    // instance, same closure.
    flagOn = true;
    let tickN = 2;
    for (let i = 0; i < LL_SEGMENT_CADENCE_WINDOW; i += 1) {
      g.onSegmentDuration(6);
    }
    for (let i = 0; i < 30; i += 1) {
      g.tick(T0 + tickN * LL_TARGET_DECAY_AFTER_MS);
      tickN += 1;
    }
    expect(g.state().targetSeconds).toBe(6 + LL_SEGMENTS_FETCH_MARGIN_SECONDS);
  });
});

describe("llPartsOptedIn", () => {
  it("is off unless the browser asked, and never throws", () => {
    expect(llPartsOptedIn(null)).toBe(false);
    expect(llPartsOptedIn({ getItem: () => null })).toBe(false);
    expect(
      llPartsOptedIn({ getItem: (k) => (k === LL_PARTS_OPT_IN_KEY ? "1" : null) }),
    ).toBe(true);
    expect(
      llPartsOptedIn({
        getItem: () => {
          throw new Error("SecurityError");
        },
      }),
    ).toBe(false);
  });
});

describe("llSegmentsCatchUpRate", () => {
  it("gives latency back at 1.05x only past a second behind and with buffer to spare", () => {
    expect(
      llSegmentsCatchUpRate({ latencySeconds: 10, targetSeconds: 8, bufferAheadSeconds: 5 }),
    ).toBe(LL_SEGMENTS_CATCH_UP_RATE);
    expect(
      llSegmentsCatchUpRate({ latencySeconds: 8.9, targetSeconds: 8, bufferAheadSeconds: 5 }),
    ).toBe(1);
    // Thin buffer: speeding up is how a late viewer becomes a waiting one.
    expect(
      llSegmentsCatchUpRate({ latencySeconds: 12, targetSeconds: 8, bufferAheadSeconds: 2 }),
    ).toBe(1);
    expect(
      llSegmentsCatchUpRate({ latencySeconds: null, targetSeconds: 8, bufferAheadSeconds: 9 }),
    ).toBe(1);
  });

  it("slows down to build the cushion a stall asked for", () => {
    expect(
      llSegmentsCatchUpRate({ latencySeconds: 8.3, targetSeconds: 9, bufferAheadSeconds: 1 }),
    ).toBe(LL_SEGMENTS_SLOW_DOWN_RATE);
    expect(
      llSegmentsCatchUpRate({ latencySeconds: 8.6, targetSeconds: 9, bufferAheadSeconds: 1 }),
    ).toBe(1);
  });
});

describe("llStartDelayMs / hlsSessionStartedAtMs", () => {
  const url =
    "https://hls.pqp.gg/api/voice/hls-playlist/ad99074f-a4d3-4919-a782-122b7150ed87/1790315718334?t=abc";

  it("reads the session start off the playlist URL, API or edge host", () => {
    expect(hlsSessionStartedAtMs(url)).toBe(1790315718334);
    expect(
      hlsSessionStartedAtMs("/api/voice/hls-playlist/ad99074f/1790315718334"),
    ).toBe(1790315718334);
    expect(hlsSessionStartedAtMs("/api/voice/hls-replay/ad99074f/1790315718334")).toBeNull();
    expect(hlsSessionStartedAtMs("https://bucket/live/ad99074f/1790315718334.m3u8")).toBeNull();
    expect(hlsSessionStartedAtMs(null)).toBeNull();
  });

  it("holds the rehearsal's go-live join until the session is old enough for a cushion", () => {
    // The viewer attached about a second after startedAt.
    const startedAt = 1790315718334;
    expect(
      llStartDelayMs({ delivery: "segments", sessionStartedAtMs: startedAt, now: startedAt + 1_000 }),
    ).toBe(LL_SEGMENTS_MIN_SESSION_AGE_MS - 1_000);
    expect(
      llStartDelayMs({
        delivery: "segments",
        sessionStartedAtMs: startedAt,
        now: startedAt + LL_SEGMENTS_MIN_SESSION_AGE_MS,
      }),
    ).toBe(0);
  });

  it("never delays a session in progress, a parts viewer, or an unknown start", () => {
    expect(llStartDelayMs({ delivery: "segments", sessionStartedAtMs: T0, now: T0 + 600_000 })).toBe(0);
    expect(llStartDelayMs({ delivery: "parts", sessionStartedAtMs: T0, now: T0 })).toBe(0);
    expect(llStartDelayMs({ delivery: "segments", sessionStartedAtMs: null, now: T0 })).toBe(0);
  });

  it("caps the wait when the client clock runs behind the server's", () => {
    expect(
      llStartDelayMs({ delivery: "segments", sessionStartedAtMs: T0 + 60_000, now: T0 }),
    ).toBe(LL_SEGMENTS_MIN_SESSION_AGE_MS);
  });
});
