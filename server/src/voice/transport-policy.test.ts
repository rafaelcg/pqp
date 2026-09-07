import { describe, expect, it } from "vitest";
import {
  guardMeshAcrossInstances,
  LARGE_SERVER_MEMBER_THRESHOLD,
  resolveVoiceTransport,
  type VoiceTransportPolicyInput,
} from "./transport-policy.js";

const server = (memberCount: number, isCommunity = false) => ({
  memberCount,
  isCommunity,
});

function decide(
  overrides: Partial<VoiceTransportPolicyInput> & {
    voiceTransport?: "mesh" | "livekit" | null;
  } = {},
) {
  const { voiceTransport = null, ...rest } = overrides;
  return resolveVoiceTransport({
    liveKitConfigured: true,
    channel: { kind: "server", voiceTransport },
    server: server(3),
    ...rest,
  });
}

describe("resolveVoiceTransport", () => {
  it("draws the line at ten members", () => {
    expect(LARGE_SERVER_MEMBER_THRESHOLD).toBe(10);
  });

  it("puts a DM or group call on mesh", () => {
    expect(
      decide({ channel: { kind: "dm", voiceTransport: null }, server: null }),
    ).toEqual({ transport: "mesh", reason: "dm" });
    expect(
      decide({ channel: { kind: "group", voiceTransport: null }, server: null }),
    ).toEqual({ transport: "mesh", reason: "dm" });
  });

  it("puts a server with nine members on mesh", () => {
    expect(decide({ server: server(9) })).toEqual({
      transport: "mesh",
      reason: "small",
    });
  });

  it("puts a server with ten members on the SFU", () => {
    expect(decide({ server: server(10) })).toEqual({
      transport: "livekit",
      reason: "large",
    });
  });

  it("puts a listed community with three members on the SFU", () => {
    expect(decide({ server: server(3, true) })).toEqual({
      transport: "livekit",
      reason: "community",
    });
  });

  it("puts a small server on the SFU when live HLS is on", () => {
    expect(decide({ server: server(2), liveHlsEnabled: true })).toEqual({
      transport: "livekit",
      reason: "hls",
    });
  });

  it("still honours an explicit mesh override when HLS is on", () => {
    expect(
      decide({
        server: server(2),
        liveHlsEnabled: true,
        voiceTransport: "mesh",
      }),
    ).toEqual({ transport: "mesh", reason: "override" });
  });

  it("does not move a DM to the SFU just because HLS is on", () => {
    expect(
      decide({
        channel: { kind: "dm", voiceTransport: null },
        server: null,
        liveHlsEnabled: true,
      }),
    ).toEqual({ transport: "mesh", reason: "dm" });
  });

  it("lets the channel override win both ways", () => {
    // A streamer's five-member server that wants the SFU anyway...
    expect(decide({ server: server(5), voiceTransport: "livekit" })).toEqual({
      transport: "livekit",
      reason: "override",
    });
    // ...and a large community that wants a free room for its inner circle.
    expect(
      decide({ server: server(500, true), voiceTransport: "mesh" }),
    ).toEqual({ transport: "mesh", reason: "override" });
  });

  it("stays mesh everywhere when LiveKit is not configured", () => {
    const unconfigured = { liveKitConfigured: false };
    expect(
      decide({ ...unconfigured, server: server(500, true) }).transport,
    ).toBe("mesh");
    expect(
      decide({ ...unconfigured, voiceTransport: "livekit" }).transport,
    ).toBe("mesh");
    expect(
      decide({ ...unconfigured, channel: { kind: "dm", voiceTransport: null } })
        .reason,
    ).toBe("unconfigured");
  });

  it("keeps the configured default for a server channel whose server is unreadable", () => {
    expect(decide({ server: null })).toEqual({
      transport: "livekit",
      reason: "default",
    });
  });
});

describe("guardMeshAcrossInstances (M5)", () => {
  it("keeps out of the way on one machine, SFU or not", () => {
    expect(
      guardMeshAcrossInstances({ liveKitConfigured: true, otherLiveInstances: 0 }),
    ).toEqual({ kind: "keep" });
    expect(
      guardMeshAcrossInstances({ liveKitConfigured: false, otherLiveInstances: 0 }),
    ).toEqual({ kind: "keep" });
  });

  it("sends the room to the SFU when a second machine is live", () => {
    expect(
      guardMeshAcrossInstances({ liveKitConfigured: true, otherLiveInstances: 1 }),
    ).toEqual({ kind: "force-livekit" });
  });

  it("refuses the join when a second machine is live and there is no SFU", () => {
    expect(
      guardMeshAcrossInstances({ liveKitConfigured: false, otherLiveInstances: 1 }),
    ).toEqual({ kind: "refuse", reason: "mesh-multi-instance" });
    expect(
      guardMeshAcrossInstances({ liveKitConfigured: false, otherLiveInstances: 3 }),
    ).toEqual({ kind: "refuse", reason: "mesh-multi-instance" });
  });
});
