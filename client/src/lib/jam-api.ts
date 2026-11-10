import {
  JAM_ERRORS,
  type AddJamTrackRequest,
  type CreateJamSongRequest,
  type CreateJamUploadRequest,
  type JamConfig,
  type JamInstrument,
  type JamSongDetailResponse,
  type JamSongListResponse,
  type JamSongSummary,
  type JamSort,
  type JamTrackWithSong,
  type JamUploadTicket,
  type JamVoteResponse,
  type UpdateJamSongRequest,
  type UpdateJamTrackRequest,
} from "@pqp/shared";
import { ApiError, apiFetch } from "@/lib/api";

/**
 * The jam routes, as frozen in `packages/shared/src/jam.ts` and `docs/JAM.md`.
 * Reads are never gated by the flag; every write is (`jam_channels_off`).
 */

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** A 204 has no JSON body, which `apiFetch` reports as an error with that status. */
async function noContent(path: string, init: RequestInit): Promise<void> {
  try {
    await apiFetch<unknown>(path, init);
  } catch (error) {
    if (error instanceof ApiError && error.status === 204) {
      return;
    }
    throw error;
  }
}

export const fetchJamConfig = (serverId: string) =>
  apiFetch<JamConfig>(`/api/jam/config?serverId=${encodeURIComponent(serverId)}`);

export interface JamListQuery {
  sort?: JamSort;
  q?: string;
  wanting?: JamInstrument;
  mine?: boolean;
  cursor?: string | null;
  limit?: number;
}

export function jamListQuery(query: JamListQuery): string {
  const params = new URLSearchParams();
  if (query.sort) params.set("sort", query.sort);
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.wanting) params.set("wanting", query.wanting);
  if (query.mine) params.set("mine", "true");
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));
  return params.toString();
}

export const fetchJamSongs = (channelId: string, query: JamListQuery = {}, signal?: AbortSignal) =>
  apiFetch<JamSongListResponse>(
    `/api/channels/${channelId}/jam-songs?${jamListQuery(query)}`,
    signal ? { signal } : {},
  );

export const fetchJamSong = (songId: string, signal?: AbortSignal) =>
  apiFetch<JamSongDetailResponse>(`/api/jam-songs/${songId}`, signal ? { signal } : {});

export const createJamSong = (channelId: string, body: CreateJamSongRequest) =>
  apiFetch<{ song: JamSongSummary }>(`/api/channels/${channelId}/jam-songs`, json("POST", body));

export const updateJamSong = (songId: string, patch: UpdateJamSongRequest) =>
  apiFetch<{ song: JamSongSummary }>(`/api/jam-songs/${songId}`, json("PATCH", patch));

export const deleteJamSong = (songId: string) =>
  noContent(`/api/jam-songs/${songId}`, json("DELETE"));

export const createJamUpload = (songId: string, body: CreateJamUploadRequest) =>
  apiFetch<JamUploadTicket>(`/api/jam-songs/${songId}/uploads`, json("POST", body));

export const addJamTrack = (songId: string, body: AddJamTrackRequest) =>
  apiFetch<JamTrackWithSong>(`/api/jam-songs/${songId}/tracks`, json("POST", body));

export const updateJamTrack = (trackId: string, patch: UpdateJamTrackRequest) =>
  apiFetch<JamTrackWithSong>(`/api/jam-tracks/${trackId}`, json("PATCH", patch));

export const deleteJamTrack = (trackId: string) =>
  noContent(`/api/jam-tracks/${trackId}`, json("DELETE"));

export const voteJamTrack = (trackId: string, voted: boolean) =>
  voted
    ? apiFetch<JamVoteResponse>(`/api/jam-tracks/${trackId}/vote`, json("PUT"))
    : apiFetch<JamVoteResponse>(`/api/jam-tracks/${trackId}/vote`, json("DELETE"));

/**
 * What a failed jam call means in the person's terms. The copy lives in the
 * catalogue under `jam.error.*`; a token this file does not know falls back to
 * the generic line, never the raw string.
 */
export type JamErrorKind =
  | "off"
  | "closed"
  | "instrumentNotWanted"
  | "songFull"
  | "authorTrackLimit"
  | "tooLarge"
  | "storageOff"
  | "rateLimited"
  | "network"
  | "other";

export function jamErrorKind(error: unknown): JamErrorKind {
  if (error instanceof ApiError) {
    switch (error.message) {
      case JAM_ERRORS.off:
        return "off";
      case JAM_ERRORS.closed:
        return "closed";
      case JAM_ERRORS.instrumentNotWanted:
        return "instrumentNotWanted";
      case JAM_ERRORS.songFull:
        return "songFull";
      case JAM_ERRORS.authorTrackLimit:
        return "authorTrackLimit";
      case JAM_ERRORS.uploadTooLarge:
        return "tooLarge";
      case JAM_ERRORS.storageOff:
        return "storageOff";
      case JAM_ERRORS.rateLimited:
        return "rateLimited";
      default:
        break;
    }
    if (error.status === 0) {
      return "network";
    }
    return "other";
  }
  return "network";
}
