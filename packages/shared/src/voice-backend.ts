export type VoiceBackendType = "mesh" | "cloudflare-sfu" | "livekit";

export interface VoiceBackendConfig {
  type: VoiceBackendType;
  cloudflareAppId?: string;
  cloudflareAppSecret?: string;
  livekitUrl?: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
}

export const MESH_VOICE_LIMIT = 8;
export const MESH_VOICE_WARNING = 6;

export function getDefaultVoiceBackend(
  deployment: "hosted" | "selfhost",
): VoiceBackendType {
  return deployment === "hosted" ? "cloudflare-sfu" : "livekit";
}
