import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLiveKitSession,
  isLiveKitConfigured,
  participantMetadataFor,
  userIdFromParticipantMetadata,
} from "./backends.js";

/**
 * These run against the real `AccessToken`, so what is asserted is the token a
 * deployment would actually hand out — not a stand-in for it.
 */
interface TokenClaims {
  sub: string;
  exp: number;
  nbf: number;
  metadata?: string;
  video?: { room?: string; roomJoin?: boolean };
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
