import { describe, expect, it } from "vitest";
import {
  LL_CEILING_HEADROOM_SECONDS,
  LL_PARTS_MIN_TARGET_SECONDS,
  LL_PARTS_OPT_IN_KEY,
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
