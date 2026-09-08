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

/**
 * How many people may publish a camera in one call at the same time.
 *
 * MESH IS THREE AND IT IS PHYSICS. A mesh camera is another full-size video
 * uplink per peer, so the fourth camera in a six-person room asks each
 * publisher for roughly 7.5 Mbit/s of upload, which a home connection does not
 * have. That number is not ours to move, and the answer at it is the
 * promotion in `server/src/ws/voice.ts`: the room goes to the voice server and
 * the camera turns on.
 *
 * LIVEKIT IS `null`, MEANING "NOT A HEADCOUNT". It used to be eight, and eight
 * was ours rather than the box's: it matched the mesh room size because that
 * was a number lying around, not because a ninth camera costs anything a
 * publisher cannot pay. On the voice server a publisher uploads once whatever
 * the room size, so the only real ceilings are the box's egress, each viewer's
 * downlink and each viewer's decode, and none of those is a count of
 * publishers. The first is priced per room by `server/src/voice/promotion.ts`
 * and refused there. The second and third are the client's, and they are
 * answered by publishing a simulcast ladder
 * (`client/src/lib/video-quality.ts`) and by bounding how many tiles a grid
 * draws (`client/src/components/voice/stage-layout.ts`), not by telling the
 * ninth person their face is not welcome.
 *
 * `null` is deliberately not a very large number. A consumer has to say what
 * it does without a count, and every one of them has a different honest
 * answer: the server prices the box, and the client stops drawing a limit it
 * cannot state.
 */
export const CAMERA_LIMIT = {
  mesh: 3,
  livekit: null,
  // `satisfies` rather than an annotation, so `CAMERA_LIMIT.mesh` stays a
  // number for the callers that only ever mean mesh, while the exhaustiveness
  // over `VoiceRoomTransport` that an annotation buys is kept: a third
  // transport still has to answer this question.
} as const satisfies Record<VoiceRoomTransport, number | null>;

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
  /**
   * The resume HMAC `welcome` handed out for this peer id. Optional, and
   * older clients never send it: without it the server proves ownership
   * against its own peer map, which is exact on a single instance. With more
   * than one API instance the HTTP request may land on a machine that never
   * saw this peer, and the HMAC (which already binds user, peer and channel)
   * is the proof that works from anywhere.
   */
  resumeToken: z.string().min(1).optional(),
});

export const voiceSessionSchema = z.object({
  backend: z.enum(["livekit"]),
  /** Media server websocket URL the client connects to. */
  url: z.string(),
  token: z.string(),
  /** SFU room name (the voice channel id). */
  room: z.string(),
  identity: z.string(),
  /**
   * Whether the token allows a microphone publish (`Permission.SPEAK`).
   * Absent reads as true.
   */
  speak: z.boolean().optional(),
  /**
   * Whether the token allows camera or screen share (`Permission.STREAM`).
   * Absent reads as `speak`.
   */
  stream: z.boolean().optional(),
});

export type VoiceSessionRequest = z.infer<typeof voiceSessionRequestSchema>;
export type VoiceSessionInfo = z.infer<typeof voiceSessionSchema>;
