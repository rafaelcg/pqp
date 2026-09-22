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
  /** True when the room picked this track itself (autoplay). */
  autoplayed: z.boolean().optional(),
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
  /**
   * When the queue runs out, the room keeps going with a related track.
   * Only a manager writes this. Optional so a frame from an older client
   * still parses; `completeMusicState` fills false from what the room holds.
   */
  autoplay: z.boolean().optional(),
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
  autoplay: z.boolean().optional(),
});

export type MusicStateWrite = z.infer<typeof musicStateWriteSchema>;

/** Fill fields an older writer omitted from what the room already holds. */
export function completeMusicState(
  held: MusicState | null,
  incoming: MusicStateWrite,
): MusicState {
  const autoplay = incoming.autoplay ?? held?.autoplay;
  return {
    ...incoming,
    openControls: incoming.openControls ?? held?.openControls ?? false,
    repeat: incoming.repeat ?? held?.repeat ?? "off",
    skipVotes: incoming.skipVotes ?? held?.skipVotes ?? [],
    history: incoming.history ?? held?.history ?? [],
    ...(autoplay !== undefined ? { autoplay } : {}),
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
  if ((held.autoplay ?? false) !== (incoming.autoplay ?? false)) {
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

/**
 * How far ahead of the server's own clock a non-manager's position sample
 * may be before the server replaces it with the clock.
 *
 * The largest honest forward divergence is the client's 2.5 s seek
 * threshold plus its 2 s check interval plus the round trip, so under five
 * seconds. This is twice that and half the grace. Tighter would pull an
 * honest append back a few seconds, which the room sees as a backward
 * seek; looser lets somebody creep the room forward by the tolerance on
 * every write, and position-only writes are coalesced rather than refused.
 */
/**
 * THE LONGEST THING THE ROOM WILL CALL A TRACK.
 *
 * A 24/7 live mix answers the player's `getDuration()` with how long the
 * STREAM has been up, not how long a song is, so a room was handed a
 * duration of fifty days and drew a seek bar against it. It is also the
 * other operand of the end-of-track gate, so a value like that means the
 * gate never opens and nothing ever advances on its own.
 *
 * Twelve hours is far above any real DJ set and far below a stream that
 * has been live for days. The bound is here to catch a category error, not
 * to judge a long video.
 */
export const MUSIC_MAX_DURATION_MS = 12 * 60 * 60 * 1000;

export const MUSIC_POSITION_TOLERANCE_MS = 10_000;

export interface MusicRights {
  userId: string;
  /** `Permission.MANAGE_MUSIC` in this channel. */
  canManage: boolean;
  /** `Permission.SPEAK`: may put songs on. */
  canAdd: boolean;
  /** People seated in the call, the same count the roster uses. */
  roomSize: number;
  /**
   * The room's position by the SERVER's clock, when the caller keeps one.
   * The end-of-track gate reads this rather than `held.positionMs`, which
   * is the last accepted sample and which anybody seated can write. The
   * client omits it: it only uses this function to decide what to draw.
   */
  expectedPositionMs?: number;
  /**
   * The user ids behind that count, when the caller knows them. The skip
   * threshold is half the LIVE room, so its numerator has to be live too:
   * a vote is only counted while its owner is still seated. Omitted means
   * "not known here", and every held vote counts, which is what the client
   * does when it draws the button.
   */
  seatedUserIds?: string[];
  /**
   * The peer id of the socket this write arrived on, when the caller has
   * one. `actorId` is the writer's own peer id and the tie-break between
   * two writes at the same `rev`, chosen by the writer, so a client that
   * picks a high string wins every race it enters. The server knows who
   * is on the socket and checks the claim against it; the client omits
   * this, because it only uses this function to decide what to draw.
   */
  peerId?: string;
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
    autoplay: state.autoplay ?? false,
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
  const autoplay = state.autoplay;

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
      autoplay,
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
    autoplay,
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
    (held.repeat ?? "off") === (incoming.repeat ?? "off") &&
    (held.autoplay ?? false) === (incoming.autoplay ?? false)
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
    (incoming.autoplay ?? false) === expected.autoplay &&
    sameSkipVotes(incoming.skipVotes ?? [], expected.skipVotes) &&
    sameHistory(incoming.history ?? [], expected.history)
  );
}

function matchesAutoplayAdvance(
  held: MusicState,
  incoming: MusicStateWrite,
  rights: MusicRights,
): boolean {
  if (held.autoplay !== true || held.queue.length > 0 || incoming.queue.length > 0) {
    return false;
  }
  const next = incoming.current;
  if (
    next === null ||
    next.autoplayed !== true ||
    next.addedByUserId !== rights.userId
  ) {
    return false;
  }
  if (incoming.status !== "playing" || incoming.positionMs !== 0) {
    return false;
  }
  if (!controlsUnchanged(held, incoming)) {
    return false;
  }
  if ((incoming.skipVotes ?? []).length !== 0) {
    return false;
  }
  const expected = musicAdvance(held);
  return sameHistory(incoming.history ?? [], expected.history);
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
 * anyone with SPEAK to the same bar EXCEPT the three room switches, which
 * stay with `MANAGE_MUSIC`: a promoted speaker runs the music, they do not
 * decide who else may. Anybody else may: put on the first
 * song when nothing is on (and only their own); append their own songs to
 * the end; remove their own; add their own skip vote; move the queue along
 * once the current track has run out or enough skip votes are in; and, as
 * the room's last writer, sample position and fill in the duration.
 * Pausing, skipping, reordering, touching other people's songs, flipping
 * the room switches (`openControls`, `repeat`, `autoplay`) and ending it
 * for the room are the manager's. When `autoplay` is on, the queue is
 * empty and the current track has run out, a member may also write the
 * next related track under their own name with `autoplayed: true`.
 */
/**
 * A length a song could actually have: unknown, or inside the bounds.
 * `MUSIC_MAX_DURATION_MS` is the live-stream ceiling; the floor is simply
 * that zero and negatives are not lengths, they are a way of saying the
 * track is already over.
 */
function plausibleDuration(durationMs: number | null | undefined): boolean {
  if (durationMs === null || durationMs === undefined) {
    return true;
  }
  return (
    Number.isFinite(durationMs) &&
    durationMs > 0 &&
    durationMs <= MUSIC_MAX_DURATION_MS
  );
}

/** What the room already believes this track is, if it holds it at all. */
function heldDurationOf(
  held: MusicState | null,
  trackId: string,
): number | null | undefined {
  if (held === null) {
    return undefined;
  }
  if (held.current?.id === trackId) {
    return held.current.durationMs;
  }
  return held.queue.find((track) => track.id === trackId)?.durationMs;
}

/**
 * Bounded on what a write INTRODUCES, not on what it carries.
 *
 * Every write is an absolute state, so it repeats every track already in
 * the room. Checking all of them meant a room handed a bogus duration
 * before this rule existed would have every later write refused, including
 * the skip that would have got rid of the track: stuck until it emptied.
 *
 * A track therefore keeps whatever length it already had, and only a new
 * or changed one has to be plausible. The gate is safe either way, because
 * it needs a positive duration and caps the grace at half of it: a legacy
 * zero ends nothing and a legacy fifty days never comes due.
 */
function durationsArePlausible(
  held: MusicState | null,
  incoming: MusicStateWrite,
): boolean {
  const introduced = (track: MusicTrack) => {
    const before = heldDurationOf(held, track.id);
    if (before !== undefined && before === track.durationMs) {
      return true;
    }
    return plausibleDuration(track.durationMs);
  };
  if (incoming.current && !introduced(incoming.current)) {
    return false;
  }
  return (incoming.queue ?? []).every(introduced);
}

/**
 * THE SERVER'S DOOR, WHERE THE TRUSTED CONTEXT IS NOT OPTIONAL.
 *
 * `MusicRights` carries the three things only the server knows — the
 * socket's peer id, the room's own clock, and who is seated — as optional
 * fields, because the client calls the same rule with none of them to
 * decide what to draw. That is convenient and it is also how a server
 * caller forgets one: it still compiles, and it silently gets the client's
 * lenient reading, where the end-of-track gate falls back to the last
 * position sample anybody wrote.
 *
 * So the server does not call `musicWriteAllowed` directly. It calls this,
 * which demands all three. `expectedPositionMs` is `number | null` rather
 * than optional on purpose: a room with no anchor is a real state, and the
 * caller has to say so rather than leave it out.
 */
export interface MusicServerRights {
  userId: string;
  canManage: boolean;
  canAdd: boolean;
  roomSize: number;
  /** The peer id of the socket the write arrived on. */
  peerId: string;
  /** The room's own clock, or null when this instance holds no anchor. */
  expectedPositionMs: number | null;
  /** Who is seated, from the cluster when the registry is on. */
  seatedUserIds: string[];
}

export function musicServerWriteAllowed(
  held: MusicState | null,
  incoming: MusicStateWrite | null,
  rights: MusicServerRights,
): boolean {
  return musicWriteAllowed(held, incoming, {
    ...rights,
    expectedPositionMs: rights.expectedPositionMs ?? undefined,
  });
}

export function musicWriteAllowed(
  held: MusicState | null,
  incoming: MusicStateWrite | null,
  rights: MusicRights,
): boolean {
  /*
   * Before the rights, because this is not a rights question.
   *
   * A track's declared length is the other operand of the end-of-track
   * gate and it arrives from a client, so every track in the write is
   * bounded, both ends, wherever it sits. The first version of this looked
   * only at `incoming.current` and only while the held duration was still
   * null, which left the ordinary append path wide open: a member could
   * queue a track declaring fifty days (defeating the live-stream ceiling
   * the moment it became current) or declaring zero, which satisfies the
   * gate from the instant it starts and hands an advance to anybody at all.
   *
   * Null stays legal: that is what an unknown duration IS, and the room
   * falls back to votes for an early skip.
   */
  if (incoming !== null && !durationsArePlausible(held, incoming)) {
    return false;
  }
  if (rights.canManage) {
    return true;
  }
  /*
   * "Todo mundo controla" is one rule, not a verb table: everything a
   * manager may write except `openControls`, `repeat` and `autoplay`.
   * A list of allowed verbs was tried and refuses two things the switch is
   * meant to hand over, because both rewrite `history`: the skip-back, and
   * an add while the current track has already ended.
   */
  if (held !== null && held.openControls === true && rights.canAdd) {
    if (incoming === null) {
      return true;
    }
    return controlsUnchanged(held, completeMusicState(held, incoming));
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
      (incoming.autoplay ?? false) === false &&
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
    /*
     * The duration is the other half of the end-of-track gate, and
     * `sameTrack` lets it go from null to any value so the room's writer
     * can fill it in after the fact. A member who fills 1 makes the gate
     * true at position zero, and no bound on the value closes that: any
     * floor still lets the filler cut the track a grace later. So the fill
     * belongs to the manager, or to whoever put the track on.
     */
    const fillsDuration =
      held.current !== null &&
      incoming.current !== null &&
      held.current.durationMs === null &&
      incoming.current.durationMs !== null;
    if (
      fillsDuration &&
      !(rights.canManage || held.current?.addedByUserId === rights.userId)
    ) {
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
  /*
   * THE SERVER FAILS CLOSED HERE; THE CLIENT IS ONLY DRAWING.
   *
   * `peerId` is set by the server and by nothing else, so it is how the
   * two callers are told apart. The server's clock is the anchor, and
   * when a room has none — the cold-row case counted as
   * `musicCluster.anchorMissing` — falling back to `held.positionMs`
   * handed the decision straight back to the last sample anybody seated
   * wrote, which is the bypass the anchor exists to close. Without a
   * trusted clock the room falls back to votes, which is safe and still
   * lets it move on. The client has no anchor and never will; it asks
   * this only to decide what to show.
   */
  const serverSide = rights.peerId !== undefined;
  const gatePosition =
    rights.expectedPositionMs ?? (serverSide ? null : held.positionMs);
  /*
   * The grace never swallows the whole track. At a flat 20 s any track
   * declaring less than that was "over" at position zero, so a short
   * length — which nothing used to refuse — was an advance anybody could
   * write. Half the track is the most the grace may take.
   */
  const declared = held.current?.durationMs ?? null;
  const grace =
    declared === null
      ? MUSIC_END_GRACE_MS
      : Math.min(MUSIC_END_GRACE_MS, Math.floor(declared / 2));
  const ranOut =
    held.status === "playing" &&
    held.current !== null &&
    declared !== null &&
    declared > 0 &&
    gatePosition !== null &&
    gatePosition >= declared - grace;
  // Only the votes of people still seated. `roomSize` shrinks when somebody
  // leaves and their vote does not, so the two moved out of step and a
  // ghost could carry the threshold.
  /*
   * Same rule for the roster. The server always knows who is seated
   * (`musicRoomSeats` falls back to this instance's own peers rather than
   * answering nothing), so an absent list server-side is a bug, and
   * counting every held vote in that case would let the votes of people
   * who have left carry the threshold. An empty set is the safe reading;
   * the sender's own vote is still added below.
   */
  const seated =
    rights.seatedUserIds !== undefined
      ? new Set(rights.seatedUserIds)
      : serverSide
        ? new Set<string>()
        : null;
  const liveVotes = seated
    ? votesHeld.filter((id) => seated.has(id))
    : votesHeld;
  const votes = new Set([...liveVotes, rights.userId]);
  const votedOut = votes.size >= musicSkipVotesNeeded(rights.roomSize);
  if (matchesAdvance(held, incoming)) {
    return ranOut || votedOut;
  }
  return ranOut && matchesAutoplayAdvance(held, incoming, rights);
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
  /*
   * A paste that did not survive the clipboard is not a search. Without
   * this it fell past the "some other site" refusal below, which needs a
   * parsed URL, and came back as a search for the broken text with an
   * unrelated song attached. It has to START with a scheme: "bohemian
   * rhapsody http://" is a search today and stays one, and so does any
   * query with a colon in it.
   */
  if (url === null && /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return null;
  }
  if (url && YOUTUBE_HOSTS.has(url.hostname)) {
    let id: string | null = null;
    if (url.hostname.endsWith("youtu.be")) {
      id = url.pathname.slice(1).split("/")[0] ?? null;
      // `youtube.com/watch/?v=` is served by YouTube and was refused here.
    } else if (url.pathname.replace(/\/+$/, "") === "/watch") {
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

/** Shorter than a minute or longer than twelve is a clip or a film, not a song. */
export const MUSIC_AUTOPLAY_MIN_MS = 60_000;
export const MUSIC_AUTOPLAY_MAX_MS = 12 * 60 * 1000;

function isSongLength(durationMs: number | null): boolean {
  if (durationMs === null) {
    return true;
  }
  return durationMs >= MUSIC_AUTOPLAY_MIN_MS && durationMs <= MUSIC_AUTOPLAY_MAX_MS;
}

/**
 * Related videos the room has not just finished, queued, or already
 * played, and that are song-length when duration is known. Duration
 * unknown is kept: InnerTube sometimes omits the clock.
 */
export function musicAutoplayCandidates(
  related: MusicResolved[],
  state: MusicState,
  limit = Infinity,
): MusicResolved[] {
  const blocked = new Set<string>();
  if (state.current?.videoId) {
    blocked.add(state.current.videoId);
  }
  for (const track of state.history ?? []) {
    blocked.add(track.videoId);
  }
  for (const track of state.queue) {
    blocked.add(track.videoId);
  }
  const out: MusicResolved[] = [];
  for (const video of related) {
    if (out.length >= limit) {
      break;
    }
    if (blocked.has(video.videoId) || !isSongLength(video.durationMs)) {
      continue;
    }
    out.push(video);
    blocked.add(video.videoId);
  }
  return out;
}

/** First pick from `musicAutoplayCandidates`. */
export function musicAutoplayCandidate(
  related: MusicResolved[],
  state: MusicState,
): MusicResolved | null {
  return musicAutoplayCandidates(related, state, 1)[0] ?? null;
}
