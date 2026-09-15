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

export const MUSIC_HISTORY_LIMIT = 10;

export const musicRepeatSchema = z.enum(["off", "one", "all"]);
export type MusicRepeat = z.infer<typeof musicRepeatSchema>;

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
  /**
   * While true, anyone with SPEAK is treated as a manager. Only a manager
   * writes this. Defaulted so a frame from an older client still parses.
   */
  openControls: z.boolean().default(false),
  repeat: musicRepeatSchema.default("off"),
  /** User ids that have voted to skip the current track. */
  skipVotes: z.array(z.string().min(1).max(128)).max(64).default([]),
  /** Most recent first. */
  history: z.array(musicTrackSchema).max(MUSIC_HISTORY_LIMIT).default([]),
});

export type MusicState = z.infer<typeof musicStateSchema>;

/**
 * A `set-music` write. The new fields are optional so a frame from an
 * older client still parses, and omitted keys stay omitted (`.default`
 * would fill them and wipe the room's votes, history and switches on
 * the next position sample).
 */
export const musicStateWriteSchema = musicStateSchema.extend({
  openControls: z.boolean().optional(),
  repeat: musicRepeatSchema.optional(),
  skipVotes: z.array(z.string().min(1).max(128)).max(64).optional(),
  history: z.array(musicTrackSchema).max(MUSIC_HISTORY_LIMIT).optional(),
});

export type MusicStateWrite = z.infer<typeof musicStateWriteSchema>;

/** Fill fields an older writer omitted from what the room already holds. */
export function completeMusicState(
  held: MusicState | null,
  incoming: MusicStateWrite,
): MusicState {
  return {
    ...incoming,
    openControls: incoming.openControls ?? held?.openControls ?? false,
    repeat: incoming.repeat ?? held?.repeat ?? "off",
    skipVotes: incoming.skipVotes ?? held?.skipVotes ?? [],
    history: incoming.history ?? held?.history ?? [],
  };
}

export const setMusicMessageSchema = z.object({
  type: z.literal("set-music"),
  state: musicStateWriteSchema.nullable(),
});

export type SetMusicMessage = z.infer<typeof setMusicMessageSchema>;

