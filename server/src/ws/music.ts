import {
  MUSIC_POSITION_TOLERANCE_MS,
  completeMusicState,
  musicServerWriteAllowed,
  type MusicServerRights,
  musicWriteIsStale,
  musicWriteIsStructural,
  type ChannelMusicTrack,
  type MusicRights,
  type MusicState,
  type MusicStateWrite,
} from "@pqp/shared";
import { logEvent } from "../lib/log.js";
import { createDividedRateLimiter } from "../lib/cluster-rate-limit.js";

/**
 * THE ROOM'S MUSIC QUEUE, HELD HERE RATHER THAN RELAYED THROUGH.
 *
 * The server half of `packages/shared/src/music.ts`, and a copy of the
 * watch-party module's shape (`ws/watch-party.ts`) for the same two reasons:
 * a peer joining mid-track has to land at the right position and has no way
 * to ask anybody for it, and the last participant leaving has to tear the
 * queue down.
 *
 * SCOPE. Per process, exactly like `peers` in `voice.ts` and the map in
 * `ws/watch-party.ts`. With the voice registry off (the default) this map IS
 * the queue and a room lives on one instance. With `VOICE_REGISTRY=postgres`
 * the queue is `voice_rooms.music` and this map is a cache of it: a write is
 * compared and coalesced here first, then persisted with the contract's
 * ordering as the WHERE clause (`persistMusic` in `voice/registry.ts`), and a
 * write that lost in the row is handed the row's winner. Writes from other
 * instances land through `adoptMusicState`, off the `voice.music` bus topic.
 * Documented in `docs/MUSIC.md`.
 */
const rooms = new Map<string, MusicState>();

/**
 * THE ROOM'S CLOCK, KEPT HERE RATHER THAN TAKEN FROM THE LAST WRITER.
 *
 * `positionMs` on the state is the last sample anybody sent, and anybody
 * seated can send one: it is what every client seeks to, and it was one
 * half of the end-of-track gate. So the server keeps its own anchor and
 * moves it only for a write it trusts: a manager's (their seek IS the
 * truth), or a structural change from anybody (a new track starts at zero,
 * a pause freezes, a resume restarts). A sample from anybody else is
 * compared against it and clamped, never refused, because every write
 * carries the writer's own player position and a refusal would take the
 * ordinary queue append with it.
 *
 * `at` is server time. The state's own `atMs` is the client's clock and is
 * already documented as not to be trusted.
 */
export interface MusicAnchor {
  positionMs: number;
  at: number;
}

const anchors = new Map<string, MusicAnchor>();

/** Where the room is by this server's clock, or null with no anchor yet. */
export function musicExpectedPositionMs(
  voiceChannelId: string,
  now: number = Date.now(),
): number | null {
  const anchor = anchors.get(voiceChannelId);
  const held = rooms.get(voiceChannelId);
  if (!anchor || !held) {
    return null;
  }
  if (held.status !== "playing") {
    return anchor.positionMs;
  }
  return anchor.positionMs + Math.max(0, now - anchor.at);
}

/** A write this server trusts to say where the room is. */
function setMusicAnchor(voiceChannelId: string, positionMs: number, at: number): void {
  anchors.set(voiceChannelId, { positionMs: Math.max(0, positionMs), at });
}

/** The anchor as it stands, for the row and the bus frame. */
export function getMusicAnchor(voiceChannelId: string): MusicAnchor | null {
  return anchors.get(voiceChannelId) ?? null;
}

/**
 * The anchor another instance accepted, or the one the row carries. Applied
 * with the state it came with, never on its own: an anchor without its
 * queue is a clock for a track that may already be over.
 */
export function adoptMusicAnchor(
  voiceChannelId: string,
  anchor: { positionMs: number; at: number } | null,
): void {
  if (anchor) {
    setMusicAnchor(voiceChannelId, anchor.positionMs, anchor.at);
    return;
  }
  anchors.delete(voiceChannelId);
}

/** Whoever is running the music: a manager, or a speaker the room promoted. */
function runsTheMusic(held: MusicState | null, rights: MusicRights): boolean {
  return rights.canManage || (held?.openControls === true && rights.canAdd);
}

/**
 * Same limiter shape as the watch party's: spent by every write, refusing
 * none, and consulted only for position-only updates (a scrub). A dropped
 * pause would split the room permanently, see `watch-party.ts`.
 */
