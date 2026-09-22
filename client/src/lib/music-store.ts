import { useSyncExternalStore } from "react";
import {
  MUSIC_QUEUE_LIMIT,
  completeMusicState,
  musicAdvance,
  musicAutoplayCandidate,
  musicAutoplayCandidates,
  musicSkipVotesNeeded,
  musicWriteIsStale,
  type MusicRepeat,
  type MusicResolved,
  type MusicState,
  type MusicTrack,
} from "@pqp/shared";

export { musicSkipVotesNeeded };

/** Past this, skip-back restarts the current track instead of Tocadas. */
export const MUSIC_RESTART_THRESHOLD_MS = 3000;

/**
 * THE ROOM'S MUSIC QUEUE, ON THIS MACHINE.
 *
 * Kept out of `VoiceState` on purpose: a position sample arriving every few
 * seconds would re-render the whole call stage, and the only things that
 * read this are the dock and its player. `use-voice.ts` feeds it (`music`
 * frames in, `set-music` frames out through the session it registers on
 * `welcome`) and the dock subscribes with `useMusic()`.
 *
 * Every local action is last-writer-wins with `rev = seen + 1` and this
 * peer's id as the tie-break, exactly as the watch party's contract says
 * (`packages/shared/src/watch-party.ts`). The local copy is applied
 * immediately and the echo confirms it; a stale answer from the server
 * replaces it, which is how a lost race is settled in one round trip.
 */

export interface MusicSession {
  channelId: string;
  peerId: string;
  userId: string;
  displayName: string;
  send: (state: MusicState | null) => void;
  sendListening?: (listening: boolean) => void;
  /**
   * Whether this seat holds MANAGE_MUSIC, read when it is needed rather
   * than captured: a cargo change re-resolves the bit without minting a new
   * session. Only the duration fill asks, and only to avoid writing
   * something the server will answer with a `forced` frame.
   */
  canManage?: () => boolean;
}

export interface MusicSnapshot {
  channelId: string | null;
  state: MusicState | null;
  /** This machine's clock when `state` arrived. Drift is measured from here. */
  receivedAt: number;
  /** Whether the composer Fila sheet is open. Click-only; adds never set this. */
  open: boolean;
  /**
   * Whether THIS machine plays the room's music. False is "parar de ouvir":
   * the player unmounts here, the room's queue carries on for everyone
   * else, and a pill offers the way back. Reset on every new seat.
   */
  listening: boolean;
}

let session: MusicSession | null = null;
let snapshot: MusicSnapshot = { channelId: null, state: null, receivedAt: 0, open: false, listening: true };
/** This machine saw YouTube ENDED for this current track id. */
let localEndedTrackId: string | null = null;
/** Bumped to abandon an in-flight related fill. */
let fillGeneration = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function abandonAutoplayFill(): void {
  fillGeneration += 1;
}

function set(state: MusicState | null, channelId: string | null) {
  /*
   * The mark says "this machine's player reported the end of the track the
   * room is on". A different track clears it. So does the SAME track from
   * the top, which is what repeat-one and an empty-queue repeat-all wrap
   * both produce: without that case the mark outlived the track and the
   * next add took the end-of-track path, pulling a looping song out
   * mid-play. A manager seeking to zero clears it too, and correctly:
   * `seekTo(0)` on an ended player restarts it.
   */
  const restartedFromTheTop =
    state?.current?.id === localEndedTrackId &&
    state?.positionMs === 0 &&
    state?.status === "playing";
  if (localEndedTrackId && (state?.current?.id !== localEndedTrackId || restartedFromTheTop)) {
    localEndedTrackId = null;
  }
  // A fill started for another room or another current track must not
  // land after this write. Queue-only edits keep the generation so one
  // fill can append more than once.
  if (snapshot.channelId !== channelId || snapshot.state?.current?.id !== state?.current?.id) {
    abandonAutoplayFill();
  }
  snapshot = { ...snapshot, channelId, state, receivedAt: Date.now() };
  emit();
}

export function setMusicOpen(open: boolean): void {
  if (snapshot.open === open) {
    return;
  }
  snapshot = { ...snapshot, open };
  emit();
}

export function toggleMusicOpen(): void {
  setMusicOpen(!snapshot.open);
}

