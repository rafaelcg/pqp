import type { VoiceBackendType } from "@pqp/shared";

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

/** Phase 5: Cloudflare Realtime SFU session minting */
export async function createCloudflareSfuSession(
  _voiceChannelId: string,
  _userId: string,
): Promise<{ token: string }> {
  throw new Error(
    "Cloudflare Realtime SFU not implemented — use mesh backend (default)",
  );
}

/** Phase 5: LiveKit token for self-host */
export async function createLiveKitSession(
  _voiceChannelId: string,
  _userId: string,
): Promise<{ token: string }> {
  throw new Error("LiveKit not implemented — use mesh backend (default)");
}
