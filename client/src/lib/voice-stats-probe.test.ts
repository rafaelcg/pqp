import { describe, expect, it } from "vitest";
import { summariseStats, type RtcStatLike } from "./voice-stats-probe";

/**
 * The joining is the whole of this module's risk.
 *
 * `getStats()` hands back a flat bag of objects that only means something once
 * outbound-rtp is followed to its media-source to its track id, and the
 * transport to its selected pair to the two candidates. Getting either chain
 * wrong produces a report that looks plausible and answers the wrong question,
 * which is worse than no report at all — so both are pinned here, along with
 * the byte-delta arithmetic that is the difference between "the encoder is
 * starving right now" and "the call averaged fine".
 */

const PEER = "peer-abcdef01";

const report = (over: Partial<RtcStatLike>[] = []): RtcStatLike[] => [
  {
    id: "OT01",
    type: "outbound-rtp",
    kind: "video",
    mediaSourceId: "SV1",
    timestamp: 1000,
    bytesSent: 100_000,
    frameWidth: 1280,
    frameHeight: 720,
    framesPerSecond: 30,
    targetBitrate: 1_500_000,
    qualityLimitationReason: "bandwidth",
    qualityLimitationDurations: { none: 4, bandwidth: 11, cpu: 0, other: 0 },
    encoderImplementation: "libvpx",
    pliCount: 2,
  },
  { id: "SV1", type: "media-source", kind: "video", trackIdentifier: "track-cam" },
  { id: "T1", type: "transport", selectedCandidatePairId: "CP1" },
  {
    id: "CP1",
    type: "candidate-pair",
    localCandidateId: "L1",
    remoteCandidateId: "R1",
    currentRoundTripTime: 0.042,
    availableOutgoingBitrate: 900_000,
  },
  { id: "L1", type: "local-candidate", candidateType: "srflx", address: "1.2.3.4" },
  { id: "R1", type: "remote-candidate", candidateType: "relay", address: "5.6.7.8" },
  ...over,
];

const roles = (trackId: string) =>
  trackId === "track-cam" ? ("camera" as const) : ("screen" as const);

describe("summariseStats", () => {
  it("labels a sender by following outbound-rtp to its media source track", () => {
    const { senders } = summariseStats(PEER, report(), roles, new Map());
    expect(senders).toHaveLength(1);
    expect(senders[0]!.role).toBe("camera");
    expect(senders[0]!.width).toBe(1280);
    expect(senders[0]!.height).toBe(720);
    expect(senders[0]!.fps).toBe(30);
  });

  it("surfaces the limitation reason and its running durations", () => {
    const { senders } = summariseStats(PEER, report(), roles, new Map());
    expect(senders[0]!.limitedBy).toBe("bandwidth");
    expect(senders[0]!.limitDurations).toEqual({
      none: 4,
      bandwidth: 11,
      cpu: 0,
      other: 0,
    });
  });

  it("reports no bitrate on the first sample and a delta on the second", () => {
    const marks = new Map<string, { bytesSent: number; timestamp: number }>();
    const first = summariseStats(PEER, report(), roles, marks);
    expect(first.senders[0]!.kbps).toBeNull();

    // One second later, 50 kB more on the wire: 400 kbit/s.
    const later = report().map((stat) =>
      stat.id === "OT01"
        ? { ...stat, timestamp: 2000, bytesSent: 150_000 }
        : stat,
    );
    const second = summariseStats(PEER, later, roles, marks);
    expect(second.senders[0]!.kbps).toBe(400);
  });

  it("takes the pair the transport points at, not every succeeded pair", () => {
    const decoy: RtcStatLike = {
      id: "CP2",
      type: "candidate-pair",
      nominated: true,
      state: "succeeded",
      localCandidateId: "L1",
      remoteCandidateId: "R1",
    };
    const { paths } = summariseStats(PEER, report([decoy]), roles, new Map());
    expect(paths).toHaveLength(1);
    expect(paths[0]!.rttMs).toBe(42);
    expect(paths[0]!.availableOutgoingKbps).toBe(900);
  });

  it("calls a pair relayed when either end is a TURN allocation", () => {
    const { paths } = summariseStats(PEER, report(), roles, new Map());
    expect(paths[0]!.localType).toBe("srflx");
    expect(paths[0]!.remoteType).toBe("relay");
    expect(paths[0]!.relayed).toBe(true);
  });

  it("falls back to the nominated pair when no transport names one", () => {
    const withoutTransport = report()
      .filter((stat) => stat.type !== "transport")
      .map((stat) =>
        stat.id === "CP1"
          ? { ...stat, nominated: true, state: "succeeded" }
          : stat,
      );
    const { paths } = summariseStats(PEER, withoutTransport, roles, new Map());
    expect(paths).toHaveLength(1);
    expect(paths[0]!.relayed).toBe(true);
  });

  it("ignores audio senders and survives a report with nothing in it", () => {
    const audioOnly: RtcStatLike[] = [
      { id: "OA1", type: "outbound-rtp", kind: "audio", bytesSent: 1 },
    ];
    const { senders, paths } = summariseStats(
      PEER,
      audioOnly,
      roles,
      new Map(),
    );
    expect(senders).toEqual([]);
    expect(paths).toEqual([]);
  });

  it("says unknown rather than guessing when the track cannot be resolved", () => {
    const orphaned = report().filter((stat) => stat.id !== "SV1");
    const { senders } = summariseStats(PEER, orphaned, roles, new Map());
    expect(senders[0]!.role).toBe("unknown");
  });
});
