import type { JamFrame, JamSongSummary, JamTrack, JamVoteResponse } from "@pqp/shared";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { fetchJamSong, fetchJamSongs } from "@/lib/jam-api";
import { subscribeJamFrames, subscribeJamReconnected } from "@/lib/jam-frames";
import {
  EMPTY_JAM_CHANNEL,
  applyJamFrame,
  mergeFirstPage,
  withDetail,
  withVote,
  type JamChannelState,
  type JamDetail,
  type ReadChanges,
} from "@/lib/jam-state";

/**
 * The jam store: one `JamChannelState` per channel the client has asked about,
 * fed by the list and detail reads and kept live by the jam frames.
 *
 * It outlives the wall on purpose. The sidebar row reads a channel's song count
 * and news from here without the wall being open, and opening the wall paints
 * from what is held while it asks again.
 *
 * WHAT IT HOLDS BELONGS TO ONE ACCOUNT. `setJamViewer` empties it when the
 * signed-in account changes, so a second account on the same browser never sees
 * the first one's songs, and an open wall asks again every time it opens, so a
 * channel somebody lost access to stops showing what was held (a refusal from
 * the server drops the held state for that channel or song).
 *
 * A READ IS A SNAPSHOT, A FRAME IS NEWER. While any read is out the store keeps a
 * journal of what frames and local writes changed (`ReadChanges`), and an answer
 * is merged with what happened since it was asked for, instead of replacing it.
 */

const PAGE = 50;

const channels = new Map<string, JamChannelState>();
const listeners = new Set<() => void>();
const loads = new Map<string, Promise<void>>();
const detailLoads = new Map<string, Promise<JamDetail | null>>();
let wired = false;
let viewer: string | null = null;
/** Bumped when the store is emptied: an answer asked for before it is not ours any more. */
let epoch = 0;

let version = 0;

function emit(): void {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

function write(channelId: string, next: JamChannelState): void {
  channels.set(channelId, next);
  emit();
}

function read(channelId: string): JamChannelState {
  return channels.get(channelId) ?? EMPTY_JAM_CHANNEL;
}

// ---- the journal: what changed while a read was out -------------------------

interface JournalEntry<T> {
  seq: number;
  value: T | null;
}

const songJournal = new Map<string, Map<string, JournalEntry<JamSongSummary>>>();
const trackJournal = new Map<string, Map<string, JournalEntry<JamTrack>>>();
let seq = 0;
/** Reads in flight per channel: only these channels keep a journal. */
const readsOut = new Map<string, number>();

function journalFor<T>(
  all: Map<string, Map<string, JournalEntry<T>>>,
  channelId: string,
): Map<string, JournalEntry<T>> {
  let one = all.get(channelId);
  if (!one) {
    one = new Map();
    all.set(channelId, one);
  }
  return one;
}

function record(channelId: string, frame: JamFrame): void {
  if (!readsOut.get(channelId)) {
    return;
  }
  seq += 1;
  const songs = journalFor(songJournal, channelId);
  const tracks = journalFor(trackJournal, channelId);
  switch (frame.type) {
    case "jam-song-created":
    case "jam-song-updated":
      songs.set(frame.song.id, { seq, value: frame.song });
      break;
    case "jam-song-deleted":
      songs.set(frame.songId, { seq, value: null });
      break;
    case "jam-track-added":
    case "jam-track-updated":
      songs.set(frame.song.id, { seq, value: frame.song });
      tracks.set(frame.track.id, { seq, value: frame.track });
      break;
    case "jam-track-deleted":
      songs.set(frame.song.id, { seq, value: frame.song });
      tracks.set(frame.trackId, { seq, value: null });
      break;
    case "jam-track-votes":
      break;
  }
}

/** Starts a read: what changed from here on is what the answer must not undo. */
function beginRead(channelId: string): number {
  readsOut.set(channelId, (readsOut.get(channelId) ?? 0) + 1);
  return seq;
}

function changesSince(channelId: string, since: number): ReadChanges {
  const pick = <T,>(all: Map<string, Map<string, JournalEntry<T>>>) =>
    new Map(
      [...(all.get(channelId) ?? new Map<string, JournalEntry<T>>())]
        .filter(([, entry]) => entry.seq > since)
        .map(([id, entry]) => [id, entry.value] as const),
    );
  return { songs: pick(songJournal), tracks: pick(trackJournal) };
}

function endRead(channelId: string): void {
  const left = (readsOut.get(channelId) ?? 0) - 1;
  if (left > 0) {
    readsOut.set(channelId, left);
    return;
  }
  readsOut.delete(channelId);
  songJournal.delete(channelId);
  trackJournal.delete(channelId);
}

function refused(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 403 || status === 404;
}

// ---- frames and reconnects ---------------------------------------------------

function wire(): void {
  if (wired) {
    return;
  }
  wired = true;
  subscribeJamFrames((frame: JamFrame) => {
    const state = channels.get(frame.channelId);
    if (state) {
      record(frame.channelId, frame);
      write(frame.channelId, applyJamFrame(state, frame));
    }
  });
  subscribeJamReconnected(() => {
    // One at a time with a breath between: a reconnect is when everybody asks.
    const ids = [...channels.keys()];
    void (async () => {
      for (const channelId of ids) {
        await loadJamChannel(channelId, { force: true });
        await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 350));
      }
    })();
  });
}

