import { z } from "zod";
import type { VoiceRoomTransport } from "./signaling.js";

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

/**
 * How many people may share a screen in one call at the same time.
 *
 * Mesh encodes a copy per peer connection, so two is the ceiling that still
 * fits a small friend call. LiveKit forwards, so four matches Zoom's cap.
 * The server and the client both key this map off the room's stated transport.
 */
export const SCREEN_SHARE_LIMIT: Record<VoiceRoomTransport, number> = {
  mesh: 2,
  livekit: 4,
};

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
