import { z } from "zod";

/**
 * A music queue for a voice room, as one synchronised state object.
 *
 * NO AUDIO PASSES THROUGH OUR INFRASTRUCTURE. Every participant plays the
 * track from YouTube through the IFrame Player API on their own machine, the
 * way Discord's Watch Together and Spotify's Jam work. What travels is this
 * object: the queue, what is playing, where it is, and who moved it last.
 *
 * This is the shape `watch-party.ts` already carries for a synchronised video,
 * plus a queue. The ordering rule, the position sampling rule and the reason
 * for a rate limiter that coalesces rather than drops are all the same, and
 * documented there. Read that file first.
 *
 * WHY NOT A BOT ACCOUNT IN THE CALL. A server-side participant that streams
 * audio into the room only works where the server is in the media path, which
 * is a LiveKit room, and never a mesh room: every DM call and every server
 * under ten people. Restreaming YouTube from our own machines is also the
 * thing that got Groovy and Rythm shut down in 2021. Syncing the clients
 * reaches every transport, costs nothing per listener, and stays inside the
 * platform's embed terms.
 */

export const MUSIC_QUEUE_LIMIT = 50;

export const musicTrackSchema = z.object({
  /** Client-minted, unique within the queue. */
  id: z.string().min(1).max(64),
  provider: z.literal("youtube"),
  videoId: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  /** Who the track was resolved from, for the "abrir no Spotify" affordance. */
  sourceUrl: z.string().url().max(2048).nullable(),
  thumbnailUrl: z.string().url().max(2048).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  addedByUserId: z.string().min(1).max(128),
  addedByName: z.string().min(1).max(100),
});

export type MusicTrack = z.infer<typeof musicTrackSchema>;

export const musicStateSchema = z.object({
  /** What is playing. Null with a non-empty queue is a transient the next write fixes. */
  current: musicTrackSchema.nullable(),
  queue: z.array(musicTrackSchema).max(MUSIC_QUEUE_LIMIT),
  status: z.enum(["playing", "paused"]),
  /** Playback position sampled at `atMs`. See `watchPartyStateSchema.atMs`. */
  positionMs: z.number().int().nonnegative(),
  atMs: z.number().int().nonnegative(),
  /** Logical clock. Higher wins; ties break on `actorId`. */
  rev: z.number().int().nonnegative(),
  actorId: z.string().min(1).max(128),
});

export type MusicState = z.infer<typeof musicStateSchema>;

export const setMusicMessageSchema = z.object({
  type: z.literal("set-music"),
  state: musicStateSchema.nullable(),
});

export type SetMusicMessage = z.infer<typeof setMusicMessageSchema>;

export const musicMessageSchema = z.object({
  type: z.literal("music"),
  channelId: z.string().uuid(),
  state: musicStateSchema.nullable(),
});

export type MusicMessage = z.infer<typeof musicMessageSchema>;

/**
 * Server to everyone who may view the channel, in or out of the call: what
 * the room is playing, so the sidebar can say so. Sent when the current
 * track changes and on connect for every room with music. Same audience
 * rule as `channel-live`; no position, no queue, nothing to sync.
 */
export const channelMusicTrackSchema = z.object({
  videoId: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  thumbnailUrl: z.string().url().max(2048).nullable(),
});

export type ChannelMusicTrack = z.infer<typeof channelMusicTrackSchema>;

export const channelMusicMessageSchema = z.object({
  type: z.literal("channel-music"),
  channelId: z.string().uuid(),
  track: channelMusicTrackSchema.nullable(),
});

export type ChannelMusicMessage = z.infer<typeof channelMusicMessageSchema>;

/** `GET /api/music/resolve?q=` answers with one of these. */
export const musicResolvedSchema = z.object({
  provider: z.literal("youtube"),
  videoId: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  sourceUrl: z.string().url().max(2048).nullable(),
  thumbnailUrl: z.string().url().max(2048).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
});

export type MusicResolved = z.infer<typeof musicResolvedSchema>;

/**
 * The same total order `watch-party.ts` uses. True when `incoming` loses to
 * `held`, so every peer picks the same winner without talking to anyone.
 */
export function musicWriteIsStale(
  held: MusicState | null,
  incoming: MusicState | null,
): boolean {
  if (held === null || incoming === null) {
    return false;
  }
  if (incoming.rev !== held.rev) {
    return incoming.rev < held.rev;
  }
  return incoming.actorId < held.actorId;
}

/**
 * Whether two states differ in anything but position. Position-only writes
 * are what the server may coalesce under load; these it never drops.
 */
export function musicWriteIsStructural(
  held: MusicState | null,
  incoming: MusicState | null,
): boolean {
  if (held === null || incoming === null) {
    return held !== incoming;
  }
  if (held.status !== incoming.status) {
    return true;
  }
  if ((held.current?.id ?? null) !== (incoming.current?.id ?? null)) {
    return true;
  }
  if (held.queue.length !== incoming.queue.length) {
    return true;
  }
  return held.queue.some((track, index) => track.id !== incoming.queue[index]?.id);
}

// ------------------------------------------------------------- link parsing

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

export type MusicLink =
  | { kind: "youtube"; videoId: string; url: string }
  | { kind: "spotify"; url: string; entity: "track" | "other" }
  | { kind: "search"; query: string };

/**
 * What a person pasted. A YouTube link carries its id; a Spotify link is
 * resolved server side (the page's title and artist, then a YouTube search);
 * anything else is a search.
 */
export function parseMusicInput(raw: string): MusicLink | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }
  let url: URL | null = null;
  try {
    url = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    url = null;
  }
  if (url && YOUTUBE_HOSTS.has(url.hostname)) {
    let id: string | null = null;
    if (url.hostname.endsWith("youtu.be")) {
      id = url.pathname.slice(1).split("/")[0] ?? null;
    } else if (url.pathname === "/watch") {
      id = url.searchParams.get("v");
    } else {
      const match = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?]+)/);
      id = match?.[1] ?? null;
    }
    if (id && YOUTUBE_ID.test(id)) {
      return {
        kind: "youtube",
        videoId: id,
        url: `https://www.youtube.com/watch?v=${id}`,
      };
    }
    return null;
  }
  if (url && (url.hostname === "open.spotify.com" || url.hostname === "spotify.link")) {
    const entity = /^\/(?:intl-[a-z]+\/)?track\//.test(url.pathname) ? "track" : "other";
    return { kind: "spotify", url: url.toString(), entity };
  }
  if (url && text.includes("://")) {
    // Some other site: not something we can play.
    return null;
  }
  return { kind: "search", query: text.slice(0, 200) };
}

/** Sort key for "you are third in the queue" style affordances. */
export function musicQueuePosition(state: MusicState, trackId: string): number {
  return state.queue.findIndex((track) => track.id === trackId);
}
