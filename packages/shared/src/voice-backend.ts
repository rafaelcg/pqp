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
 * How many people have to be in a mesh room before it moves to the media
 * server, whatever the room's size policy said when it opened.
 *
 * WHY THIS EXISTS AT ALL. Every cap a small call meets is a mesh cap:
 * `CAMERA_LIMIT.mesh` is 3 and `SCREEN_SHARE_LIMIT.mesh` is 2, both because a
 * mesh encodes one copy per peer, so the fourth camera in a six-person room
 * asks each publisher for about 7.5 Mbit/s of upload that a home connection in
 * Brazil does not have. The room moves to the SFU when somebody hits one of
 * those, which works but makes the caps something people meet, in the middle
 * of a call, as a refusal. Moving earlier means nobody meets them.
 *
 * WHY FOUR. Rafael's line: "a 2 or 3 person call is fine. 4 or 5 becomes a
 * proper thing. I want people to be able to share screen or use webcam." Four
 * is where a call stops being a chat and starts being an event, and it is also
 * exactly where the mesh arithmetic turns: three cameras is the mesh limit, so
 * a room of four is the first size at which somebody is told no.
 *
 * WHY NOT LOWER. Two and three person calls stay peer to peer on purpose.
 * Direct is one hop instead of two, so it is the lowest latency path we have;
 * it costs the media box nothing; and it keeps working if the box does not.
 * Most calls are this size, so this is also what keeps the box's load
 * proportional to the calls that actually need it.
 *
 * The server may override this with `VOICE_PROMOTION_ROOM_SIZE` (see
 * `promotionRoomSize` in `server/src/voice/promotion.ts`), which is a tuning
 * knob, not a second policy: `0` turns the trigger off. The constant is the
 * default and the number the client reasons about.
 */
export const MESH_ROOM_PROMOTION_SIZE = 4;

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
