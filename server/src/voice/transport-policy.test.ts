import { describe, expect, it } from "vitest";
import {
  LARGE_SERVER_MEMBER_THRESHOLD,
  liveHlsForcesSfu,
  resolveVoiceTransport,
  type VoiceTransportPolicyInput,
} from "./transport-policy.js";

const server = (memberCount: number, isCommunity = false) => ({
  memberCount,
  isCommunity,
});

/**
 * The default channel is an ORDINARY voice channel, so every case below that
 * does not say `watch_party` is asserting what an everyday room gets. That is
 * the whole point of the HLS cases: `liveHlsEnabled` on its own must change
 * nothing here.
 */
function decide(
  overrides: Partial<VoiceTransportPolicyInput> & {
    voiceTransport?: "mesh" | "livekit" | null;
  } = {},
) {
  const { voiceTransport = null, ...rest } = overrides;
  return resolveVoiceTransport({
    liveKitConfigured: true,
    channel: { kind: "server", type: "voice", voiceTransport },
    server: server(3),
    ...rest,
  });
}

/** A `watch_party` channel: the one room an egress can ever attach to. */
const party = (voiceTransport: "mesh" | "livekit" | null = null) => ({
  kind: "server" as const,
  type: "watch_party",
  voiceTransport,
});

describe("resolveVoiceTransport", () => {
  it("draws the line at ten members", () => {
    expect(LARGE_SERVER_MEMBER_THRESHOLD).toBe(10);
  });

  it("puts a DM or group call on mesh", () => {
    expect(
      decide({ channel: { kind: "dm", type: "voice", voiceTransport: null }, server: null }),
    ).toEqual({ transport: "mesh", reason: "dm" });
    expect(
      decide({ channel: { kind: "group", type: "voice", voiceTransport: null }, server: null }),
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

  it("puts a watch party in a small server on the SFU when live HLS is on", () => {
    expect(
      decide({ channel: party(), server: server(2), liveHlsEnabled: true }),
    ).toEqual({ transport: "livekit", reason: "hls" });
  });

  /**
   * THE NARROWING. `LIVE_HLS_ENABLED` used to answer `livekit` for every
   * server voice channel, which moved every peer-to-peer call in the server
   * onto the media box the moment the flag went on. Only a `watch_party`
   * channel can host an egress, so only a `watch_party` channel is promoted.
   *
   * Both halves are asserted because reverting the narrowing breaks them in
   * two different ways: the transport goes to `livekit`, and the reason it
   * comes back with is `hls` rather than the size rule that should have
   * decided it.
   */
  it("leaves an ordinary voice channel to the size rules when live HLS is on", () => {
    expect(decide({ server: server(2), liveHlsEnabled: true })).toEqual({
      transport: "mesh",
      reason: "small",
    });
    expect(decide({ server: server(50), liveHlsEnabled: true })).toEqual({
      transport: "livekit",
      reason: "large",
    });
    expect(decide({ server: server(3, true), liveHlsEnabled: true })).toEqual({
      transport: "livekit",
      reason: "community",
    });
  });

  it("does not promote a text or category channel when live HLS is on", () => {
    for (const type of ["text", "category", "thread"]) {
      expect(
        decide({
          channel: { kind: "server", type, voiceTransport: null },
          server: server(2),
          liveHlsEnabled: true,
        }),
        type,
      ).toEqual({ transport: "mesh", reason: "small" });
    }
  });

  it("promotes nothing at all while live HLS is off", () => {
    expect(decide({ channel: party(), server: server(2) })).toEqual({
      transport: "mesh",
      reason: "small",
    });
  });

  it("still honours an explicit mesh override when HLS is on", () => {
    expect(
      decide({
        channel: party("mesh"),
        server: server(2),
        liveHlsEnabled: true,
      }),
    ).toEqual({ transport: "mesh", reason: "override" });
  });

  it("does not move a DM to the SFU just because HLS is on", () => {
    expect(
      decide({
        channel: { kind: "dm", type: "voice", voiceTransport: null },
        server: null,
        liveHlsEnabled: true,
      }),
    ).toEqual({ transport: "mesh", reason: "dm" });
  });

  it("stays mesh in a watch party when LiveKit is not configured", () => {
    expect(
      decide({
        liveKitConfigured: false,
        channel: party(),
        server: server(2),
        liveHlsEnabled: true,
      }),
    ).toEqual({ transport: "mesh", reason: "unconfigured" });
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
      decide({ ...unconfigured, channel: { kind: "dm", type: "voice", voiceTransport: null } })
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

/**
 * `ws/voice.ts` reads this to decide whether it may skip the member-count
 * query, and the policy reads it to decide the transport. If the two ever
 * disagree, an ordinary voice channel gets no server profile and comes back
 * `livekit` / `default`, which is the wide behaviour wearing a new reason.
 */
describe("liveHlsForcesSfu", () => {
  it("is true only for a watch party with the flag on", () => {
    expect(
      liveHlsForcesSfu({ liveHlsEnabled: true, channelType: "watch_party" }),
    ).toBe(true);
    expect(
      liveHlsForcesSfu({ liveHlsEnabled: true, channelType: "voice" }),
    ).toBe(false);
    expect(
      liveHlsForcesSfu({ liveHlsEnabled: false, channelType: "watch_party" }),
    ).toBe(false);
    expect(liveHlsForcesSfu({ channelType: "watch_party" })).toBe(false);
  });
});
