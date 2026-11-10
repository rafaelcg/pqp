import type {
  JamFrame,
  JamSongDetailResponse,
  JamSongSummary,
  JamSongViewer,
  JamTrack,
} from "@pqp/shared";
import { sortByActivity } from "@/lib/jam-wall";

/**
 * One jam channel's songs, and the songs the person has opened, as a value:
 * the shape the store holds and the rules a frame applies to it. No React and
 * no network here, so every rule is a function from state to state.
 *
 * A FRAME IS APPLIED BY ID AND IS IDEMPOTENT. The writer's own socket gets the
 * frame for its own write (`docs/JAM.md`), so the same song or track arrives
 * twice, once as the answer to the request and once as the frame.
 */

export interface JamDetail {
  tracks: JamTrack[];
  viewer: JamSongViewer;
  /**
   * The song's join mode or wanted list changed under an open detail, so
   * `viewer.addableInstruments` is out of date. The panel reads it again.
   */
  viewerStale: boolean;
}

export interface JamChannelState {
  status: "idle" | "loading" | "ready" | "error";
  songs: JamSongSummary[];
  nextCursor: string | null;
  /** Songs whose detail has been read, keyed by song id. */
  details: Record<string, JamDetail>;
}

export const EMPTY_JAM_CHANNEL: JamChannelState = {
  status: "idle",
  songs: [],
  nextCursor: null,
  details: {},
};

function upsertSong(songs: JamSongSummary[], song: JamSongSummary): JamSongSummary[] {
  const rest = songs.filter((one) => one.id !== song.id);
  return sortByActivity([...rest, song]);
}

function sameAddable(a: JamSongSummary, b: JamSongSummary): boolean {
  return (
    a.joinMode === b.joinMode &&
    a.wantedInstruments.length === b.wantedInstruments.length &&
    a.wantedInstruments.every((instrument, index) => instrument === b.wantedInstruments[index])
  );
}

function withTrack(detail: JamDetail, track: JamTrack): JamDetail {
  const exists = detail.tracks.some((one) => one.id === track.id);
  return {
    ...detail,
    tracks: exists
      ? detail.tracks.map((one) => (one.id === track.id ? track : one))
      : [...detail.tracks, track],
  };
}

function songChanged(
  state: JamChannelState,
  song: JamSongSummary,
): { songs: JamSongSummary[]; details: Record<string, JamDetail> } {
  const before = state.songs.find((one) => one.id === song.id);
  const detail = state.details[song.id];
  const details =
    detail && before && !sameAddable(before, song)
      ? { ...state.details, [song.id]: { ...detail, viewerStale: true } }
      : state.details;
  return { songs: upsertSong(state.songs, song), details };
}

/**
 * Apply one realtime frame to the channel it is about. Anything else is returned unchanged.
 *
 * `options.viewerId`, when given, applies the rule the server's list applies: a
 * song with no track is its author's alone, so a frame that leaves one in the
 * state of somebody else's (a guest's last take deleted) takes it off this wall.
 */
export function applyJamFrame(
  state: JamChannelState,
  frame: JamFrame,
  options?: { viewerId: string | null },
): JamChannelState {
  const next = applyFrame(state, frame);
  if (!options || !("song" in frame) || frame.song.trackCount > 0 || frame.song.authorId === options.viewerId) {
    return next;
  }
  const { [frame.song.id]: _gone, ...details } = next.details;
  return { ...next, songs: next.songs.filter((one) => one.id !== frame.song.id), details };
}

function applyFrame(state: JamChannelState, frame: JamFrame): JamChannelState {
  switch (frame.type) {
    case "jam-song-created":
    case "jam-song-updated":
      return { ...state, ...songChanged(state, frame.song) };
    case "jam-song-deleted": {
      const { [frame.songId]: _gone, ...details } = state.details;
      return {
        ...state,
        songs: state.songs.filter((one) => one.id !== frame.songId),
        details,
      };
    }
    case "jam-track-added":
    case "jam-track-updated": {
      const next = songChanged(state, frame.song);
      const detail = next.details[frame.track.songId];
      return {
        ...state,
        songs: next.songs,
        details: detail
          ? { ...next.details, [frame.track.songId]: withTrack(detail, frame.track) }
          : next.details,
      };
    }
    case "jam-track-deleted": {
      const next = songChanged(state, frame.song);
      const detail = next.details[frame.song.id];
      return {
        ...state,
        songs: next.songs,
        details: detail
          ? {
              ...next.details,
              [frame.song.id]: {
                ...detail,
                tracks: detail.tracks.filter((one) => one.id !== frame.trackId),
                viewer: {
                  ...detail.viewer,
                  votedTrackIds: detail.viewer.votedTrackIds.filter((id) => id !== frame.trackId),
                },
              },
            }
          : next.details,
      };
    }
    case "jam-track-votes": {
      const detail = state.details[frame.songId];
      if (!detail) {
        return state;
      }
      return {
        ...state,
        details: {
          ...state.details,
          [frame.songId]: {
            ...detail,
            tracks: detail.tracks.map((one) =>
              one.id === frame.trackId ? { ...one, voteCount: frame.voteCount } : one,
            ),
          },
        },
      };
    }
  }
}

