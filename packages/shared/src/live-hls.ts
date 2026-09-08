import { z } from "zod";

/**
 * A LiveKit egress HLS playlist for a voice room's current screen share.
 *
 * Watchers play this instead of the WebRTC screen track. Glass-to-glass is
 * one playlist of 2 s segments, typically 8–12 s, not low-latency HLS.
 * Absent / null means there is no live transcode for this room.
 */
export const liveHlsStreamSchema = z.object({
  // Either a full public URL (LIVE_HLS_SIGNED_URLS=false, or the direct
  // bucket URL) or an API-relative path (the default: a viewer requests it
  // through the signed playlist proxy, `GET /api/voice/hls-playlist/...`,
  // and the client prefixes it with its own API base URL).
  hlsUrl: z.string().min(1),
  startedAt: z.number().int().nonnegative(),
  presenterPeerId: z.string().min(1),
  /** What the badge should claim, from the server that started the egress. */
  delaySeconds: z.number().int().positive().optional(),
});

export type LiveHlsStream = z.infer<typeof liveHlsStreamSchema>;

/**
 * Server → everyone in the room, including the presenter.
 *
 * Same shape as `watch-party`: sent after `welcome` so a joiner already
 * knows which room they are in, and again whenever egress starts or stops.
 * `stream: null` is a stop.
 */
export const voiceStreamMessageSchema = z.object({
  type: z.literal("voice-stream"),
  channelId: z.string().uuid(),
  stream: liveHlsStreamSchema.nullable(),
});

export type VoiceStreamMessage = z.infer<typeof voiceStreamMessageSchema>;

/**
 * A playlist we can hand a player. `#EXT-X-ENDLIST` is the previous share:
 * LiveKit writes it when egress stops, and a reused `live.m3u8` stays that
 * finished VOD until the next share overwrites it. Playing that is a black
 * frame, not a live watch party.
 */
export function playlistLooksLive(body: string): boolean {
  return body.includes("#EXTINF") && !body.includes("#EXT-X-ENDLIST");
}
