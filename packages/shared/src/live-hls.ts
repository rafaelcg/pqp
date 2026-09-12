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
  /**
   * The tallest rendition this session ACTUALLY started, in lines. The
   * presenter's client reads it to decide whether to publish past the
   * large-room 720p cap: the egress transcodes from the published track, so
   * a 720p source cannot produce a 1080p rendition. Post-budget on purpose
   * (a rung refused for load is not in it), and absent on a server that
   * predates the ladder, where the client leaves the cap alone.
   */
  topHeight: z.number().int().positive().optional(),
  /**
   * Highest framerate a started rung actually encodes. The presenter
   * captures and publishes at 60 only when this is 60; a 30 fps source
   * fed to a 60 fps rung is duplicated frames, not smoothness.
   */
  topFramerate: z.number().int().positive().optional(),
  /**
   * Whether this transcode has any audio at all.
   *
   * A Track Composite egress carries exactly two tracks: the screen share and
   * the screen share's OWN audio. A share picked without its audio (every
   * whole-screen and window capture on macOS, and any tab share where the host
   * left the audio box unticked) publishes no `SCREEN_SHARE_AUDIO` track, so
   * the egress has nothing to put in the audio channel and the HLS audience
   * gets a silent film. The host cannot hear that, because they are playing
   * the thing locally, and the seated room cannot either, because WebRTC is a
   * different path and carries every microphone.
   *
   * So the server states it and the host's transmission panel says it out
   * loud. Boolean rather than an enum on purpose: a future mixed-audio egress
   * makes this `true` and describes itself in a second field, where a new enum
   * member would fail an older client's parse and take the whole frame with
   * it.
   *
   * Absent means "not stated": a server that predates this, or a session this
   * process adopted after a restart rather than started (the session row does
   * not carry the audio track sid, only the video one). The client shows
   * nothing rather than guessing, because a wrong "no audio" warning during a
   * film that is playing fine is worse than no warning.
   */
  hasAudio: z.boolean().optional(),
  /**
   * A SECOND playlist, carrying the presenter's camera and nothing else.
   *
   * The HLS audience is seatless — they never join the LiveKit room — so a
   * camera published into the room reaches the seated participants over WebRTC
   * and reaches nobody watching the playlist. And a Track Composite egress
   * carries one video and one audio track, singular fields in the protocol, so
   * the running transcode cannot be asked to also carry a face. The answer is
   * a second, video-only 360p30 egress beside the ladder, writing under the
   * SAME session prefix (`<startedAt>-cam360p30`).
   *
   * SAME SESSION, DELIBERATELY. The camera starts and stops inside the running
   * session and never mints a new `startedAt`: a new one is a new playlist
   * path, a new token and a new master, which re-attaches and rebuffers every
   * viewer. Turning a webcam on must not do that to five hundred people.
   *
   * Stamped with the same `?t=` viewer token as `hlsUrl`. Absent means there
   * is no camera in this broadcast right now: the presenter has none on, the
   * media box refused it for budget, or the server predates this. **Optional
   * on purpose** — iOS and Android parse the frame and ignore the field.
   *
   * There is no audio here and there never will be: the audience's sound comes
   * off the main stream, which is the only place it is mixed.
   */
  cameraHlsUrl: z.string().min(1).optional(),
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
 *
 * TWO SHAPES, and missing the second one is a silent, total failure. A media
 * playlist proves itself with `#EXTINF`. A MASTER playlist has no `#EXTINF`
 * at all, by definition: it is a list of `#EXT-X-STREAM-INF` variants and
 * nothing else. Testing only for `#EXTINF` therefore says "not live" about
 * every ladder stream forever, and the caller
 * (`client/src/hooks/use-live-hls-src.ts`) answers that by keeping WebRTC and
 * re-polling once a second, which looks exactly like a slow egress and never
 * stops. Caught on the local stack, not by a unit test, which is why there is
 * now a test that runs a real generated master through this function.
 *
 * A master is enough on its own: the server does not hand a viewer the
 * session URL until the lowest rung's live playlist has actually appeared
 * (`waitForLivePlaylist` in `hls-egress.ts`), so a master that parses means a
 * rung behind it is already writing segments.
 */
export function playlistLooksLive(body: string): boolean {
  if (body.includes("#EXT-X-ENDLIST")) {
    return false;
  }
  return body.includes("#EXTINF") || body.includes("#EXT-X-STREAM-INF");
}
