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

/** Token lifetime — long enough for a call, short enough to limit replay. */
const TOKEN_TTL_SECONDS = 6 * 60 * 60;

/**
 * Mint a LiveKit access token scoped to a single voice channel.
 *
 * `identity` is the WS-assigned peer id, so SFU participants line up 1:1 with
 * the mesh roster the UI already renders. Callers MUST verify that the peer id
 * belongs to the requesting user before calling this.
 */
export async function createLiveKitSession(
  voiceChannelId: string,
  peerId: string,
  displayName: string,
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
    ttl: TOKEN_TTL_SECONDS,
  });

  at.addGrant({
    room: voiceChannelId,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    // Audio-only today; no data channel needed (chat rides the app WS).
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