export const musicMessageSchema = z.object({
  type: z.literal("music"),
  channelId: z.string().uuid(),
  state: musicStateSchema.nullable(),
  /**
   * The server is handing back what it holds because the sender's write
   * was refused (no MANAGE_MUSIC for what it changed). The client adopts
   * it whatever its own `rev` says, since its optimistic copy is ahead by
   * construction and would otherwise call the correction stale.
   */
  forced: z.boolean().optional(),
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
  /** Seated peers whose player is on. Absent on an older server. */
  listeners: z.number().int().nonnegative().optional(),
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
  if (held.queue.some((track, index) => track.id !== incoming.queue[index]?.id)) {
    return true;
  }
  if ((held.openControls ?? false) !== (incoming.openControls ?? false)) {
    return true;
  }
  if ((held.repeat ?? "off") !== (incoming.repeat ?? "off")) {
    return true;
  }
  if (!sameIdList(held.skipVotes ?? [], incoming.skipVotes ?? [])) {
    return true;
  }
  if ((held.history ?? []).length !== (incoming.history ?? []).length) {
    return true;
  }
  return (held.history ?? []).some(
    (track, index) => track.id !== (incoming.history ?? [])[index]?.id,
  );
}

function sameIdList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

// ------------------------------------------------------------------ rights

/**
 * A track is "over" for the purpose of a non-manager advancing the queue
 * when the room's last position sample is within this of its duration. The
 * sample can be ten seconds old and a player a couple of seconds adrift.
 */
export const MUSIC_END_GRACE_MS = 20_000;

export interface MusicRights {
  userId: string;
  /** `Permission.MANAGE_MUSIC` in this channel. */
  canManage: boolean;
  /** `Permission.SPEAK`: may put songs on. */
  canAdd: boolean;
  /** People seated in the call, the same count the roster uses. */
  roomSize: number;
}

/** Votes needed to skip: half the room, at least two. */
export function musicSkipVotesNeeded(roomSize: number): number {
  return Math.max(2, Math.ceil(roomSize / 2));
}

function withMusicDefaults(
  state: MusicState,
): MusicState {
  return {
    ...state,
    openControls: state.openControls ?? false,
    repeat: state.repeat ?? "off",
    skipVotes: state.skipVotes ?? [],
    history: state.history ?? [],
  };
}

function pushHistory(history: MusicTrack[], finished: MusicTrack): MusicTrack[] {
  const without = history.filter((track) => track.videoId !== finished.videoId);
  return [finished, ...without].slice(0, MUSIC_HISTORY_LIMIT);
}

/**
 * Canonical next state when the current track ends or is skipped.
 * `rev` / `actorId` / `atMs` are the writer's to fill.
 */
export function musicAdvance(
  held: MusicState,
): Omit<MusicState, "rev" | "actorId" | "atMs"> {
  const state = withMusicDefaults(held);
  const finished = state.current;
  const history = finished ? pushHistory(state.history, finished) : state.history;
  const skipVotes: string[] = [];
  const openControls = state.openControls;
  const repeat = state.repeat;

  if (repeat === "one" && finished) {
    return {
      current: finished,
      queue: state.queue,
      status: "playing",
      positionMs: 0,
      openControls,
      repeat,
      skipVotes,
      history,
    };
  }

  const rotated =
    repeat === "all" && finished ? [...state.queue, finished] : [...state.queue];
  const next = rotated[0] ?? null;
  return {
    current: next,
    queue: next ? rotated.slice(1) : rotated,
    status: next ? "playing" : "paused",
    positionMs: 0,
    openControls,
    repeat,
    skipVotes,
    history,
  };
}

function sameSkipVotes(a: string[], b: string[]): boolean {
  return sameIdList(a, b);
}

function sameHistory(a: MusicTrack[], b: MusicTrack[]): boolean {
  return sameTracks(a, b);
}

function controlsUnchanged(held: MusicState, incoming: MusicStateWrite): boolean {
  return (
    (held.openControls ?? false) === (incoming.openControls ?? false) &&
    (held.repeat ?? "off") === (incoming.repeat ?? "off")
  );
}

/** Incoming is held plus only this user's id, nothing removed, nobody else's id added. */
function isOwnSkipVoteAdd(
  heldVotes: string[],
  incomingVotes: string[],
  userId: string,
): boolean {
  const heldSet = new Set(heldVotes);
  const incomingSet = new Set(incomingVotes);
  if (incomingSet.size !== heldSet.size + 1) {
    return false;
  }
  if (!incomingSet.has(userId) || heldSet.has(userId)) {
    return false;
  }
  for (const id of heldSet) {
    if (!incomingSet.has(id)) {
      return false;
    }
  }
  return true;
}

function matchesAdvance(held: MusicState, incoming: MusicStateWrite): boolean {
  const expected = musicAdvance(held);
  const positionOk =
    incoming.positionMs === 0 ||
    incoming.positionMs === expected.positionMs;
  return (
    positionOk &&
    incoming.status === expected.status &&
    sameOrNull(expected.current, incoming.current) &&
    sameTracks(expected.queue, incoming.queue) &&
    (incoming.openControls ?? false) === expected.openControls &&
    (incoming.repeat ?? "off") === expected.repeat &&
    sameSkipVotes(incoming.skipVotes ?? [], expected.skipVotes) &&
    sameHistory(incoming.history ?? [], expected.history)
  );
}

function ids(tracks: MusicTrack[]): string[] {
  return tracks.map((track) => track.id);
}

/**
 * The same track, field for field. The id alone is not enough: a member
 * who kept every id and swapped the video ids would be playing whatever
 * they liked under a manager's name. `durationMs` may go from null to a
 * value, which is the one field the room's writer fills in after the fact.
 */
function sameTrack(a: MusicTrack, b: MusicTrack): boolean {
  return (
    a.id === b.id &&
    a.provider === b.provider &&
    a.videoId === b.videoId &&
    a.title === b.title &&
    a.sourceUrl === b.sourceUrl &&
    a.thumbnailUrl === b.thumbnailUrl &&
    a.addedByUserId === b.addedByUserId &&
    a.addedByName === b.addedByName &&
    (a.durationMs === b.durationMs || (a.durationMs === null && b.durationMs !== null))
  );
}

function sameTracks(a: MusicTrack[], b: MusicTrack[]): boolean {
  return a.length === b.length && a.every((track, index) => sameTrack(track, b[index] as MusicTrack));
}

function sameOrNull(a: MusicTrack | null, b: MusicTrack | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return sameTrack(a, b);
}

/**
 * Whether one `set-music` write is within the sender's rights. The server
 * decides on this; the client uses it to draw only what will be allowed.
 *
 * A manager may do anything. `openControls` on the held state promotes
 * anyone with SPEAK to that same bar. Anybody else may: put on the first
 * song when nothing is on (and only their own); append their own songs to
 * the end; remove their own; add their own skip vote; move the queue along
 * once the current track has run out or enough skip votes are in; and, as
 * the room's last writer, sample position and fill in the duration.
 * Pausing, skipping, reordering, touching other people's songs, flipping
 * the room switches and ending it for the room are the manager's.
 */
export function musicWriteAllowed(
  held: MusicState | null,
  incoming: MusicStateWrite | null,
  rights: MusicRights,
): boolean {
  const canManage =
    rights.canManage || (held?.openControls === true && rights.canAdd);
  if (canManage) {
    return true;
  }
  if (incoming === null) {
    return false;
  }
  incoming = completeMusicState(held, incoming);
  const own = (track: MusicTrack) => track.addedByUserId === rights.userId;
  if (held === null) {
    return (
      rights.canAdd &&
      incoming.current !== null &&
      own(incoming.current) &&
      incoming.queue.every(own) &&
      (incoming.openControls ?? false) === false &&
      (incoming.repeat ?? "off") === "off" &&
      (incoming.skipVotes ?? []).length === 0 &&
      (incoming.history ?? []).length === 0
    );
  }
  const sameCurrent = sameOrNull(held.current, incoming.current);
  const sameStatus = held.status === incoming.status;
  const historyHeld = held.history ?? [];
  const historyIncoming = incoming.history ?? [];
  const votesHeld = held.skipVotes ?? [];
  const votesIncoming = incoming.skipVotes ?? [];
  if (sameCurrent && sameStatus) {
    if (!controlsUnchanged(held, incoming) || !sameHistory(historyHeld, historyIncoming)) {
      return false;
    }
    // Position sample, duration fill, and/or this person's skip vote.
    if (sameTracks(held.queue, incoming.queue)) {
      if (sameSkipVotes(votesHeld, votesIncoming)) {
        return true;
      }
      return isOwnSkipVoteAdd(votesHeld, votesIncoming, rights.userId);
    }
    if (!sameSkipVotes(votesHeld, votesIncoming)) {
      return false;
    }
    // Append own to the end, the front untouched.
    const prefixSame =
      incoming.queue.length >= held.queue.length &&
      held.queue.every((track, index) => sameTrack(track, incoming.queue[index] as MusicTrack));
    if (prefixSame) {
      return rights.canAdd && incoming.queue.slice(held.queue.length).every(own);
    }
    // Remove own: the held list in order, minus some of mine, nothing else touched.
    const incomingIds = new Set(ids(incoming.queue));
    const kept = held.queue.filter((track) => incomingIds.has(track.id));
    const removed = held.queue.filter((track) => !incomingIds.has(track.id));
    return removed.length > 0 && removed.every(own) && sameTracks(kept, incoming.queue);
  }
  if (!matchesAdvance(held, incoming)) {
    return false;
  }
  const ranOut =
    held.status === "playing" &&
    held.current !== null &&
    held.current.durationMs !== null &&
    held.positionMs >= held.current.durationMs - MUSIC_END_GRACE_MS;
  const votes = new Set([...votesHeld, rights.userId]);
  const votedOut = votes.size >= musicSkipVotesNeeded(rights.roomSize);
  return ranOut || votedOut;
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
const YOUTUBE_LIST_ID = /^[A-Za-z0-9_-]{10,}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

export type SpotifyEntity = "track" | "album" | "playlist" | "other";

export type MusicLink =
  | { kind: "youtube"; videoId: string; url: string }
  /**
   * A whole list. `videoId` is set when the link was a `watch?v=X&list=Y`,
   * so the room can start from that video rather than the top. A YouTube
   * "mix" (`RD...`) is generated per viewer and has no page to read, so it
   * comes back as the single video instead.
   */
  | { kind: "youtube-playlist"; listId: string; videoId: string | null; url: string }
  | { kind: "spotify"; url: string; entity: SpotifyEntity; id: string | null }
  /** A `spotify.link` short URL: the server follows it and parses again. */
  | { kind: "spotify-short"; url: string }
  | { kind: "search"; query: string };

/** What a person pasted. Links become their kind; anything else is a search. */
export function parseMusicInput(raw: string): MusicLink | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }
  // spotify:track:ID and friends.
  const uri = text.match(/^spotify:(track|album|playlist):([A-Za-z0-9]{22})$/);
  if (uri) {
    const entity = uri[1] as SpotifyEntity;
    const id = uri[2] as string;
    return { kind: "spotify", entity, id, url: `https://open.spotify.com/${entity}/${id}` };
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
    const videoId = id && YOUTUBE_ID.test(id) ? id : null;
    const list = url.searchParams.get("list");
    const listId = list && YOUTUBE_LIST_ID.test(list) ? list : null;
    if (listId && !listId.startsWith("RD")) {
      return {
        kind: "youtube-playlist",
        listId,
        videoId,
        url: `https://www.youtube.com/playlist?list=${listId}`,
      };
    }
    if (videoId) {
      return {
        kind: "youtube",
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
      };
    }
    return null;
  }
  if (url && url.hostname === "spotify.link") {
    return { kind: "spotify-short", url: url.toString() };
  }
  if (url && (url.hostname === "open.spotify.com" || url.hostname === "play.spotify.com")) {
    const match = url.pathname.match(
      /^\/(?:intl-[a-z]+\/)?(?:embed\/)?(track|album|playlist)\/([A-Za-z0-9]+)/,
    );
    const entity = (match?.[1] as SpotifyEntity | undefined) ?? "other";
    const id = match?.[2] && SPOTIFY_ID.test(match[2]) ? match[2] : null;
    return {
      kind: "spotify",
      entity: id ? entity : "other",
      id,
      url: id ? `https://open.spotify.com/${entity}/${id}` : url.toString(),
    };
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
