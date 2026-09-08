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
 * Client -> server. "I am watching this channel's HLS stream without a seat
 * in its voice room" (`watching: true`) or "I stopped" (`false`). The server
 * checks VIEW on the channel, counts the socket and answers with a
 * `channel-live`. Sent by a viewer who opened a live watch-party channel and
 * did not press Entrar; a seat in the room never sends it (the room's own
 * roster already counts them).
 */
export const watchLiveMessageSchema = z.object({
  type: z.literal("watch-live"),
  channelId: z.string().uuid(),
  watching: z.boolean(),
});

export type WatchLiveMessage = z.infer<typeof watchLiveMessageSchema>;

/**
 * Server -> everyone who may view the channel, seat or no seat. This is the
 * channel-level path: `voice-stream` only reaches sockets inside the room,
 * so the sidebar pill and a viewer outside the room learned nothing. Sent
 * when the egress starts or stops (`stream` changes) and, while a stream is
 * live or someone is watching, on the audience keyframe cadence with the
 * current `watching` count. Never per viewer.
 *
 * `stream.hlsUrl` is stamped per recipient (a signed viewer token in the
 * query string, see `server/src/voice/hls-viewer-token.ts`), so this frame
 * is encoded per socket, not once per room.
 */
export const channelLiveMessageSchema = z.object({
  type: z.literal("channel-live"),
  channelId: z.string().uuid(),
  stream: liveHlsStreamSchema.nullable(),
  /** Watch-mode viewers without a seat. Room participants are on the roster. */
  watching: z.number().int().nonnegative(),
});

export type ChannelLiveMessage = z.infer<typeof channelLiveMessageSchema>;

/**
 * A playlist we can hand a player. `#EXT-X-ENDLIST` is the previous share:
 * LiveKit writes it when egress stops, and a reused `live.m3u8` stays that
 * finished VOD until the next share overwrites it. Playing that is a black
 * frame, not a live watch party.
 */
export function playlistLooksLive(body: string): boolean {
  return body.includes("#EXTINF") && !body.includes("#EXT-X-ENDLIST");
}
