import { describe, expect, it } from "vitest";
import {
  describeLimitation,
  statRows,
  summariseStats,
  type RtcStatLike,
  type VideoSenderSample,
} from "./voice-stats-probe";

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
    const marks = new Map<string, { bytes: number; timestamp: number }>();
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

  it("reports no receivers at all when nothing is arriving", () => {
    const { receivers } = summariseStats(PEER, report(), roles, new Map());
    expect(receivers).toEqual([]);
  });

  it("says unknown rather than guessing when the track cannot be resolved", () => {
    const orphaned = report().filter((stat) => stat.id !== "SV1");
    const { senders } = summariseStats(PEER, orphaned, roles, new Map());
    expect(senders[0]!.role).toBe("unknown");
  });

  it("carries the sender's own ceiling through when one is offered", () => {
    const { senders } = summariseStats(PEER, report(), roles, new Map(), () =>
      1_500_000,
    );
    expect(senders[0]!.ceilingKbps).toBe(1_500);
  });
});

/**
 * The receiving half, which is the half nobody was measuring.
 *
 * WHY IT MATTERS ENOUGH TO HAVE ITS OWN BLOCK. Every number this module
 * produced came off the local sender, so a call could be measured in complete
 * detail by the one person whose picture was fine and not at all by the person
 * watching it go soft. That is exactly how a screen share sent from the iOS app
 * got reported as "it looked 360p" with no figure attached: the only machine
 * that could see the problem had no way to put a number on it.
 *
 * A sender's `getParameters()` is not a substitute, and this is the trap a
 * previous pass fell into. It proves the browser accepted the numbers it was
 * given. It cannot tell 360p from 1080p squeezed into 360p worth of bits, and
 * those two are identical from the sending side and completely different to
 * whoever is watching. `inbound-rtp` `frameWidth`/`frameHeight` is the only
 * place the truth is written down.
 */
describe("summariseStats, inbound", () => {
  const inbound = (over: Partial<RtcStatLike> = {}): RtcStatLike => ({
    id: "IT01",
    type: "inbound-rtp",
    kind: "video",
    // Straight off the stat, with no media-source hop: the source belongs to
    // somebody else's machine, so there is nothing local to follow it to.
    trackIdentifier: "track-their-screen",
    timestamp: 1000,
    bytesReceived: 500_000,
    frameWidth: 640,
    frameHeight: 360,
    framesPerSecond: 12,
    framesDecoded: 300,
    decoderImplementation: "ExternalDecoder",
    freezeCount: 2,
    packetsLost: 7,
    ...over,
  });

  const remoteRoles = (trackId: string) =>
    trackId === "track-their-screen" ? ("screen" as const) : ("camera" as const);

  it("reports the size that actually arrived, which is all a viewer can see", () => {
    const { receivers } = summariseStats(
      PEER,
      report([inbound()]),
      roles,
      new Map(),
      undefined,
      remoteRoles,
    );
    expect(receivers).toHaveLength(1);
    expect(receivers[0]!.width).toBe(640);
    expect(receivers[0]!.height).toBe(360);
    expect(receivers[0]!.fps).toBe(12);
    expect(receivers[0]!.role).toBe("screen");
    expect(receivers[0]!.framesDecoded).toBe(300);
    expect(receivers[0]!.freezeCount).toBe(2);
    expect(receivers[0]!.packetsLost).toBe(7);
  });

  it("differences bytesReceived rather than reporting the running total", () => {
    // The cumulative counter would average the whole call, in which a collapse
    // three seconds ago is invisible — the same mistake the outbound half was
    // written to avoid, and the reason both now share one helper.
    const marks = new Map<string, { bytes: number; timestamp: number }>();
    const first = summariseStats(
      PEER,
      report([inbound()]),
      roles,
      marks,
      undefined,
      remoteRoles,
    );
    expect(first.receivers[0]!.kbps).toBeNull();

    const later = report([
      inbound({ timestamp: 2000, bytesReceived: 600_000 }),
    ]);
    const second = summariseStats(
      PEER,
      later,
      roles,
      marks,
      undefined,
      remoteRoles,
    );
    // 100 kB in one second is 800 kbit/s.
    expect(second.receivers[0]!.kbps).toBe(800);
  });

  it("keeps the two directions in separate byte marks", () => {
    // Both loops write into one map, and an inbound row whose key collided with
    // an outbound one would report somebody else's bitrate as your own. The
    // `in:` prefix is what keeps them apart, and a shared `id` between an
    // outbound-rtp and an inbound-rtp is entirely legal.
    const marks = new Map<string, { bytes: number; timestamp: number }>();
    // One id, two directions, two different rates: 25 kB/s out (200 kbit/s)
    // against 100 kB/s in (800 kbit/s). If the keys collided the second read
    // would report one of those numbers twice.
    const collide = (sent: number, received: number, timestamp: number) =>
      report([inbound({ id: "OT01", bytesReceived: received, timestamp })]).map(
        (stat) =>
          stat.type === "outbound-rtp"
            ? { ...stat, bytesSent: sent, timestamp }
            : stat,
      );
    summariseStats(
      PEER,
      collide(100_000, 500_000, 1000),
      roles,
      marks,
      undefined,
      remoteRoles,
    );
    const second = summariseStats(
      PEER,
      collide(125_000, 600_000, 2000),
      roles,
      marks,
      undefined,
      remoteRoles,
    );
    expect(second.senders[0]!.kbps).toBe(200);
    expect(second.receivers[0]!.kbps).toBe(800);
  });

  it("says unknown rather than guessing whose video it is", () => {
    // The classification comes off the roster and the track can beat it here.
    // Printing "their screen" for a stream nothing has classified yet is a
    // guess presented as a fact, in a readout whose whole job is to stop that.
    const { receivers } = summariseStats(
      PEER,
      report([inbound()]),
      roles,
      new Map(),
    );
    expect(receivers[0]!.role).toBe("unknown");
  });

  it("ignores inbound audio", () => {
    const audio: RtcStatLike = {
      id: "IA1",
      type: "inbound-rtp",
      kind: "audio",
      bytesReceived: 9_000,
    };
    const { receivers } = summariseStats(
      PEER,
      report([audio]),
      roles,
      new Map(),
      undefined,
      remoteRoles,
    );
    expect(receivers).toEqual([]);
  });
});