/**
 * Tell the store which account it is holding for; another account empties it.
 *
 * Safe to call while rendering, and meant to be: the app calls it in its render
 * body, so the screens under it never paint what the previous account held (an
 * effect would run after that paint) and a load they start already belongs to
 * the new account. The listeners are told after the render, and `useJamStoreEpoch`
 * moves, which is what makes a mounted wall ask again.
 */
export function setJamViewer(userId: string | null): void {
  if (userId === viewer) {
    return;
  }
  viewer = userId;
  resetJamStoreForTests();
  queueMicrotask(emit);
}

/** Read the first page of a channel's songs. Quiet when it already holds some, unless forced. */
export function loadJamChannel(channelId: string, options: { force?: boolean } = {}): Promise<void> {
  wire();
  const held = read(channelId);
  if (!options.force && held.status === "ready") {
    return Promise.resolve();
  }
  const pending = loads.get(channelId);
  if (pending) {
    return pending;
  }
  if (held.status === "idle" || held.status === "error") {
    write(channelId, { ...held, status: "loading" });
  }
  const since = beginRead(channelId);
  const mine = epoch;
  const run = fetchJamSongs(channelId, { sort: "activity", limit: PAGE })
    .then((page) => {
      if (mine !== epoch) {
        return;
      }
      write(channelId, mergeFirstPage(read(channelId), page, changesSince(channelId, since)));
    })
    .catch((error: unknown) => {
      if (mine !== epoch) {
        return;
      }
      if (refused(error)) {
        // No longer ours to show.
        channels.delete(channelId);
        write(channelId, { ...EMPTY_JAM_CHANNEL, status: "error" });
        return;
      }
      const now = read(channelId);
      // Stale beats blank: a wall that was showing songs keeps them.
      write(channelId, { ...now, status: now.songs.length > 0 ? "ready" : "error" });
    })
    .finally(() => {
      endRead(channelId);
      // Not a newer load's entry: the store may have been emptied meanwhile.
      if (loads.get(channelId) === run) {
        loads.delete(channelId);
      }
    });
  loads.set(channelId, run);
  return run;
}

export async function loadMoreJamSongs(channelId: string): Promise<void> {
  const held = read(channelId);
  if (!held.nextCursor) {
    return;
  }
  try {
    const page = await fetchJamSongs(channelId, { sort: "activity", limit: PAGE, cursor: held.nextCursor });
    const now = read(channelId);
    const known = new Set(now.songs.map((song) => song.id));
    write(channelId, {
      ...now,
      songs: [...now.songs, ...page.songs.filter((song) => !known.has(song.id))],
      nextCursor: page.nextCursor,
    });
  } catch {
    // The "more" stays on the wall to be pressed again.
  }
}

