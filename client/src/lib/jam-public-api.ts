import {
  JAM_PUBLIC_ERRORS,
  type CreatePublicJamRequest,
  type JamPublicConsent,
  type JamPublicConsentsResponse,
  type JamPublicInboxResponse,
  type JamPublicLikeResponse,
  type JamPublicMeConfig,
  type JamPublicReportResponse,
  type JamPublicSongCreated,
  type JamPublicSongForViewer,
  type JamPublicationResponse,
  type PublicJamListQuery,
  type PublicJamListResponse,
  type ReportPublicJamRequest,
} from "@pqp/shared";
import { ApiError, apiFetch } from "@/lib/api";

/**
 * The public jam routes, as frozen in `packages/shared/src/jam-public.ts` and
 * `docs/JAM_PUBLIC.md`. Everything here is behind the runtime flag
 * `jam_public`: off, the reads answer 401 or 404 and the writes answer
 * `jam_public_off`, which `jamPublicErrorKind` turns into "paused".
 */

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** The signed-in account's view of the flag, and what it may do. */
export const fetchJamPublicMe = () => apiFetch<JamPublicMeConfig>("/api/jam-public/config");

export function publicJamListPath(query: PublicJamListQuery = {}): string {
  const params = new URLSearchParams();
  if (query.sort) params.set("sort", query.sort);
  if (query.needs) params.set("needs", query.needs);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));
  const qs = params.toString();
  return `/api/public/jams${qs ? `?${qs}` : ""}`;
}

export const fetchPublicJams = (query: PublicJamListQuery = {}, signal?: AbortSignal) =>
  apiFetch<PublicJamListResponse>(publicJamListPath(query), signal ? { signal } : {});

export const fetchPublicSongForViewer = (songId: string, signal?: AbortSignal) =>
  apiFetch<JamPublicSongForViewer>(`/api/jam-public/songs/${songId}`, signal ? { signal } : {});

export const createPublicJam = (body: CreatePublicJamRequest) =>
  apiFetch<JamPublicSongCreated>("/api/jam-public/songs", json("POST", body));

export const likePublicJam = (songId: string, liked: boolean) =>
  apiFetch<JamPublicLikeResponse>(
    `/api/jam-public/songs/${songId}/like`,
    json(liked ? "PUT" : "DELETE"),
  );

export const reportPublicJam = (body: ReportPublicJamRequest) =>
  apiFetch<JamPublicReportResponse>("/api/jam-public/reports", json("POST", body));

export const fetchJamPublicConsents = () =>
  apiFetch<JamPublicConsentsResponse>("/api/jam-public/consents");

export const fetchJamPublicInbox = () => apiFetch<JamPublicInboxResponse>("/api/jam-public/inbox");

export const fetchJamPublication = (songId: string) =>
  apiFetch<JamPublicationResponse>(`/api/jam-songs/${songId}/public`);

export const publishJamSong = (songId: string, showOrigin?: boolean) =>
  apiFetch<JamPublicationResponse>(
    `/api/jam-songs/${songId}/public`,
    json("PUT", showOrigin === undefined ? {} : { showOrigin }),
  );

export const setJamShowOrigin = (songId: string, showOrigin: boolean) =>
  apiFetch<JamPublicationResponse>(`/api/jam-songs/${songId}/public`, json("PATCH", { showOrigin }));

export const unpublishJamSong = (songId: string) =>
  apiFetch<JamPublicationResponse>(`/api/jam-songs/${songId}/public`, json("DELETE"));

export const answerJamConsent = (songId: string, choice: JamPublicConsent) =>
  apiFetch<JamPublicationResponse>(
    `/api/jam-songs/${songId}/public-consent`,
    json("PUT", { choice }),
  );

/** What a failed public jam call means in the person's terms (copy: `jam.public.error.*`). */
export type JamPublicErrorKind =
  | "off"
  | "blocked"
  | "removed"
  | "rateLimited"
  | "notStarter"
  | "network"
  | "gone"
  | "other";

export function jamPublicErrorKind(error: unknown): JamPublicErrorKind {
  if (error instanceof ApiError) {
    switch (error.message) {
      case JAM_PUBLIC_ERRORS.off:
        return "off";
      case JAM_PUBLIC_ERRORS.blocked:
        return "blocked";
      case JAM_PUBLIC_ERRORS.removed:
        return "removed";
      case JAM_PUBLIC_ERRORS.rateLimited:
        return "rateLimited";
      case JAM_PUBLIC_ERRORS.notStarter:
        return "notStarter";
      default:
        break;
    }
    if (error.status === 0) {
      return "network";
    }
    if (error.status === 404) {
      return "gone";
    }
    return "other";
  }
  return "network";
}
