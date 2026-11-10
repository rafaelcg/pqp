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
/**
 * The identity epoch: bumped when the store is emptied (another account, sign-out).
 * EVERY read and every write that completes later carries the epoch it started in,
 * and one that comes back with a stale epoch is dropped: it may not write state,
 * and may not touch the bookkeeping (journal registrations, pending slots) of the
 * epoch that replaced it.
 */
let epoch = 0;

/** The epoch now, for a caller that will write after an await (see `applyJamWrite`). */
export function jamStoreEpoch(): number {
  return epoch;
}

/**
 * How long what was read under this identity may answer a quiet ask (a sidebar
 * refresh, a tile) without asking the server again. Past it, even a quiet ask goes
 * to the API, so a channel or song this account lost access to cannot go on
 * painting from the store for longer than this. Opening a wall or a song asks
 * regardless, and every refusal drops what was held.
 */
export const JAM_FRESH_MS = 60_000;
/** When each channel (`c:<id>`) and song detail (`d:<id>`) was last confirmed by the server in this epoch. */
const verifiedAt = new Map<string, number>();

function fresh(key: string): boolean {
  const at = verifiedAt.get(key);
  return at !== undefined && Date.now() - at < JAM_FRESH_MS;
}

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

/** The viewer's own votes cast while a read of the channel was out. */
const voteJournal = new Map<string, Map<string, JournalEntry<boolean>>>();

function recordVote(channelId: string, trackId: string, voted: boolean): void {
  if (!readsOut.get(channelId)) {
    return;
  }
  seq += 1;
  journalFor(voteJournal, channelId).set(trackId, { seq, value: voted });
}

/** Bumped when one channel is dropped (see `dropJamChannels`): a read of it from before is not ours any more. */
const gens = new Map<string, number>();

/** A read in flight: which channel, which identity epoch and which generation of the channel asked. */
interface ReadToken {
  channelId: string;
  epoch: number;
  gen: number;
  since: number;
}

/** Starts a read: what changed from here on is what the answer must not undo. */
function beginRead(channelId: string): ReadToken {
  readsOut.set(channelId, (readsOut.get(channelId) ?? 0) + 1);
  return { channelId, epoch, gen: gens.get(channelId) ?? 0, since: seq };
}

/** Whether an answer for this read may still be applied: same identity, channel not dropped since. */
function current(token: ReadToken): boolean {
  return token.epoch === epoch && token.gen === (gens.get(token.channelId) ?? 0);
}

function changesSince(token: ReadToken): ReadChanges {
  const { channelId, since } = token;
  const pick = <T,>(all: Map<string, Map<string, JournalEntry<T>>>) =>
    new Map(
      [...(all.get(channelId) ?? new Map<string, JournalEntry<T>>())]
        .filter(([, entry]) => entry.seq > since)
        .map(([id, entry]) => [id, entry.value] as const),
    );
  const votes = new Map<string, boolean>();
  for (const [trackId, value] of pick(voteJournal)) {
    if (value !== null) {
      votes.set(trackId, value);
    }
  }
  return { songs: pick(songJournal), tracks: pick(trackJournal), votes };
}

/**
 * Ends a read. Only a read of THIS epoch holds a registration: the reset that moved
 * the epoch already cleared them all, and a stale read ending late must not take
 * one from the new epoch's read of the same channel.
 */