/**
 * DIVIDED, NOT SHARED. The budget is a cluster-wide 15, so with two machines
 * this process holds 8 of it (see `createDividedRateLimiter`). That is
 * approximate on purpose: this limiter is consulted on a per-frame path — a
 * seek scrub emits continuously while a thumb is down — and a round trip per
 * frame would cost more than the limit is worth. It is also the limiter that
 * REFUSES NOTHING, so dividing it can only make a scrub slightly choppier in
 * the worst case; a budget that refused would instead hand a single-tab user
 * half of what they had, since their socket lives on one machine.
 */
const writeLimiter = createDividedRateLimiter({ capacity: 15, refillPerSecond: 5 });

export function resetMusicLimits(): void {
  writeLimiter.reset();
}

export function getMusicState(voiceChannelId: string): MusicState | null {
  return rooms.get(voiceChannelId) ?? null;
}

/** Every room with music, for the connect-time `channel-music` frames. */
export function musicChannels(): string[] {
  return [...rooms.keys()];
}

/** What the sidebar is told: the current track, and who is listening. */
export function channelMusicTrack(
  voiceChannelId: string,
  listeners?: number,
): ChannelMusicTrack | null {
  const current = rooms.get(voiceChannelId)?.current;
  return current
    ? {
        videoId: current.videoId,
        title: current.title,
        thumbnailUrl: current.thumbnailUrl,
        ...(listeners !== undefined ? { listeners } : {}),
      }
    : null;
}

/** Returns whether there was a queue to end. */
export function endMusic(voiceChannelId: string): boolean {
  anchors.delete(voiceChannelId);
  return rooms.delete(voiceChannelId);
}

export function resetMusicForTests(): void {
  rooms.clear();
  anchors.clear();
  writeLimiter.reset();
}

/**
 * Take a queue decided elsewhere (the registry row, or a `voice.music` frame
 * from another instance) into the cache. Applies the contract's ordering
 * against what is held, so a straggling frame cannot roll the cache back;
 * `null` is a teardown and always wins, as it does in `applyMusicWrite`.
 * Returns whether the cache changed. No limiter, no rights check, no log:
 * nothing here was written by a person on this instance, and whoever accepted
 * it already ran all three.
 */
/**
 * WHAT MOVES THE ROOM'S CLOCK, WHICH IS NARROWER THAN WHAT IS STRUCTURAL.
 *
 * A new track starts at zero, a pause freezes and a resume restarts: those
 * are true on every machine and for whoever wrote them. Everything else a
 * write may carry (an append, a removal, a vote, a switch) says nothing
 * about where the room is, and moving the clock for one hands a member the
 * creep the clamp exists to stop: the append lands a tolerance ahead, the
 * anchor follows it there, and the next append starts from the new reading.
 * Twenty of them walk a 200 s track to its end and open the end-of-track
 * gate for somebody holding no votes.
 *
 * `musicWriteIsStructural` is the WRITE LIMITER'S question ("may this be
 * coalesced?") and stays what it is. This is the clock's.
 */
function movesTheClock(held: MusicState | null, next: MusicState): boolean {
  if (held === null) {
    return true;
  }
  return (
    held.status !== next.status ||
    (held.current?.id ?? null) !== (next.current?.id ?? null)
  );
}

export function adoptMusicState(
  voiceChannelId: string,
  state: MusicState | null,
): boolean {
  const held = getMusicState(voiceChannelId);
  if (state === null) {
    if (held === null) {
      return false;
    }
    rooms.delete(voiceChannelId);
    anchors.delete(voiceChannelId);
    return true;
  }
  if (musicWriteIsStale(held, state)) {
    return false;
  }
  rooms.set(voiceChannelId, state);
  /*
   * A new track or a pause from elsewhere moves this instance's clock even
   * without an anchor in the frame, because both are true on every
   * machine. Nothing else does: the frame's `positionMs` is a sample, and
   * the whole point of the anchor is not to trust one.
   */
  if (movesTheClock(held, state)) {
    setMusicAnchor(voiceChannelId, state.positionMs, Date.now());
  }
  return true;
}

/**
 * THE CLOCK COMES WITH THE QUEUE, AND ONLY WITH IT.
 *
 * Every place that takes a queue decided elsewhere (the registry row on a
 * join, a `voice.music` frame, the row's winner after this instance lost)
 * gets the anchor that was stored beside that queue. Adopting one without
 * the other is a bug in both directions: a queue with no clock leaves the
 * clamp measuring against a reading from before the frame, and a clock
 * from a queue this instance REFUSED rolls the room back by whatever the
 * refused write was worth, then clamps every honest sample to the older
 * reading and broadcasts it. So the two move together or not at all.
 */
