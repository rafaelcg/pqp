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
 * `voice/admin.ts` revokes tokens explicitly when it ejects somebody
 * (`revokeTokenTs`), but that field is only honoured by recent LiveKit servers,
 * so this TTL is the backstop that bounds how long a stale token can be
 * replayed on a deployment that ignores it. It used to be six hours, which made
 * "banned" mean "banned from rejoining, some time this afternoon".
 *
 * Fifteen minutes, not one: the token only has to survive from mint to connect
 * (a fraction of a second — the client re-mints on every join, including after
 * a WS reconnect), but a *full* LiveKit reconnect mid-call falls back to the
 * last token the SFU refreshed over the signal channel, and that refresh cycle
 * is on the order of ten minutes. Below it, a network blip would end calls.
 */
const TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Participant metadata: the app-level user id behind a LiveKit identity.
 *
 * The identity is a per-join peer id, which says nothing about *who* is in the
 * room — so moderation could not target a user without it, and could not do so
 * at all for a participant connected via another instance, whose peer id this
 * process has never seen. Carrying the user id in the token makes the SFU room
 * self-describing and eviction correct cluster-wide.
 *
 * This exposes nothing new: `VoiceParticipant.userId` is already broadcast to
 * everyone who can see the channel, and LiveKit metadata is visible to the same
 * set — the people in the room.
 */
export function participantMetadataFor(userId: string): string {
  return JSON.stringify({ userId });
}

/** Inverse of `participantMetadataFor`; null for absent or foreign metadata. */
export function userIdFromParticipantMetadata(
  metadata: string | undefined | null,
): string | null {
  if (!metadata) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (typeof parsed === "object" && parsed !== null) {
      const userId = (parsed as { userId?: unknown }).userId;
      if (typeof userId === "string" && userId.length > 0) {
        return userId;
      }
    }
  } catch {
    // Metadata set by something other than us (or truncated). Unresolvable is
    // a state the callers handle explicitly; a parse error is not exceptional.
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