function endRead(token: ReadToken): void {
  if (!current(token)) {
    return;
  }
  const { channelId } = token;
  const left = (readsOut.get(channelId) ?? 0) - 1;
  if (left > 0) {
    readsOut.set(channelId, left);
    return;
  }
  readsOut.delete(channelId);
  songJournal.delete(channelId);
  trackJournal.delete(channelId);
  voteJournal.delete(channelId);
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
    const mine = epoch;
    void (async () => {
      for (const channelId of ids) {
        if (mine !== epoch || !channels.has(channelId)) {
          return; // another account now, or the channel was dropped meanwhile
        }
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
  // A quiet ask is answered from the store only when the SERVER confirmed this
  // channel to this identity within `JAM_FRESH_MS`; anything older goes to the API.
  if (!options.force && held.status === "ready" && fresh(`c:${channelId}`)) {
    return Promise.resolve();
  }
  const pending = loads.get(channelId);
  if (pending) {
    return pending;
  }
  if (held.status === "idle" || held.status === "error") {
    write(channelId, { ...held, status: "loading" });
  }
  const token = beginRead(channelId);
  const run = fetchJamSongs(channelId, { sort: "activity", limit: PAGE })
    .then((page) => {
      if (!current(token)) {
        return;
      }
      write(channelId, mergeFirstPage(read(channelId), page, changesSince(token)));
      verifiedAt.set(`c:${channelId}`, Date.now());
    })
    .catch((error: unknown) => {
      if (!current(token)) {
        return;
      }
      if (refused(error)) {
        // No longer ours to show.
        channels.delete(channelId);
        verifiedAt.delete(`c:${channelId}`);
        write(channelId, { ...EMPTY_JAM_CHANNEL, status: "error" });
        return;
      }
      const now = read(channelId);
      // Stale beats blank: a wall that was showing songs keeps them.
      write(channelId, { ...now, status: now.songs.length > 0 ? "ready" : "error" });
    })
    .finally(() => {
      endRead(token);
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
  const mine = epoch;
  const gen = gens.get(channelId) ?? 0;
  try {
    const page = await fetchJamSongs(channelId, { sort: "activity", limit: PAGE, cursor: held.nextCursor });
    if (mine !== epoch || gen !== (gens.get(channelId) ?? 0)) {
      return; // asked by an identity the store no longer holds for, or for a channel since dropped
    }
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
  if (read(channelId).details[songId] && fresh(`d:${songId}`)) {
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
  // As for the list: only what the server confirmed to this identity recently
  // answers without asking.
  if (held && !options.force && !held.viewerStale && fresh(`d:${songId}`)) {
    return Promise.resolve(held);
  }
  const pending = detailLoads.get(songId);
  if (pending) {
    return pending;
  }
  const token = beginRead(channelId);
  const run = fetchJamSong(songId)
    .then((response) => {
      if (!current(token)) {
        return null;
      }
      write(channelId, withDetail(read(channelId), response, changesSince(token)));
      verifiedAt.set(`d:${songId}`, Date.now());
      return read(channelId).details[songId] ?? null;
    })
    .catch((error: unknown) => {
      if (current(token) && refused(error)) {
        const now = read(channelId);
        const { [songId]: _gone, ...details } = now.details;
        verifiedAt.delete(`d:${songId}`);
        write(channelId, { ...now, songs: now.songs.filter((one) => one.id !== songId), details });
      }
      return null;
    })
    .finally(() => {
      endRead(token);
      if (detailLoads.get(songId) === run) {
        detailLoads.delete(songId);
      }
    });
  detailLoads.set(songId, run);
  return run;
}

/** What the answer to a write already says, applied before its frame arrives. */
export function applyJamWrite(channelId: string, frame: JamFrame, asked?: number): void {
  if (asked !== undefined && asked !== epoch) {
    return; // the answer to a write another identity made
  }
  wire();
  record(channelId, frame);
  write(channelId, applyJamFrame(read(channelId), frame));
}

export function applyJamVote(channelId: string, vote: JamVoteResponse, asked?: number): void {
  if (asked !== undefined && asked !== epoch) {
    return;
  }
  recordVote(channelId, vote.trackId, vote.voted);
  write(channelId, withVote(read(channelId), vote));
}

export function putJamSongOnWall(channelId: string, song: JamSongSummary, asked?: number): void {
  applyJamWrite(channelId, { type: "jam-song-created", channelId, song }, asked);
}

export function putJamTrackInSong(channelId: string, song: JamSongSummary, track: JamTrack, asked?: number): void {
  applyJamWrite(channelId, { type: "jam-track-added", channelId, song, track }, asked);
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

/**
 * Forget these channels: the person can no longer see them (the channel left the
 * server's list, they were removed from the server, the jam flag went off). What
 * was held is gone at once, not at the next read, and a read that is out for one
 * of them is not allowed to bring it back.
 */
export function dropJamChannels(channelIds: Iterable<string>): void {
  let changed = false;
  for (const channelId of channelIds) {
    const held = channels.get(channelId);
    if (held) {
      for (const songId of Object.keys(held.details)) {
        verifiedAt.delete(`d:${songId}`);
        detailLoads.delete(songId);
      }
      changed = true;
    }
    channels.delete(channelId);
    verifiedAt.delete(`c:${channelId}`);
    loads.delete(channelId);
    readsOut.delete(channelId);
    songJournal.delete(channelId);
    trackJournal.delete(channelId);
    voteJournal.delete(channelId);
    gens.set(channelId, (gens.get(channelId) ?? 0) + 1);
  }
  if (changed) {
    emit();
  }
}


/** Empties the store for another account, a sign-out, and the tests. */
export function resetJamStoreForTests(): void {
  channels.clear();
  loads.clear();
  detailLoads.clear();
  songJournal.clear();
  trackJournal.clear();
  voteJournal.clear();
  verifiedAt.clear();
  gens.clear();

  lazyQueue.length = 0;
  seq = 0;
  readsOut.clear();
  epoch += 1;
}
