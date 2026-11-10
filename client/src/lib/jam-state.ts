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

/** Apply one realtime frame to the channel it is about. Anything else is returned unchanged. */
export function applyJamFrame(state: JamChannelState, frame: JamFrame): JamChannelState {
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

/** A song read by id becomes a detail (and refreshes the summary on the wall). */
export function withDetail(state: JamChannelState, response: JamSongDetailResponse): JamChannelState {
  const known = state.songs.some((one) => one.id === response.song.id);
  return {
    ...state,
    songs: known ? state.songs.map((one) => (one.id === response.song.id ? response.song : one)) : state.songs,
    details: {
      ...state.details,
      [response.song.id]: {
        tracks: response.tracks,
        viewer: response.viewer,
        viewerStale: false,
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
): JamChannelState {
  const fresh = new Set(page.songs.map((song) => song.id));
  const oldestOnPage = page.songs.length > 0 ? page.songs[page.songs.length - 1]!.updatedAt : null;
  const kept =
    page.nextCursor === null || oldestOnPage === null
      ? []
      : state.songs.filter((song) => !fresh.has(song.id) && song.updatedAt < oldestOnPage);
  const songs = sortByActivity([...page.songs, ...kept]);
  const alive = new Set(songs.map((song) => song.id));
  const details = Object.fromEntries(
    Object.entries(state.details).filter(([songId]) => alive.has(songId)),
  );
  return { ...state, status: "ready", songs, nextCursor: page.nextCursor, details };
}
