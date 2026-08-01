import { z } from "zod";

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

/**
 * Request for an SFU session. `peerId` is the id the WS voice room assigned in
 * its `welcome` message — reusing it as the SFU participant identity keeps
 * roster, speaking rings, and occupancy keyed consistently across both paths.
 */
export const voiceSessionRequestSchema = z.object({
  voiceChannelId: z.string().uuid(),
  peerId: z.string().uuid(),
});

export const voiceSessionSchema = z.object({
  backend: z.enum(["livekit"]),
  /** Media server websocket URL the client connects to. */
  url: z.string(),
  token: z.string(),
  /** SFU room name (the voice channel id). */
  room: z.string(),
  identity: z.string(),
});

export type VoiceSessionRequest = z.infer<typeof voiceSessionRequestSchema>;
export type VoiceSessionInfo = z.infer<typeof voiceSessionSchema>;
