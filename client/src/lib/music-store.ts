import { useSyncExternalStore } from "react";
import {
  MUSIC_QUEUE_LIMIT,
  musicWriteIsStale,
  type MusicResolved,
  type MusicState,
  type MusicTrack,
} from "@pqp/shared";

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
}

export interface MusicSnapshot {
  channelId: string | null;
  state: MusicState | null;
  /** This machine's clock when `state` arrived. Drift is measured from here. */
  receivedAt: number;
}

let session: MusicSession | null = null;
let snapshot: MusicSnapshot = { channelId: null, state: null, receivedAt: 0 };
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function set(state: MusicState | null, channelId: string | null) {
  snapshot = { channelId, state, receivedAt: Date.now() };
  emit();
}

export function setMusicSession(next: MusicSession | null): void {
  session = next;
  if (next === null) {
    set(null, null);
  } else if (snapshot.channelId !== next.channelId) {
    set(null, next.channelId);
  }
}

/** A `music` frame from the server (join, echo, another person's write). */
export function receiveMusic(channelId: string, state: MusicState | null): void {
  if (session && session.channelId !== channelId) {
    return;
  }
  if (state !== null && musicWriteIsStale(snapshot.state, state)) {
    return;
  }
  set(state, channelId);
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

export function resetMusicStoreForTests(): void {
  session = null;
  positionProbe = null;
  snapshot = { channelId: null, state: null, receivedAt: 0 };
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

export type MusicAddOutcome = "playing" | "queued" | "full" | "no-session";

/** Add a resolved track: starts it when nothing is playing, queues otherwise. */
export function addTrack(resolved: MusicResolved): MusicAddOutcome {
  const track = mintTrack(resolved);
  if (!track) {
    return "no-session";
  }
  const held = base();
  if (held.current === null) {
    write({ current: track, queue: held.queue, status: "playing", positionMs: 0 });
    return "playing";
  }
  if (held.queue.length >= MUSIC_QUEUE_LIMIT) {
    return "full";
  }
  write({ ...held, queue: [...held.queue, track] });
  return "queued";
}

export function setPlaying(playing: boolean, positionMs: number): void {
  const held = base();
  if (held.current === null) {
    return;
  }
  write({ ...held, status: playing ? "playing" : "paused", positionMs });
}

export function seekTo(positionMs: number): void {
  const held = base();
  if (held.current === null) {
    return;
  }
  write({ ...held, positionMs: Math.max(0, Math.round(positionMs)) });
}

/** Position-only sample while playing, so a late joiner lands close. */
export function reportPosition(positionMs: number): void {
  const held = snapshot.state;
  if (!held || held.status !== "playing" || !session) {
    return;
  }
  write({ ...base(), positionMs: Math.max(0, Math.round(positionMs)) });
}

/**
 * Move to the next track. `endedTrackId` guards the automatic advance: a
 * player that reports the end of a track the room has already moved past
 * must not skip the one now playing.
 */
export function advance(endedTrackId?: string): void {
  const held = base();
  if (endedTrackId && held.current?.id !== endedTrackId) {
    return;
  }
  const [next, ...rest] = held.queue;
  write({
    current: next ?? null,
    queue: rest,
    status: next ? "playing" : "paused",
    positionMs: 0,
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

/** Tear the whole thing down for the room. */
export function stopMusic(): void {
  if (!session) {
    return;
  }
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