/**
 * The wall's way of filling a tile in: the same read, a few at a time. A tile
 * asks when it comes near the screen, so a wall of fifty songs makes the
 * requests for what is being looked at, three in flight at most.
 */
let lazyActive = 0;
const lazyQueue: Array<() => void> = [];

export function loadJamDetailLazy(channelId: string, songId: string): void {
  if (read(channelId).details[songId]) {
    return;
  }
  const run = () => {
    lazyActive += 1;
    void loadJamDetail(channelId, songId).finally(() => {
      lazyActive -= 1;
      lazyQueue.shift()?.();
    });
  };
  if (lazyActive < 3) {
    run();
  } else {
    lazyQueue.push(run);
  }
}

/** Read one song (its tracks and what the viewer may do) into the store. */
export function loadJamDetail(
  channelId: string,
  songId: string,
  options: { force?: boolean } = {},
): Promise<JamDetail | null> {
  wire();
  const held = read(channelId).details[songId];
  if (held && !options.force && !held.viewerStale) {
    return Promise.resolve(held);
  }
  const pending = detailLoads.get(songId);
  if (pending) {
    return pending;
  }
  const since = beginRead(channelId);
  const mine = epoch;
  const run = fetchJamSong(songId)
    .then((response) => {
      if (mine !== epoch) {
        return null;
      }
      write(channelId, withDetail(read(channelId), response, changesSince(channelId, since)));
      return read(channelId).details[songId] ?? null;
    })
    .catch((error: unknown) => {
      if (mine === epoch && refused(error)) {
        const now = read(channelId);
        const { [songId]: _gone, ...details } = now.details;
        write(channelId, { ...now, songs: now.songs.filter((one) => one.id !== songId), details });
      }
      return null;
    })
    .finally(() => {
      endRead(channelId);
      if (detailLoads.get(songId) === run) {
        detailLoads.delete(songId);
      }
    });
  detailLoads.set(songId, run);
  return run;
}

/** What the answer to a write already says, applied before its frame arrives. */
export function applyJamWrite(channelId: string, frame: JamFrame): void {
  wire();
  record(channelId, frame);
  write(channelId, applyJamFrame(read(channelId), frame));
}

export function applyJamVote(channelId: string, vote: JamVoteResponse): void {
  write(channelId, withVote(read(channelId), vote));
}

export function putJamSongOnWall(channelId: string, song: JamSongSummary): void {
  applyJamWrite(channelId, { type: "jam-song-created", channelId, song });
}

export function putJamTrackInSong(channelId: string, song: JamSongSummary, track: JamTrack): void {
  applyJamWrite(channelId, { type: "jam-track-added", channelId, song, track });
}

/** What the sidebar says about a jam channel's songs. */
export function readJamChannel(channelId: string): JamChannelState {
  return read(channelId);
}

/** A number that changes whenever any channel's state does: for deriving across channels. */
export function useJamStoreVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => version,
    () => 0,
  );
}

/** Moves when the store is emptied for another account: a screen that asked before must ask again. */
export function useJamStoreEpoch(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => epoch,
    () => 0,
  );
}

/**
 * A channel's state for a screen. Opening a wall asks again even when something
 * is held (stale-while-revalidate): what was held paints at once, and the answer
 * is the authority on what this account may see.
 */
export function useJamChannel(channelId: string | null): JamChannelState {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const state = useSyncExternalStore(
    subscribe,
    () => (channelId ? read(channelId) : EMPTY_JAM_CHANNEL),
    () => EMPTY_JAM_CHANNEL,
  );
  const storeEpoch = useJamStoreEpoch();
  useEffect(() => {
    if (channelId) {
      void loadJamChannel(channelId, { force: true });
    }
  }, [channelId, storeEpoch]);
  return state;
}

/** Empties the store (a different account, and the tests). */
export function resetJamStoreForTests(): void {
  channels.clear();
  loads.clear();
  detailLoads.clear();
  songJournal.clear();
  trackJournal.clear();
  seq = 0;
  readsOut.clear();
  epoch += 1;
}