export function adoptMusicWithAnchor(
  voiceChannelId: string,
  state: MusicState | null,
  /**
   * `null` is a source that HAS no clock (a row written before this field,
   * a teardown): the clamp and the clock-based gate stand down until a
   * trusted write sets one. `undefined` is a source that says NOTHING about
   * the clock, which is a `voice.music` frame from an instance older than
   * the field, and clearing this instance's on the strength of it would
   * hand the room to whichever sample arrived next.
   */
  anchor: MusicAnchor | null | undefined,
): boolean {
  if (!adoptMusicState(voiceChannelId, state)) {
    return false;
  }
  if (anchor !== undefined) {
    adoptMusicAnchor(voiceChannelId, anchor);
  }
  return true;
}

export type MusicWrite =
  | { kind: "accepted"; state: MusicState | null }
  | { kind: "coalesced" }
  | { kind: "stale"; held: MusicState }
  /** Outside the sender's rights. `held` goes back, forced, to undo their optimistic copy. */
  | { kind: "refused"; held: MusicState | null };

/**
 * `MusicServerRights`, not `MusicRights`: the three fields only the server
 * can know are required there, so this entry point cannot be called with
 * the client's lenient reading by forgetting one.
 */
export function applyMusicWrite(
  voiceChannelId: string,
  incoming: MusicStateWrite | null,
  rights: Omit<MusicServerRights, "expectedPositionMs">,
): MusicWrite {
  const actorUserId = rights.userId;
  const held = getMusicState(voiceChannelId);
  const now = Date.now();
  const expected = musicExpectedPositionMs(voiceChannelId, now);
  let next = incoming === null ? null : completeMusicState(held, incoming);
  if (
    next !== null &&
    rights.peerId !== undefined &&
    next.actorId !== rights.peerId
  ) {
    // Signed as somebody else. Nothing here is a permission this write
    // did not have, but `actorId` decides same-`rev` ties in both the
    // cache and the row, so an invented one wins every race it enters.
    logEvent("voice.musicRefused", {
      voiceChannelId,
      userId: actorUserId,
      reason: "actor",
    });
    return { kind: "refused", held };
  }
  if (musicWriteIsStale(held, next)) {
    return { kind: "stale", held: held as MusicState };
  }
  /*
   * Clamped, not refused: the append on the same write has to land.
   *
   * Both ways, and the backward half was missing. It was left open on the
   * reasoning that a buffering player lags and a backward sample cannot
   * reach the end-of-track gate. True of the gate, and beside the point
   * for everyone else: every client seeks to within 2.5 s of the room's
   * clock, so a seat writing zero at the ninety-minute mark dragged the
   * whole room back to the start, and the sample was theirs, so it read
   * as an ordinary seek. The tolerance is what a genuinely slow player
   * needs; past it, the room's own clock is the truth.
   */
  if (
    next !== null &&
    expected !== null &&
    !runsTheMusic(held, rights) &&
    Math.abs(next.positionMs - expected) > MUSIC_POSITION_TOLERANCE_MS
  ) {
    logEvent("voice.musicClamped", {
      voiceChannelId,
      userId: actorUserId,
      aheadMs: next.positionMs - expected,
    });
    next = { ...next, positionMs: expected };
  }
  if (
    !musicServerWriteAllowed(held, next, {
      ...rights,
      // The room's own clock is this module's to supply, not the caller's.
      expectedPositionMs: expected,
    })
  ) {
    logEvent("voice.musicRefused", {
      voiceChannelId,
      userId: actorUserId,
      reason: next === null ? "stop" : "write",
    });
    return { kind: "refused", held };
  }
  const structural = musicWriteIsStructural(held, next);
  if (next !== null && (movesTheClock(held, next) || runsTheMusic(held, rights))) {
    setMusicAnchor(voiceChannelId, next.positionMs, now);
  }
  const withinBudget = writeLimiter.take(actorUserId);
  if (!structural && !withinBudget) {
    if (next) {
      rooms.set(voiceChannelId, next);
    }
    return { kind: "coalesced" };
  }
  if (next === null) {
    endMusic(voiceChannelId);
    return { kind: "accepted", state: null };
  }
  if (held === null) {
    logEvent("voice.musicStart", {
      voiceChannelId,
      userId: actorUserId,
      videoId: next.current?.videoId ?? null,
    });
  }
  rooms.set(voiceChannelId, next);
  return { kind: "accepted", state: next };
}
