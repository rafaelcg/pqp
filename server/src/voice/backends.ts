import { AccessToken } from "livekit-server-sdk";
import type { VoiceBackendType, VoiceSessionInfo } from "@pqp/shared";

export interface VoiceBackendSession {
  type: VoiceBackendType;
  createSession(voiceChannelId: string, userId: string): Promise<{ token: string }>;
}

export function getServerVoiceBackend(): VoiceBackendType {
  if (process.env.LIVEKIT_URL) {
    return "livekit";
  }
  if (process.env.CLOUDFLARE_REALTIME_APP_ID) {
    return "cloudflare-sfu";
  }
  return "mesh";
}

export function isLiveKitConfigured(): boolean {
  return Boolean(
    process.env.LIVEKIT_URL &&
      process.env.LIVEKIT_API_KEY &&
      process.env.LIVEKIT_API_SECRET,
  );
}

/**
 * Token lifetime.
 *
 * A LiveKit token is a bearer credential for a room: LiveKit alone validates
 * it, and nothing we do to a user's account can retract one already handed out.
 * `voice/admin.ts` asks for revocation when it ejects somebody
 * (`revokeTokenTs`), but that field is **LiveKit Cloud only** — measured, not
 * assumed: an open-source livekit-server (v1.13.5, `--dev`) accepts the field,
 * returns 200, and then lets the removed participant straight back in with the
 * same token, even when the timestamp is an hour in the future. On a
 * self-hosted deployment this TTL is therefore not a backstop, it is the *only*
 * bound on how long a banned account can keep talking, which is why
 * `admin.ts` re-sweeps for exactly this long afterwards.
 *
 * Fifteen minutes, not one: the token only has to survive from mint to connect
 * (a fraction of a second — the client re-mints on every join, including after
 * a WS reconnect), but a *full* LiveKit reconnect mid-call falls back to the
 * last token the SFU refreshed over the signal channel, and that refresh cycle
 * is on the order of ten minutes. Below it, a network blip would end calls.
 */
export const TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Participant metadata: the app-level user id behind a LiveKit identity, and
 * when the token that carried it was issued.
 *
 * The identity is a per-join peer id, which says nothing about *who* is in the
 * room — so moderation could not target a user without it, and could not do so
 * at all for a participant connected via another instance, whose peer id this
 * process has never seen. Carrying the user id in the token makes the SFU room
 * self-describing and eviction correct cluster-wide.
 *
 * `mintedAt` (unix seconds) is what lets `admin.ts` re-sweep a room without
 * ever ejecting somebody who has since been let back in: a participant holding
 * a token issued *before* the eviction is still the person who was evicted,
 * while one holding a newer token passed the ban and channel-access checks at
 * mint time and belongs there. Without it a re-sweep could only say "this user
 * is present", which an unban within the token TTL would turn into a boot loop.
 *
 * This exposes nothing new: `VoiceParticipant.userId` is already broadcast to
 * everyone who can see the channel, and LiveKit metadata is visible to the same
 * set — the people in the room.
 */
export function participantMetadataFor(
  userId: string,
  mintedAt: number = Math.floor(Date.now() / 1000),
): string {
  return JSON.stringify({ userId, mintedAt });
}

function parseMetadata(metadata: string | undefined | null): unknown {
  if (!metadata) {
    return null;
  }
  try {
    return JSON.parse(metadata) as unknown;
  } catch {
    // Metadata set by something other than us (or truncated). Unresolvable is
    // a state the callers handle explicitly; a parse error is not exceptional.
    return null;
  }
}

/** Inverse of `participantMetadataFor`; null for absent or foreign metadata. */
export function userIdFromParticipantMetadata(
  metadata: string | undefined | null,
): string | null {
  const parsed = parseMetadata(metadata);
  if (typeof parsed === "object" && parsed !== null) {
    const userId = (parsed as { userId?: unknown }).userId;
    if (typeof userId === "string" && userId.length > 0) {
      return userId;
    }
  }
  return null;
}

/**
 * When the token behind this participant was minted, in unix seconds.
 *
 * Null for a token issued before this field existed — i.e. a session that
 * survived the deploy that added it. Callers must read null as "older than
 * anything I am comparing against", never as "recent".
 */
export function mintedAtFromParticipantMetadata(
  metadata: string | undefined | null,
): number | null {
  const parsed = parseMetadata(metadata);
  if (typeof parsed === "object" && parsed !== null) {
    const mintedAt = (parsed as { mintedAt?: unknown }).mintedAt;
    if (typeof mintedAt === "number" && Number.isFinite(mintedAt)) {
      return mintedAt;
    }
  }
  return null;
}

/**
 * Mint a LiveKit access token scoped to a single voice channel.
 *
 * `identity` is the WS-assigned peer id, so SFU participants line up 1:1 with
 * the mesh roster the UI already renders. Callers MUST verify that the peer id
 * belongs to the requesting user before calling this — `userId` is written into
 * the token as the authority moderation later evicts on, so a mismatch here
 * would let somebody wear another account's eviction target.
 */
export async function createLiveKitSession(
  voiceChannelId: string,
  peerId: string,
  displayName: string,
  userId: string,
): Promise<VoiceSessionInfo> {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!url || !apiKey || !apiSecret) {
    throw new Error(
      "LiveKit not configured — set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET",
    );
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity: peerId,
    name: displayName,
    metadata: participantMetadataFor(userId),
    ttl: TOKEN_TTL_SECONDS,
  });

  at.addGrant({
    room: voiceChannelId,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    // Covers mic and screen-share video alike; no data channel needed (chat
    // rides the app WS).
    canPublishData: false,
  });

  return {
    backend: "livekit",
    url,
    token: await at.toJwt(),
    room: voiceChannelId,
    identity: peerId,
  };
}

/** Phase 5: Cloudflare Realtime SFU session minting — still a stub. */
export async function createCloudflareSfuSession(
  _voiceChannelId: string,
  _userId: string,
): Promise<{ token: string }> {
  throw new Error(
    "Cloudflare Realtime SFU not implemented — use livekit or mesh backend",
  );
}