/**
 * A new seat, or none. Either way the held state is dropped: the server
 * sends the room's state right after `welcome`, and an optimistic copy
 * from before a reconnect is a `rev` ahead of the truth and would otherwise
 * call it stale. Only a reconnect INTO THE SAME ROOM keeps the personal
 * toggles (listening, open).
 */
export function setMusicSession(next: MusicSession | null): void {
  const sameRoom = next !== null && session?.channelId === next.channelId;
  session = next;
  if (!sameRoom) {
    snapshot = { ...snapshot, listening: true, open: false };
  }
  set(null, next?.channelId ?? null);
  if (next && !snapshot.listening) {
    next.sendListening?.(false);
  }
}

/** The room this machine may write to right now, or null. */
export function musicSessionChannelId(): string | null {
  return session?.channelId ?? null;
}

export function setListening(listening: boolean): void {
  if (snapshot.listening === listening) {
    return;
  }
  snapshot = { ...snapshot, listening };
  emit();
  session?.sendListening?.(listening);
}

/** A `music` frame from the server (join, echo, another person's write). */
export function receiveMusic(
  channelId: string,
  state: MusicState | null,
  forced = false,
): void {
  // No seat, or a seat elsewhere: not ours. A frame that lands after
  // leaving must not repopulate a player that has nowhere to play.
  if (!session || session.channelId !== channelId) {
    return;
  }
  // A refusal hands back what the server holds; our optimistic copy is
  // ahead of it by one `rev` and would otherwise call the correction stale.
  const next = state === null ? null : completeMusicState(snapshot.state, state);
  if (!forced && next !== null && musicWriteIsStale(snapshot.state, next)) {
    return;
  }
  set(next, channelId);
}