/**
 * The shape the browser actually hands over.
 *
 * Every test above feeds an array, and an array iterates as its elements. An
 * `RTCStatsReport` is maplike and iterates as `[id, stat]` pairs, so this
 * module used to see a list of two-element arrays with no `type` on any of
 * them and report an empty snapshot from inside a live call. A `Map` is the
 * closest standard stand-in: same `forEach` yielding values, same pair-yielding
 * iterator, and the bug reproduces exactly when `statRows` is bypassed.
 */
describe("statRows", () => {
  const asReport = () =>
    new Map(report().map((stat) => [stat.id as string, stat]));

  it("reads the values out of a maplike report rather than its entries", () => {
    const rows = statRows(asReport());
    expect(rows).toHaveLength(report().length);
    expect(rows.map((row) => row.type)).toContain("outbound-rtp");
  });

  it("still finds the sender once the report has been through it", () => {
    const { senders, paths } = summariseStats(
      PEER,
      statRows(asReport()),
      roles,
      new Map(),
    );
    expect(senders).toHaveLength(1);
    expect(senders[0]!.role).toBe("camera");
    expect(paths).toHaveLength(1);
  });

  it("finds nothing when the report is iterated directly, which was the bug", () => {
    const { senders } = summariseStats(
      PEER,
      asReport() as unknown as Iterable<RtcStatLike>,
      roles,
      new Map(),
    );
    expect(senders).toEqual([]);
  });
});

/**
 * Which of the two rate limits is talking.
 *
 * `qualityLimitationReason` says `bandwidth` for the app's own `maxBitrate`
 * just as loudly as it does for a starved uplink, and the readout used to pass
 * that straight through as "held back by your connection". The numbers below
 * are measured ones: a loopback call with roughly 3.4 Mbps of headroom and a
 * 1.5 Mbps ceiling targets about 1.5 Mbps, and the same sender with the link
 * held to 500 kbps targets about 404 kbps against the same ceiling.
 */
describe("describeLimitation", () => {
  const sample = (over: Partial<VideoSenderSample>): VideoSenderSample => ({
    peerId: PEER,
    role: "camera",
    width: 640,
    height: 360,
    fps: 30,
    kbps: 1_400,
    targetKbps: 1_500,
    ceilingKbps: 1_500,
    limitedBy: "bandwidth",
    limitDurations: null,
    encoder: "libvpx",
    framesEncoded: 100,
    framesSent: 100,
    keyFramesEncoded: 1,
    pliCount: 0,
    nackCount: 0,
    ...over,
  });

  it("blames the setting when the encoder is sitting on its own ceiling", () => {
    expect(describeLimitation(sample({}))).toBe("setting");
  });

  it("blames the connection when the target is far under the ceiling", () => {
    expect(
      describeLimitation(sample({ targetKbps: 404, ceilingKbps: 1_500 })),
    ).toBe("bandwidth");
  });

  it("says nothing at all when nothing is limiting the sender", () => {
    expect(describeLimitation(sample({ limitedBy: "none" }))).toBeNull();
    expect(describeLimitation(sample({ limitedBy: null }))).toBeNull();
  });

  it("keeps cpu and other as themselves", () => {
    expect(describeLimitation(sample({ limitedBy: "cpu" }))).toBe("cpu");
    expect(describeLimitation(sample({ limitedBy: "other" }))).toBe("other");
  });

  it("falls back to the raw reason when there is no ceiling to compare to", () => {
    expect(describeLimitation(sample({ ceilingKbps: null }))).toBe("bandwidth");
    expect(describeLimitation(sample({ targetKbps: null }))).toBe("bandwidth");
  });
});
