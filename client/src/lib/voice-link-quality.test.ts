import { describe, expect, it } from "vitest";
import {
  aggregateQuality,
  qualityByPeerFromSnapshot,
  qualityFromLiveKit,
  qualityFromMesh,
  type VoiceLinkQuality,
} from "./voice-link-quality";
import type { VoiceStatsSnapshot } from "./voice-stats-probe";

function mesh(
  over: Partial<Parameters<typeof qualityFromMesh>[0]> = {},
): VoiceLinkQuality {
  return qualityFromMesh({
    rttMs: 40,
    packetsLost: 0,
    packetsReceived: 200,
    relayed: false,
    ...over,
  });
}

describe("qualityFromMesh", () => {
  it("lights three bars on a short RTT and no loss", () => {
    expect(mesh()).toEqual({
      bars: 3,
      relayed: false,
      rttMs: 40,
      lossPct: 0,
    });
  });

  it("drops to two bars when RTT is only okay", () => {
    expect(mesh({ rttMs: 200 }).bars).toBe(2);
  });

  it("drops to one bar when RTT is long", () => {
    expect(mesh({ rttMs: 400 }).bars).toBe(1);
  });

  it("drops to two bars when loss is noticeable", () => {
    expect(mesh({ packetsLost: 5, packetsReceived: 95 }).bars).toBe(2);
    expect(mesh({ packetsLost: 5, packetsReceived: 95 }).lossPct).toBe(5);
  });

  it("drops to one bar when loss is high", () => {
    expect(mesh({ packetsLost: 20, packetsReceived: 80 }).bars).toBe(1);
  });

  it("takes the worse of RTT and loss", () => {
    expect(mesh({ rttMs: 40, packetsLost: 20, packetsReceived: 80 }).bars).toBe(
      1,
    );
    expect(mesh({ rttMs: 400, packetsLost: 0, packetsReceived: 200 }).bars).toBe(
      1,
    );
  });

  it("keeps three bars on a healthy relayed path and flags Relayed", () => {
    const quality = mesh({ relayed: true });
    expect(quality.bars).toBe(3);
    expect(quality.relayed).toBe(true);
  });

  it("does not invent a reading when the sample is still empty", () => {
    expect(
      qualityFromMesh({
        rttMs: null,
        packetsLost: null,
        packetsReceived: null,
        relayed: false,
      }),
    ).toEqual({
      bars: 3,
      relayed: false,
      rttMs: null,
      lossPct: null,
    });
  });

  it("accepts a ready-made loss percent", () => {
    expect(mesh({ lossPct: 10, packetsLost: undefined }).bars).toBe(1);
    expect(mesh({ lossPct: 10, packetsLost: undefined }).lossPct).toBe(10);
  });
});

describe("qualityFromLiveKit", () => {
  it("maps Excellent / Good / Poor onto the same three bars", () => {
    expect(qualityFromLiveKit("excellent").bars).toBe(3);
    expect(qualityFromLiveKit("good").bars).toBe(2);
    expect(qualityFromLiveKit("poor").bars).toBe(1);
  });

  it("treats lost as the bottom bar and unknown as no reading yet", () => {
    expect(qualityFromLiveKit("lost").bars).toBe(1);
    expect(qualityFromLiveKit("unknown").bars).toBe(3);
  });

  it("can still carry a Relayed flag from the local ICE pair", () => {
    expect(qualityFromLiveKit("good", { relayed: true })).toEqual({
      bars: 2,
      relayed: true,
      rttMs: null,
      lossPct: null,
    });
  });
});

describe("qualityByPeerFromSnapshot", () => {
  const empty: VoiceStatsSnapshot = { senders: [], receivers: [], paths: [] };

  it("builds one row per path, keyed by peer", () => {
    const byPeer = qualityByPeerFromSnapshot({
      ...empty,
      paths: [
        {
          peerId: "alice",
          localType: "srflx",
          remoteType: "srflx",
          relayed: false,
          rttMs: 40,
          availableOutgoingKbps: 900,
          localAddress: "1.2.3.4",
          remoteAddress: "5.6.7.8",
          packetsLost: 0,
          packetsReceived: 200,
        },
        {
          peerId: "bob",
          localType: "relay",
          remoteType: "srflx",
          relayed: true,
          rttMs: 220,
          availableOutgoingKbps: 200,
          localAddress: "1.2.3.4",
          remoteAddress: "9.9.9.9",
          packetsLost: 12,
          packetsReceived: 88,
        },
      ],
    });
    expect(byPeer.alice).toEqual({
      bars: 3,
      relayed: false,
      rttMs: 40,
      lossPct: 0,
    });
    expect(byPeer.bob?.bars).toBe(1);
    expect(byPeer.bob?.relayed).toBe(true);
  });

  it("keeps the worse path when the same peer has two", () => {
    const byPeer = qualityByPeerFromSnapshot({
      ...empty,
      paths: [
        {
          peerId: "alice",
          localType: "host",
          remoteType: "host",
          relayed: false,
          rttMs: 20,
          availableOutgoingKbps: null,
          localAddress: null,
          remoteAddress: null,
          packetsLost: 0,
          packetsReceived: 100,
        },
        {
          peerId: "alice",
          localType: "relay",
          remoteType: "srflx",
          relayed: true,
          rttMs: 350,
          availableOutgoingKbps: null,
          localAddress: null,
          remoteAddress: null,
          packetsLost: 0,
          packetsReceived: 100,
        },
      ],
    });
    expect(byPeer.alice).toEqual({
      bars: 1,
      relayed: true,
      rttMs: 350,
      lossPct: 0,
    });
  });
});

describe("aggregateQuality", () => {
  it("returns null when nobody else is on the call", () => {
    expect(aggregateQuality([])).toBeNull();
  });

  it("takes the worst bars and any Relayed flag", () => {
    const aggregate = aggregateQuality([
      mesh(),
      mesh({ rttMs: 200, relayed: true }),
    ]);
    expect(aggregate?.bars).toBe(2);
    expect(aggregate?.relayed).toBe(true);
  });
});