export function subscribeMusic(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getMusicSnapshot(): MusicSnapshot {
  return snapshot;
}

export function useMusic(): MusicSnapshot {
  return useSyncExternalStore(subscribeMusic, getMusicSnapshot, getMusicSnapshot);
}

export interface MusicDockSnapshot {
  /** Fila sheet open. The dock tile's pressed state. */
  open: boolean;
  /** A track is on. The composer bar is visible. */
  on: boolean;
  /** This machine is hearing it. False after Parar de ouvir. */
  listening: boolean;
}

let dockSnap: MusicDockSnapshot = { open: false, on: false, listening: true };

function getMusicDockSnapshot(): MusicDockSnapshot {
  const on = snapshot.state?.current != null;
  if (
    dockSnap.open === snapshot.open &&
    dockSnap.on === on &&
    dockSnap.listening === snapshot.listening
  ) {
    return dockSnap;
  }
  dockSnap = { open: snapshot.open, on, listening: snapshot.listening };
  return dockSnap;
}

/**
 * Open + whether a track is on. Position samples do not change this
 * snapshot, so CallControls can subscribe without following the playhead.
 */
export function useMusicDock(): MusicDockSnapshot {
  return useSyncExternalStore(subscribeMusic, getMusicDockSnapshot, getMusicDockSnapshot);
}

export function resetMusicStoreForTests(): void {
  session = null;
  positionProbe = null;
  seekApply = null;
  localEndedTrackId = null;
  fillGeneration += 1;
  snapshot = { channelId: null, state: null, receivedAt: 0, open: false, listening: true };
  dockSnap = { open: false, on: false, listening: true };
  listeners.clear();
}

// ------------------------------------------------------------------ actions

function write(next: Omit<MusicState, "rev" | "actorId" | "atMs">): void {
  if (!session) {
    return;
  }
  const state: MusicState = {
    ...next,
    atMs: Date.now(),
    rev: (snapshot.state?.rev ?? 0) + 1,
    actorId: session.peerId,
  };
  set(state, session.channelId);
  session.send(state);
}

/**
 * Where the player actually is, asked at write time. Registered by the
 * player while one is mounted. Without it a queue edit would carry the
 * position of the LAST sample, which can be a minute stale, and a joiner
 * would land there.
 */
let positionProbe: (() => number) | null = null;

export function setPositionProbe(probe: (() => number) | null): void {
  positionProbe = probe;
}

/**
 * The mounted embed. A scrub must move THIS machine's player in the same
 * click as the write: a later effect `seekTo` is not a gesture, and YouTube
 * answers that by playing muted or not at all.
 */
let seekApply: ((positionMs: number) => void) | null = null;

export function setSeekApply(apply: ((positionMs: number) => void) | null): void {
  seekApply = apply;
}

function livePositionMs(held: MusicState | null): number {
  if (!held || !held.current) {
    return 0;
  }
  if (positionProbe) {
    try {
      const at = positionProbe();
      if (Number.isFinite(at) && at >= 0) {
        return Math.round(at);
      }
    } catch {
      // fall through to the arithmetic
    }
  }
  return Math.round(expectedPositionMs(snapshot));
}

function base(): Omit<MusicState, "rev" | "actorId" | "atMs"> {
  const held = snapshot.state;
  return {
    current: held?.current ?? null,
    queue: held?.queue ?? [],
    status: held?.status ?? "paused",
    positionMs: livePositionMs(held),
    openControls: held?.openControls ?? false,
    repeat: held?.repeat ?? "off",
    skipVotes: held?.skipVotes ?? [],
    history: held?.history ?? [],
    autoplay: held?.autoplay ?? false,
  };
}

let trackSeq = 0;

function mintTrack(resolved: MusicResolved): MusicTrack | null {
  if (!session) {
    return null;
  }
  trackSeq += 1;
  return {
    id: `${session.peerId.slice(0, 8)}-${Date.now().toString(36)}-${trackSeq}`,
    provider: resolved.provider,
    videoId: resolved.videoId,
    title: resolved.title,
    sourceUrl: resolved.sourceUrl,
    thumbnailUrl: resolved.thumbnailUrl,
    durationMs: resolved.durationMs,
    addedByUserId: session.userId,
    addedByName: session.displayName,
  };
}

function dropAutoplayed(queue: MusicTrack[]): MusicTrack[] {
  return queue.filter((track) => !track.autoplayed);
}

/** This machine's player reported the current track ended. */
export function markCurrentEnded(trackId: string): void {
  if (snapshot.state?.current?.id === trackId) {
    localEndedTrackId = trackId;
  }
}

/**
 * This machine's player left ENDED for the track it is on. The store's own
 * rule in `set()` covers a restart the ROOM announced; this covers one only
 * the player knows about, and the player is the authority on that.
 */
export function clearCurrentEnded(trackId: string | undefined): void {
  if (trackId && localEndedTrackId === trackId) {
    localEndedTrackId = null;
  }
}

export function currentTrackHasEnded(): boolean {
  const currentId = snapshot.state?.current?.id;
  return Boolean(currentId && localEndedTrackId === currentId);
}

/** Returns how many tracks the room already had and lost to the cap. */
function startNow(track: MusicTrack, extra: MusicTrack[] = []): number {
  const held = snapshot.state;
  if (!held?.current) {
    return 0;
  }
  const finished = held.current;
  const advanced = musicAdvance({
    ...held,
    queue: dropAutoplayed(held.queue),
    positionMs: livePositionMs(held),
  });
  /*
   * What `musicAdvance` answers with is only a DISPLACED track when it is
   * a real upcoming one. Under repeat-one, and under repeat-all with an
   * empty queue, it answers with the finished track looping, and it has
   * already filed that track into `history`. Requeuing it then put the
   * same song in both places from one write: it sat at the head of the
   * queue where repeat-one could never reach it, and turning repeat off
   * later replayed a song the room had just heard.
   */
  const looped =
    advanced.current !== null &&
    finished !== null &&
    advanced.current.id === finished.id;
  const displaced =
    advanced.current && !looped
      ? [advanced.current, ...advanced.queue]
      : advanced.queue;
  const restFits = extra.slice(0, MUSIC_QUEUE_LIMIT);
  const displacedFits = displaced.slice(0, MUSIC_QUEUE_LIMIT - restFits.length);
  write({
    ...advanced,
    current: track,
    queue: [...restFits, ...displacedFits],
    status: "playing",
    positionMs: 0,
  });
  // What the room already had and no longer has. The incoming tracks take
  // the cap first, so a big add at the end of a track can push most of the
  // queue off, and saying "30 added" without saying that is a lie. The
  // autoplayed rows dropped above are not counted: that drop is on purpose,
  // so the new pick becomes the radio's seed.
  return displaced.length - displacedFits.length;
}

/**
 * `playing-dropped` is `playing` plus the one thing the person cannot see:
 * starting this track put the finished one back at the head of a queue that
 * was already at the cap, so the last row fell off. `addTracks` has always
 * counted that for a list; the single-track path threw the number away and
 * said only "tocando agora".
 */
export type MusicAddOutcome =
  | "playing"
  | "playing-dropped"
  | "queued"
  | "full"
  | "no-session";

export interface MusicAddManyOutcome {
  /** How many went in, the first of them now playing if nothing was. */
  added: number;
  /** How many did not fit under `MUSIC_QUEUE_LIMIT`. */
  dropped: number;
  startedPlaying: boolean;
}

/** Add a list in one write: a playlist or an album. */
export function addTracks(resolved: MusicResolved[]): MusicAddManyOutcome {
  if (!session || resolved.length === 0) {
    return { added: 0, dropped: resolved.length, startedPlaying: false };
  }
  const held = base();
  const minted = resolved
    .map(mintTrack)
    .filter((track): track is MusicTrack => track !== null);
  if (minted.length === 0) {
    return { added: 0, dropped: resolved.length, startedPlaying: false };
  }
  if (currentTrackHasEnded() && held.current) {
    const extra = minted.slice(1);
    const evicted = startNow(minted[0] as MusicTrack, extra);
    const extraFits = Math.min(extra.length, MUSIC_QUEUE_LIMIT);
    return {
      added: 1 + extraFits,
      dropped: extra.length - extraFits + evicted,
      startedPlaying: true,
    };
  }
  let current = held.current;
  let rest = minted;
  let startedPlaying = false;
  if (current === null) {
    current = rest[0] ?? null;
    rest = rest.slice(1);
    startedPlaying = current !== null;
  }
  const room = MUSIC_QUEUE_LIMIT - held.queue.length;
  const fits = rest.slice(0, Math.max(0, room));
  const dropped = rest.length - fits.length;
  const added = fits.length + (startedPlaying ? 1 : 0);
  write({
    ...held,
    current,
    queue: [...held.queue, ...fits],
    status: startedPlaying ? "playing" : held.status,
    positionMs: startedPlaying ? 0 : held.positionMs,
  });
  return { added, dropped, startedPlaying };
}

/** Add a resolved track: starts it when nothing is playing, queues otherwise. */
export function addTrack(resolved: MusicResolved): MusicAddOutcome {
  const track = mintTrack(resolved);
  if (!track) {
    return "no-session";
  }
  const held = base();
  if (held.current === null) {
    write({ ...held, current: track, queue: held.queue, status: "playing", positionMs: 0 });
    return "playing";
  }
  if (currentTrackHasEnded()) {
    return startNow(track) > 0 ? "playing-dropped" : "playing";
  }
  if (held.queue.length >= MUSIC_QUEUE_LIMIT) {
    return "full";
  }
  write({ ...held, queue: [...held.queue, track] });
  return "queued";
}

/** Position defaults to the live player's, through the probe. */
export function setPlaying(playing: boolean, positionMs?: number): void {
  const held = base();
  if (held.current === null) {
    return;
  }
  write({
    ...held,
    status: playing ? "playing" : "paused",
    positionMs: positionMs ?? held.positionMs,
  });
}

export function seekTo(positionMs: number): void {
  const held = base();
  if (held.current === null) {
    return;
  }
  const at = Math.max(0, Math.round(positionMs));
  try {
    seekApply?.(at);
  } catch {
    // the write still has to land so the room can catch up
  }
  write({ ...held, positionMs: at });
}

function restamp(track: MusicTrack): MusicTrack {
  trackSeq += 1;
  const peer = session?.peerId ?? "local";
  return {
    ...track,
    id: `${peer.slice(0, 8)}-${Date.now().toString(36)}-${trackSeq}`,
  };
}

/**
 * Spotify skip-back. Past three seconds, or with nothing in Tocadas, or
 * on repeat-one, restarts the current track. Otherwise the first history
 * row becomes current and the displaced track goes to the front of the
 * queue (the tail is dropped if the queue is already at MUSIC_QUEUE_LIMIT).
 */
export function musicPrevious(): void {
  const held = base();
  if (!held.current) {
    return;
  }
  const previous = held.history[0];
  const restart =
    held.positionMs > MUSIC_RESTART_THRESHOLD_MS ||
    !previous ||
    held.repeat === "one" ||
    previous.videoId === held.current.videoId;
  if (restart) {
    seekTo(0);
    return;
  }
  write({
    ...held,
    current: restamp(previous),
    queue: [held.current, ...held.queue].slice(0, MUSIC_QUEUE_LIMIT),
    history: held.history.slice(1),
    status: "playing",
    positionMs: 0,
    skipVotes: [],
  });
}

/** Position-only sample while playing, so a late joiner lands close. */
export function reportPosition(positionMs: number, durationMs?: number): void {
  const held = snapshot.state;
  if (!held || held.status !== "playing" || !session) {
    return;
  }
  const next = base();
  /*
   * The duration is what lets the server tell "the track ran out" from a
   * skip. It is the other operand of that gate, so the server takes it
   * only from a manager or from whoever put the track on, and filling it
   * from anybody else would earn a `forced` correction every ten seconds.
   */
  const mine = next.current?.addedByUserId === session.userId;
  if (
    next.current &&
    next.current.durationMs === null &&
    durationMs &&
    durationMs > 0 &&
    (mine || session.canManage?.() === true)
  ) {
    next.current = { ...next.current, durationMs: Math.round(durationMs) };
  }
  write({ ...next, positionMs: Math.max(0, Math.round(positionMs)) });
}

/**
 * Move to the next track. `endedTrackId` guards the automatic advance: a
 * player that reports the end of a track the room has already moved past
 * must not skip the one now playing.
 */
export function advance(endedTrackId?: string): void {
  const held = snapshot.state;
  if (!held) {
    return;
  }
  if (endedTrackId && held.current?.id !== endedTrackId) {
    return;
  }
  write(musicAdvance({ ...held, positionMs: livePositionMs(held) }));
}

export function voteSkip(roomSize: number): void {
  if (!session) {
    return;
  }
  const held = snapshot.state;
  if (!held?.current) {
    return;
  }
  const votes = held.skipVotes ?? [];
  if (votes.includes(session.userId)) {
    return;
  }
  const nextVotes = [...votes, session.userId];
  if (new Set(nextVotes).size >= musicSkipVotesNeeded(roomSize)) {
    write(musicAdvance({ ...held, positionMs: livePositionMs(held) }));
    return;
  }
  write({ ...base(), skipVotes: nextVotes });
}

export function setRepeat(mode: MusicRepeat): void {
  write({ ...base(), repeat: mode });
}

export function shuffle(): void {
  const held = base();
  const queue = [...held.queue];
  for (let i = queue.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const current = queue[i]!;
    queue[i] = queue[j]!;
    queue[j] = current;
  }
  write({ ...held, queue });
}

export function setOpenControls(on: boolean): void {
  write({ ...base(), openControls: on });
}

export function setAutoplay(on: boolean): void {
  const held = base();
  if (on) {
    write({ ...held, autoplay: true });
    return;
  }
  abandonAutoplayFill();
  write({
    ...held,
    autoplay: false,
    queue: dropAutoplayed(held.queue),
  });
}

/**
 * How long a machine that is not the actor waits before fetching a
 * related track, so the actor (if still seated) wins. A room whose
 * actor left still continues.
 */
export const AUTOPLAY_FALLBACK_MS = 1500;

export function shouldAutoplayOnEnd(state: MusicState | null): boolean {
  return (
    state !== null &&
    state.current !== null &&
    state.autoplay === true &&
    state.queue.length === 0 &&
    (state.repeat ?? "off") === "off"
  );
}

/** Upcoming related rows to keep queued while autoplay is on. */
export const AUTOPLAY_BUFFER = 3;
const AUTOPLAY_FILL_FETCH_CAP = 3;

export function shouldFillAutoplayBuffer(state: MusicState | null): boolean {
  if (
    state === null ||
    state.current === null ||
    state.autoplay !== true ||
    (state.repeat ?? "off") !== "off"
  ) {
    return false;
  }
  const autoplayed = state.queue.filter((track) => track.autoplayed).length;
  return autoplayed < AUTOPLAY_BUFFER && state.queue.length < MUSIC_QUEUE_LIMIT;
}

export function autoplayBufferSeed(state: MusicState): string | null {
  return state.queue.at(-1)?.videoId ?? state.current?.videoId ?? null;
}

function appendAutoplayed(picks: MusicResolved[], gen: number): void {
  if (gen !== fillGeneration || picks.length === 0) {
    return;
  }
  if (!shouldFillAutoplayBuffer(snapshot.state)) {
    return;
  }
  const held = base();
  const minted: MusicTrack[] = [];
  for (const pick of picks) {
    const track = mintTrack(pick);
    if (track) {
      minted.push({ ...track, autoplayed: true });
    }
  }
  const room = MUSIC_QUEUE_LIMIT - held.queue.length;
  const fits = minted.slice(0, Math.max(0, room));
  if (fits.length === 0) {
    return;
  }
  write({ ...held, queue: [...held.queue, ...fits] });
}

/**
 * Keep a short buffer of related tracks on the queue so ENDED can
 * `advance()` instead of waiting on InnerTube. The embed only starts
 * this as the actor. The non-actor wait is for callers that still
 * need a fallback, including tests.
 */
export async function fillAutoplayBuffer(
  isActor: boolean,
  fetchRelated: (videoId: string) => Promise<MusicResolved[]>,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
): Promise<void> {
  const gen = ++fillGeneration;
  if (!isActor) {
    await wait(AUTOPLAY_FALLBACK_MS);
    if (gen !== fillGeneration) {
      return;
    }
  }
  let fetches = 0;
  while (shouldFillAutoplayBuffer(snapshot.state) && fetches < AUTOPLAY_FILL_FETCH_CAP) {
    if (gen !== fillGeneration) {
      return;
    }
    const held = snapshot.state;
    if (!held) {
      return;
    }
    const channelId = session?.channelId ?? null;
    const seed = autoplayBufferSeed(held);
    if (!seed || !channelId) {
      return;
    }
    fetches += 1;
    let related: MusicResolved[];
    try {
      related = await fetchRelated(seed);
    } catch {
      return;
    }
    const next = snapshot.state;
    if (
      gen !== fillGeneration ||
      session?.channelId !== channelId ||
      !next ||
      autoplayBufferSeed(next) !== seed ||
      !shouldFillAutoplayBuffer(next)
    ) {
      return;
    }
    const needed = Math.min(
      AUTOPLAY_BUFFER - next.queue.filter((track) => track.autoplayed).length,
      MUSIC_QUEUE_LIMIT - next.queue.length,
    );
    const picks = musicAutoplayCandidates(related, next, needed);
    if (picks.length === 0) {
      return;
    }
    appendAutoplayed(picks, gen);
  }
}

/**
 * Mint the related pick under this machine's name and write the advance
 * shape `musicWriteAllowed` accepts for a member: own track, autoplayed,
 * playing at 0, history as `musicAdvance` would, votes cleared.
 */
export function autoplayAdvance(endedTrackId: string, pick: MusicResolved): void {
  const held = snapshot.state;
  if (!held?.current || held.current.id !== endedTrackId) {
    return;
  }
  const track = mintTrack(pick);
  if (!track) {
    return;
  }
  const advanced = musicAdvance({ ...held, positionMs: livePositionMs(held) });
  write({
    ...advanced,
    current: { ...track, autoplayed: true },
    queue: [],
    status: "playing",
    positionMs: 0,
  });
}

/**
 * THE SKIP BUTTON, WHICH HAS TO KNOW ABOUT THE INFINITY TOO.
 *
 * A track running out goes through `onTrackEnded`, which asks for a
 * related pick before it gives up on the room. Skip went straight to
 * `advance`, and `musicAdvance` ends the room on an empty queue whatever
 * `autoplay` says: turning the mode on and pressing skip before the
 * buffer had filled ended the queue with "keep playing similar songs"
 * switched on, which is the opposite of what the switch promises.
 *
 * So a skip into an empty queue with the mode on looks for a pick first
 * and only ends the room when there is genuinely nothing to play. With
 * anything queued it stays what it was, one write and no lookup.
 */
export async function skipToNext(
  fetchRelated: (videoId: string) => Promise<MusicResolved[]>,
): Promise<void> {
  const held = snapshot.state;
  if (!held?.current) {
    return;
  }
  if (!shouldAutoplayOnEnd(held)) {
    advance();
    return;
  }
  const trackId = held.current.id;
  const videoId = held.current.videoId;
  try {
    const related = await fetchRelated(videoId);
    // The room may have moved on while we were asking, and the person who
    // pressed skip is not necessarily the only one pressing things.
    if (snapshot.state?.current?.id !== trackId) {
      return;
    }
    const pick = musicAutoplayCandidate(related, snapshot.state);
    if (pick) {
      autoplayAdvance(trackId, pick);
      return;
    }
  } catch {
    // Offline, rate limited, upstream down: an ordinary end is better than
    // a skip that does nothing at all.
  }
  if (snapshot.state?.current?.id === trackId) {
    advance(trackId);
  }
}

export async function onTrackEnded(
  endedTrackId: string,
  isActor: boolean,
  fetchRelated: (videoId: string) => Promise<MusicResolved[]>,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
): Promise<void> {
  const held = snapshot.state;
  if (!held || held.current?.id !== endedTrackId) {
    return;
  }
  markCurrentEnded(endedTrackId);
  if (!shouldAutoplayOnEnd(held)) {
    advance(endedTrackId);
    return;
  }
  if (!isActor) {
    await wait(AUTOPLAY_FALLBACK_MS);
    if (snapshot.state?.current?.id !== endedTrackId) {
      return;
    }
  }
  const videoId = snapshot.state?.current?.videoId;
  if (!videoId) {
    advance(endedTrackId);
    return;
  }
  try {
    const related = await fetchRelated(videoId);
    if (snapshot.state?.current?.id !== endedTrackId) {
      return;
    }
    const pick = musicAutoplayCandidate(related, snapshot.state);
    if (!pick) {
      advance(endedTrackId);
      return;
    }
    autoplayAdvance(endedTrackId, pick);
  } catch {
    if (snapshot.state?.current?.id === endedTrackId) {
      advance(endedTrackId);
    }
  }
}

export function readdFromHistory(trackId: string): MusicAddOutcome {
  const entry = snapshot.state?.history?.find((track) => track.id === trackId);
  if (!entry) {
    return "no-session";
  }
  return addTrack({
    provider: entry.provider,
    videoId: entry.videoId,
    title: entry.title,
    sourceUrl: entry.sourceUrl,
    thumbnailUrl: entry.thumbnailUrl,
    durationMs: entry.durationMs,
  });
}

export function removeFromQueue(trackId: string): void {
  const held = base();
  write({ ...held, queue: held.queue.filter((track) => track.id !== trackId) });
}

export function moveInQueue(trackId: string, direction: -1 | 1): void {
  const held = base();
  const index = held.queue.findIndex((track) => track.id === trackId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= held.queue.length) {
    return;
  }
  const queue = [...held.queue];
  const [track] = queue.splice(index, 1);
  queue.splice(target, 0, track as MusicTrack);
  write({ ...held, queue });
}

/** Drop a track at a position in the queue (the drag-and-drop write). */
export function moveTrackTo(trackId: string, targetIndex: number): void {
  const held = base();
  const from = held.queue.findIndex((track) => track.id === trackId);
  if (from < 0) {
    return;
  }
  const queue = [...held.queue];
  const [track] = queue.splice(from, 1);
  const to = Math.max(0, Math.min(queue.length, targetIndex > from ? targetIndex - 1 : targetIndex));
  if (to === from) {
    return;
  }
  queue.splice(to, 0, track as MusicTrack);
  write({ ...held, queue });
}

/** Tear the whole thing down for the room. */
export function stopMusic(): void {
  if (!session) {
    return;
  }
  abandonAutoplayFill();
  localEndedTrackId = null;
  set(null, session.channelId);
  session.send(null);
}

/** Where the room believes the track is right now, in ms. */
export function expectedPositionMs(snap: MusicSnapshot, now = Date.now()): number {
  const state = snap.state;
  if (!state || !state.current) {
    return 0;
  }
  if (state.status !== "playing") {
    return state.positionMs;
  }
  return state.positionMs + Math.max(0, now - snap.receivedAt);
}
