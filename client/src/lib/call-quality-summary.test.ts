import { describe, expect, it } from "vitest";
import {
  createQualityAccumulator,
  createReconnectTracker,
  finishQuality,
  sampleQuality,
  trackReconnects,
} from "./call-quality-summary";
import type {
  CandidatePairSample,
  VideoReceiverSample,
  VideoSenderSample,
  VoiceStatsSnapshot,
} from "./voice-stats-probe";

/**
 * Feeds this the exact shape `sampleVoiceStats()` already produces for the
 * quality readouts, so the join tested here is "many snapshots in, one
 * compact summary out" rather than anything about `getStats()` itself --
 * `voice-stats-probe.test.ts` already owns that half.
 */

function sender(over: Partial<VideoSenderSample> = {}): VideoSenderSample {
  return {
    peerId: "me",
    role: "screen",
    width: 1280,
    height: 720,
    fps: 30,
    kbps: 1500,
    targetKbps: 1500,
    limitedBy: "bandwidth",
    ceilingKbps: 2000,
    limitDurations: { none: 4, bandwidth: 11, cpu: 0, other: 0 },
    encoder: "libvpx",
    framesEncoded: 100,
    framesSent: 100,
    keyFramesEncoded: 2,
    pliCount: 0,
    nackCount: 0,
    ...over,
  };
}

function receiver(over: Partial<VideoReceiverSample> = {}): VideoReceiverSample {
  return {
    peerId: "them",
    displayName: "Ana",
    role: "screen",
    width: 1920,
    height: 1080,
    fps: 24,
    kbps: 2000,
    framesDecoded: 500,
    decoder: "libvpx",
    freezeCount: 1,
    totalFreezesDuration: 0.5,
    framesDropped: 3,
    packetsLost: 0,
    ...over,
  };
}

function path(over: Partial<CandidatePairSample> = {}): CandidatePairSample {
  return {
    peerId: "them",
    localType: "srflx",
    remoteType: "srflx",
    relayed: false,
    rttMs: 60,
    availableOutgoingKbps: 3000,
    localAddress: null,
    remoteAddress: null,
    packetsLost: 0,
    packetsReceived: 100,
    ...over,
  };
}

function snapshot(over: Partial<VoiceStatsSnapshot> = {}): VoiceStatsSnapshot {
  return { senders: [], receivers: [], paths: [], ...over };
}

