import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLiveKitSession,
  isHlsLiveKitConfigured,
  isLiveKitConfigured,
  liveKitClusterForChannelType,
  liveKitCredsForHls,
  participantMetadataFor,
  userIdFromParticipantMetadata,
} from "./backends.js";
import { voiceConfigHash } from "./registry.js";

/**
 * These run against the real `AccessToken`, so what is asserted is the token a
 * deployment would actually hand out — not a stand-in for it.
 */
interface TokenClaims {
  sub: string;
  iss?: string;
  exp: number;
  nbf: number;
  metadata?: string;
  video?: {
    room?: string;
    roomJoin?: boolean;
    canPublish?: boolean;
    canPublishSources?: string[];
    canSubscribe?: boolean;
  };
}

function decodeClaims(jwt: string): TokenClaims {
  const payload = jwt.split(".")[1]!;
  return JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as TokenClaims;
}

describe("LiveKit token minting", () => {
  beforeEach(() => {
    process.env.LIVEKIT_URL = "wss://sfu.example.test";
    process.env.LIVEKIT_API_KEY = "key";
    process.env.LIVEKIT_API_SECRET = "secret";
  });

  afterEach(() => {
    delete process.env.LIVEKIT_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    delete process.env.LIVEKIT_HLS_URL;
    delete process.env.LIVEKIT_HLS_API_KEY;
    delete process.env.LIVEKIT_HLS_API_SECRET;
  });

  it("scopes the token to one room and one peer identity", async () => {
    const session = await createLiveKitSession(
      "voice-a",
      "peer-1",
      "Alice",
      "user-1",
    );

    expect(session.backend).toBe("livekit");
    expect(session.room).toBe("voice-a");
    expect(session.identity).toBe("peer-1");

    const claims = decodeClaims(session.token);
    expect(claims.sub).toBe("peer-1");
    expect(claims.video?.room).toBe("voice-a");
    expect(claims.video?.roomJoin).toBe(true);
  });

  /**
   * A minted token is a bearer credential LiveKit validates on its own, and
   * nothing about banning an account retracts one. `revokeTokenTs` is the real
   * fix (see voice/admin.ts) but only newer LiveKit servers honour it, so this
   * TTL is the ceiling on how long a stale token can be replayed elsewhere. It
   * was six hours; a ban must not be survivable for an afternoon.
   */
  /**
   * SPEAK on the SFU is the publish grant, nothing else: LiveKit refuses the
   * publish itself, so a client that ignores the UI is still silent. Subscribe
   * is never withdrawn; SPEAK takes away talking, not listening.
   */
  it("grants publish only to a member who may speak, and subscribe to everyone", async () => {
    const speaker = await createLiveKitSession("voice-a", "peer-1", "A", "u1", {
      canSpeak: true,
    });
    const listener = await createLiveKitSession("voice-a", "peer-2", "B", "u2", {
      canSpeak: false,
    });
    // No option at all: the pre-enforcement token, so nothing goes quiet on
    // deploy for a caller that has not resolved the bit.
    const legacy = await createLiveKitSession("voice-a", "peer-3", "C", "u3");

    expect(decodeClaims(speaker.token).video?.canPublish).toBe(true);
    expect(decodeClaims(listener.token).video?.canPublish).toBe(false);
    expect(decodeClaims(legacy.token).video?.canPublish).toBe(true);
    for (const session of [speaker, listener, legacy]) {
      expect(decodeClaims(session.token).video?.canSubscribe).toBe(true);
    }
    // Stated in the response too, so the client knows without a round trip.
    expect(speaker.speak).toBe(true);
    expect(speaker.stream).toBe(true);
    expect(listener.speak).toBe(false);
    expect(listener.stream).toBe(false);
    expect(legacy.speak).toBe(true);
    expect(legacy.stream).toBe(true);
  });

  it("lists microphone only when Stream is denied", async () => {
    const micOnly = await createLiveKitSession("voice-a", "peer-1", "A", "u1", {
      canSpeak: true,
      canStream: false,
    });
    const video = decodeClaims(micOnly.token).video;
    expect(video?.canPublish).toBe(true);
    expect(video?.canPublishSources).toEqual(["microphone"]);
    expect(micOnly.speak).toBe(true);
    expect(micOnly.stream).toBe(false);
  });

  it("lists camera and screen when Speak is denied", async () => {
    const videoOnly = await createLiveKitSession("voice-a", "peer-1", "A", "u1", {
      canSpeak: false,
      canStream: true,
    });
    const video = decodeClaims(videoOnly.token).video;
    expect(video?.canPublish).toBe(true);
    expect(video?.canPublishSources).toEqual([
      "camera",
      "screen_share",
      "screen_share_audio",
    ]);
    expect(videoOnly.speak).toBe(false);
    expect(videoOnly.stream).toBe(true);
  });

  it("keeps the token short-lived so a stale one cannot be replayed for long", async () => {
    const { token } = await createLiveKitSession(
      "voice-a",
      "peer-1",
      "Alice",
      "user-1",
    );

    const claims = decodeClaims(token);
    expect(claims.exp - claims.nbf).toBe(15 * 60);
  });

  /**
   * Without this the SFU room is anonymous: the identity is a per-join peer id,
   * so a ban could not be aimed at a participant whose peer id this instance
   * never issued — which, with LiveKit, is any participant on another instance.
   */
  it("carries the user id so moderation can identify a participant", async () => {
    const { token } = await createLiveKitSession(
      "voice-a",
      "peer-1",
      "Alice",
      "user-1",
    );

    expect(
      userIdFromParticipantMetadata(decodeClaims(token).metadata),
    ).toBe("user-1");
  });

  it("refuses to mint when LiveKit is not configured", async () => {
    delete process.env.LIVEKIT_API_SECRET;
    expect(isLiveKitConfigured()).toBe(false);

    await expect(
      createLiveKitSession("voice-a", "peer-1", "Alice", "user-1"),
    ).rejects.toThrow(/not configured/i);
  });

  it("hands LIVEKIT_HLS_URL to a watch-party token when the HLS cluster is set", async () => {
    process.env.LIVEKIT_HLS_URL = "wss://hls.example.test";
    process.env.LIVEKIT_HLS_API_KEY = "hls-key";
    process.env.LIVEKIT_HLS_API_SECRET = "hls-secret";

    expect(isHlsLiveKitConfigured()).toBe(true);
    expect(liveKitClusterForChannelType("watch_party")).toBe("hls");
    expect(liveKitClusterForChannelType("voice")).toBe("voice");
    expect(liveKitCredsForHls()?.url).toBe("wss://hls.example.test");

    const party = await createLiveKitSession(
      "party-a",
      "peer-1",
      "Alice",
      "user-1",
      { cluster: "hls" },
    );
    const voice = await createLiveKitSession(
      "voice-a",
      "peer-2",
      "Bob",
      "user-2",
    );

    expect(party.url).toBe("wss://hls.example.test");
    expect(voice.url).toBe("wss://sfu.example.test");
    expect(decodeClaims(party.token).iss).toBe("hls-key");
    expect(decodeClaims(voice.token).iss).toBe("key");
  });

  it("keeps watch-party tokens on LIVEKIT_URL when the HLS cluster is unset", async () => {
    expect(isHlsLiveKitConfigured()).toBe(false);
    expect(liveKitClusterForChannelType("watch_party")).toBe("voice");
    expect(liveKitCredsForHls()?.url).toBe("wss://sfu.example.test");

    const party = await createLiveKitSession(
      "party-a",
      "peer-1",
      "Alice",
      "user-1",
      { cluster: "hls" },
    );
    expect(party.url).toBe("wss://sfu.example.test");
  });
});

