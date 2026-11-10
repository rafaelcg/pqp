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
} from "@/lib/jam-state";

/**
 * The jam store: one `JamChannelState` per channel the client has asked about,
 * fed by the list and detail reads and kept live by the jam frames.
 *
 * It outlives the wall on purpose. The sidebar row reads a channel's song count
 * and news from here without the wall being open, and opening the wall paints
 * from what is held while it asks again.
 */

const PAGE = 50;

const channels = new Map<string, JamChannelState>();
const listeners = new Set<() => void>();
const loads = new Map<string, Promise<void>>();
let wired = false;

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

function wire(): void {
  if (wired) {
    return;
  }
  wired = true;
  subscribeJamFrames((frame: JamFrame) => {
    const state = channels.get(frame.channelId);
    if (state) {
      write(frame.channelId, applyJamFrame(state, frame));
    }
  });
  subscribeJamReconnected(() => {
    for (const channelId of channels.keys()) {
      void loadJamChannel(channelId, { force: true });
    }
  });
}

/** Read the first page of a channel's songs. Quiet when it already holds some. */
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
  const run = fetchJamSongs(channelId, { sort: "activity", limit: PAGE })
    .then((page) => {
      write(channelId, mergeFirstPage(read(channelId), page));
    })
    .catch(() => {
      const now = read(channelId);
      // Stale beats blank: a wall that was showing songs keeps them.
      write(channelId, { ...now, status: now.songs.length > 0 ? "ready" : "error" });
    })
    .finally(() => {
      loads.delete(channelId);
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

const detailLoads = new Map<string, Promise<JamDetail | null>>();

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
  const run = fetchJamSong(songId)
    .then((response) => {
      write(channelId, withDetail(read(channelId), response));
      return read(channelId).details[songId] ?? null;
    })
    .catch(() => null)
    .finally(() => {
      detailLoads.delete(songId);
    });
  detailLoads.set(songId, run);
  return run;
}

/** What the answer to a write already says, applied before its frame arrives. */
export function applyJamWrite(channelId: string, frame: JamFrame): void {
  wire();
  write(channelId, applyJamFrame(read(channelId), frame));
}

export function applyJamVote(channelId: string, vote: JamVoteResponse): void {
  write(channelId, withVote(read(channelId), vote));
}

export function putJamSongOnWall(channelId: string, song: JamSongSummary): void {
  wire();
  write(
    channelId,
    applyJamFrame(read(channelId), { type: "jam-song-created", channelId, song }),
  );
}

export function putJamTrackInSong(channelId: string, song: JamSongSummary, track: JamTrack): void {
  wire();
  write(
    channelId,
    applyJamFrame(read(channelId), { type: "jam-track-added", channelId, song, track }),
  );
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
  useEffect(() => {
    if (channelId) {
      void loadJamChannel(channelId);
    }
  }, [channelId]);
  return state;
}

/** Test seam. */
export function resetJamStoreForTests(): void {
  channels.clear();
  loads.clear();
  detailLoads.clear();
  listeners.clear();
  wired = false;
}