describe("sampleQuality / finishQuality", () => {
  it("returns nulls for both screen-share halves when nothing was ever sampled", () => {
    const acc = createQualityAccumulator();
    const result = finishQuality(acc);
    expect(result.outboundScreenShare).toBeNull();
    expect(result.inboundScreenShare).toBeNull();
    expect(result.packetLossPercent).toBeNull();
    expect(result.rttMsMedian).toBeNull();
    expect(result.relayed).toBeNull();
    expect(result.reconnectCount).toBe(0);
  });

  it("computes median and p10 of frame rate and height for an outbound screen share", () => {
    const acc = createQualityAccumulator();
    const fpsSeries = [30, 30, 6, 6, 30, 30, 30, 30, 30, 30]; // two bad readings
    for (const fps of fpsSeries) {
      sampleQuality(acc, snapshot({ senders: [sender({ fps, height: 720 })] }));
    }
    const result = finishQuality(acc);
    expect(result.outboundScreenShare).not.toBeNull();
    expect(result.outboundScreenShare!.frameRateMedian).toBe(30);
    // Nearest-rank 10th percentile of ten sorted readings is index 1 -- with
    // two bad readings that index lands on the bad reading, which is the
    // whole point of tracking it separately from the median.
    expect(result.outboundScreenShare!.frameRateP10).toBe(6);
    expect(result.outboundScreenShare!.frameHeightMedian).toBe(720);
  });

  it("reads bandwidth/cpu limited seconds off the latest cumulative reading, not a sum across ticks", () => {
    const acc = createQualityAccumulator();
    sampleQuality(
      acc,
      snapshot({
        senders: [sender({ limitDurations: { none: 2, bandwidth: 5, cpu: 0, other: 0 } })],
      }),
    );
    sampleQuality(
      acc,
      snapshot({
        senders: [sender({ limitDurations: { none: 2, bandwidth: 12, cpu: 1, other: 0 } })],
      }),
    );
    const result = finishQuality(acc);
    expect(result.outboundScreenShare!.bandwidthLimitedSeconds).toBe(12);
    expect(result.outboundScreenShare!.cpuLimitedSeconds).toBe(1);
  });

  it("ignores a camera sender when picking the outbound screen share", () => {
    const acc = createQualityAccumulator();
    sampleQuality(
      acc,
      snapshot({ senders: [sender({ role: "camera", fps: 30 })] }),
    );
    expect(finishQuality(acc).outboundScreenShare).toBeNull();
  });

  it("picks the inbound screen share with the most samples as 'watched most'", () => {
    const acc = createQualityAccumulator();
    // Peer A: three ticks. Peer B: one tick, then gone (a share glimpsed briefly).
    sampleQuality(
      acc,
      snapshot({
        receivers: [
          receiver({ peerId: "a", fps: 30, height: 1080 }),
          receiver({ peerId: "b", fps: 5, height: 240 }),
        ],
      }),
    );
    sampleQuality(acc, snapshot({ receivers: [receiver({ peerId: "a", fps: 30, height: 1080 })] }));
    sampleQuality(acc, snapshot({ receivers: [receiver({ peerId: "a", fps: 30, height: 1080 })] }));

    const result = finishQuality(acc);
    expect(result.inboundScreenShare).not.toBeNull();
    expect(result.inboundScreenShare!.frameRateMedian).toBe(30);
    expect(result.inboundScreenShare!.frameHeightMedian).toBe(1080);
  });

  it("carries freezeCount, freezeSeconds and framesDropped off the latest reading for the chosen inbound peer", () => {
    const acc = createQualityAccumulator();
    sampleQuality(
      acc,
      snapshot({
        receivers: [
          receiver({ freezeCount: 1, totalFreezesDuration: 0.5, framesDropped: 3 }),
        ],
      }),
    );
    sampleQuality(
      acc,
      snapshot({
        receivers: [
          receiver({ freezeCount: 4, totalFreezesDuration: 2.1, framesDropped: 9 }),
        ],
      }),
    );
    const result = finishQuality(acc);
    expect(result.inboundScreenShare!.freezeCount).toBe(4);
    expect(result.inboundScreenShare!.freezeSeconds).toBe(2.1);
    expect(result.inboundScreenShare!.framesDropped).toBe(9);
  });

  it("computes packet loss percent from accumulated windowed loss across ticks", () => {
    const acc = createQualityAccumulator();
    sampleQuality(acc, snapshot({ paths: [path({ packetsLost: 5, packetsReceived: 95 })] }));
    sampleQuality(acc, snapshot({ paths: [path({ packetsLost: 5, packetsReceived: 195 })] }));
    // Total lost 10, total received 290 -> 10 / 300 = 3.3%
    const result = finishQuality(acc);
    expect(result.packetLossPercent).toBe(3.3);
  });

  it("computes the RTT median across sampled paths", () => {
    const acc = createQualityAccumulator();
    for (const rttMs of [40, 60, 80]) {
      sampleQuality(acc, snapshot({ paths: [path({ rttMs })] }));
    }
    expect(finishQuality(acc).rttMsMedian).toBe(60);
  });

  it("reports relayed true only when most sampled paths were a TURN relay", () => {
    const acc = createQualityAccumulator();
    sampleQuality(acc, snapshot({ paths: [path({ relayed: true })] }));
    sampleQuality(acc, snapshot({ paths: [path({ relayed: true })] }));
    sampleQuality(acc, snapshot({ paths: [path({ relayed: false })] }));
    expect(finishQuality(acc).relayed).toBe(true);
  });

  it("reports relayed false when most sampled paths were direct", () => {
    const acc = createQualityAccumulator();
    sampleQuality(acc, snapshot({ paths: [path({ relayed: false })] }));
    sampleQuality(acc, snapshot({ paths: [path({ relayed: false })] }));
    sampleQuality(acc, snapshot({ paths: [path({ relayed: true })] }));
    expect(finishQuality(acc).relayed).toBe(false);
  });
});

describe("trackReconnects", () => {
  it("does not count a peer's first ever connection as a reconnect", () => {
    const tracker = createReconnectTracker();
    trackReconnects(tracker, [{ peerId: "a", connectionState: "connecting" }]);
    trackReconnects(tracker, [{ peerId: "a", connectionState: "connected" }]);
    expect(tracker.reconnectCount).toBe(0);
  });

  it("counts a peer going down after being connected and coming back", () => {
    const tracker = createReconnectTracker();
    trackReconnects(tracker, [{ peerId: "a", connectionState: "connected" }]);
    trackReconnects(tracker, [{ peerId: "a", connectionState: "failed" }]);
    trackReconnects(tracker, [{ peerId: "a", connectionState: "connecting" }]);
    trackReconnects(tracker, [{ peerId: "a", connectionState: "connected" }]);
    expect(tracker.reconnectCount).toBe(1);
  });

  it("counts each peer independently", () => {
    const tracker = createReconnectTracker();
    trackReconnects(tracker, [
      { peerId: "a", connectionState: "connected" },
      { peerId: "b", connectionState: "connected" },
    ]);
    trackReconnects(tracker, [
      { peerId: "a", connectionState: "failed" },
      { peerId: "b", connectionState: "failed" },
    ]);
    trackReconnects(tracker, [
      { peerId: "a", connectionState: "connected" },
      { peerId: "b", connectionState: "connected" },
    ]);
    expect(tracker.reconnectCount).toBe(2);
  });

  it("a new peer joining mid-call while another already reconnected is not itself counted", () => {
    const tracker = createReconnectTracker();
    trackReconnects(tracker, [{ peerId: "a", connectionState: "connected" }]);
    trackReconnects(tracker, [
      { peerId: "a", connectionState: "failed" },
      { peerId: "b", connectionState: "connecting" },
    ]);
    trackReconnects(tracker, [
      { peerId: "a", connectionState: "connected" },
      { peerId: "b", connectionState: "connected" },
    ]);
    expect(tracker.reconnectCount).toBe(1);
  });
});