describe("voiceConfigHash with an HLS cluster", () => {
  afterEach(() => {
    delete process.env.LIVEKIT_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_HLS_URL;
    delete process.env.LIVEKIT_HLS_API_KEY;
  });

  it("is unchanged when LIVEKIT_HLS_* is unset, so a rolling deploy is not drift", () => {
    process.env.LIVEKIT_URL = "wss://sfu.example.test";
    process.env.LIVEKIT_API_KEY = "key";
    const without = voiceConfigHash();
    process.env.LIVEKIT_HLS_URL = "";
    process.env.LIVEKIT_HLS_API_KEY = "";
    expect(voiceConfigHash()).toBe(without);
  });

  it("changes when the HLS URL is set, because watch parties pin to a different box", () => {
    process.env.LIVEKIT_URL = "wss://sfu.example.test";
    process.env.LIVEKIT_API_KEY = "key";
    const voiceOnly = voiceConfigHash();
    process.env.LIVEKIT_HLS_URL = "wss://hls.example.test";
    process.env.LIVEKIT_HLS_API_KEY = "hls-key";
    expect(voiceConfigHash()).not.toBe(voiceOnly);
  });
});

describe("participant metadata", () => {
  it("round-trips a user id", () => {
    expect(userIdFromParticipantMetadata(participantMetadataFor("u1"))).toBe(
      "u1",
    );
  });

  it("reports unresolvable rather than throwing on foreign metadata", () => {
    // Anything not written by us is a participant we cannot identify, and the
    // callers each decide whether that fails open or closed.
    for (const value of [
      undefined,
      null,
      "",
      "not json",
      "{}",
      '{"userId":123}',
      '{"userId":""}',
      "[]",
    ]) {
      expect(userIdFromParticipantMetadata(value)).toBeNull();
    }
  });
});