/**
 * What a frame or a local write changed WHILE a read was in flight, latest value
 * per id (`null` means deleted). A read is a snapshot taken at some moment on the
 * server; a frame that arrives before the answer is newer than the snapshot, so
 * the answer must never overwrite it, and must never be read as proof that a
 * row it does not mention was deleted.
 */
export interface ReadChanges {
  songs: ReadonlyMap<string, JamSongSummary | null>;
  tracks: ReadonlyMap<string, JamTrack | null>;
  /** The viewer's own votes cast while the read was out: track id to voted. */
  votes?: ReadonlyMap<string, boolean>;
}

export const NO_CHANGES: ReadChanges = { songs: new Map(), tracks: new Map(), votes: new Map() };

/** A song read by id becomes a detail (and refreshes the summary on the wall). */
export function withDetail(
  state: JamChannelState,
  response: JamSongDetailResponse,
  changes: ReadChanges = NO_CHANGES,
): JamChannelState {
  const songId = response.song.id;
  const songChange = changes.songs.get(songId);
  if (songChange === null) {
    // Deleted while the read was out.
    const { [songId]: _gone, ...details } = state.details;
    return { ...state, songs: state.songs.filter((one) => one.id !== songId), details };
  }
  const summary = songChange ?? response.song;
  const known = state.songs.some((one) => one.id === songId);
  // The answer's tracks, with what happened since: a track changed live keeps its
  // live value, a track deleted live is gone, a track added live is kept.
  const held = new Map((state.details[songId]?.tracks ?? []).map((track) => [track.id, track]));
  const merged = new Map<string, JamTrack>();
  for (const track of response.tracks) {
    const change = changes.tracks.get(track.id);
    if (change === null) {
      continue;
    }
    merged.set(track.id, change ?? held.get(track.id) ?? track);
  }
  for (const [trackId, change] of changes.tracks) {
    if (change && change.songId === songId && !merged.has(trackId)) {
      merged.set(trackId, change);
    }
  }
  // The viewer is the answer's, with the votes cast since the read began on top
  // (a vote is a write the answer cannot have seen).
  const voted = new Set(response.viewer.votedTrackIds);
  for (const [trackId, isVoted] of changes.votes ?? []) {
    if (!merged.has(trackId)) {
      continue;
    }
    if (isVoted) {
      voted.add(trackId);
    } else {
      voted.delete(trackId);
    }
  }
  // What the viewer may add depends on the song's join mode and wanted
  // instruments. When a frame changed those while the read was out, the answer's
  // `viewer` was computed from the older song: it stays stale and is read again.
  const addabilityMoved =
    summary !== response.song &&
    (summary.joinMode !== response.song.joinMode ||
      summary.wantedInstruments.join(",") !== response.song.wantedInstruments.join(","));
  return {
    ...state,
    songs: known ? state.songs.map((one) => (one.id === songId ? summary : one)) : state.songs,
    details: {
      ...state.details,
      [songId]: {
        tracks: [...merged.values()],
        viewer: { ...response.viewer, votedTrackIds: [...voted] },
        viewerStale: addabilityMoved,
      },
    },
  };
}

/** The answer to one's own vote, ahead of the frame that carries the same count. */
export function withVote(
  state: JamChannelState,
  vote: { songId: string; trackId: string; voteCount: number; voted: boolean },
): JamChannelState {
  const detail = state.details[vote.songId];
  if (!detail) {
    return state;
  }
  const voted = new Set(detail.viewer.votedTrackIds);
  if (vote.voted) {
    voted.add(vote.trackId);
  } else {
    voted.delete(vote.trackId);
  }
  return {
    ...state,
    details: {
      ...state.details,
      [vote.songId]: {
        ...detail,
        tracks: detail.tracks.map((one) =>
          one.id === vote.trackId ? { ...one, voteCount: vote.voteCount } : one,
        ),
        viewer: { ...detail.viewer, votedTrackIds: [...voted] },
      },
    },
  };
}

/**
 * The first page of the list again, merged into what is held: a song the page
 * has is replaced, a song the page does not have stays only if it is OLDER
 * than the page's last row (it fell off the page), and a song newer than the
 * page's oldest row that is not in it was deleted while we were away.
 */
export function mergeFirstPage(
  state: JamChannelState,
  page: { songs: JamSongSummary[]; nextCursor: string | null },
  changes: ReadChanges = NO_CHANGES,
): JamChannelState {
  const fresh = new Set(page.songs.map((song) => song.id));
  const oldestOnPage = page.songs.length > 0 ? page.songs[page.songs.length - 1]!.updatedAt : null;
  const fromPage = page.songs.flatMap((song) => {
    const change = changes.songs.get(song.id);
    if (change === null) {
      return []; // deleted live while the read was out
    }
    return [change ?? song]; // a live change is newer than the page's snapshot
  });
  const kept = state.songs.filter((song) => {
    if (fresh.has(song.id)) {
      return false;
    }
    // Something that happened while the read was out is newer than the page.
    if (changes.songs.get(song.id)) {
      return true;
    }
    return page.nextCursor !== null && oldestOnPage !== null && song.updatedAt < oldestOnPage;
  });
  const songs = sortByActivity([...fromPage, ...kept]);
  const alive = new Set(songs.map((song) => song.id));
  const details = Object.fromEntries(
    Object.entries(state.details).filter(([songId]) => alive.has(songId)),
  );
  return { ...state, status: "ready", songs, nextCursor: page.nextCursor, details };
}
