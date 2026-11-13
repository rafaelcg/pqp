import type {
  PublicJamConfig,
  PublicJamListResponse,
  PublicJamSongDetail,
  PublicJamSort,
} from "@pqp/shared";
import type { Instrument } from "./instruments";

/**
 * The public jam routes (`packages/shared/src/jam-public.ts`, "PUBLIC
 * ROUTES"): no account, no Authorization header, no Clerk. Types only come from
 * `@pqp/shared` (erased at build, so the contract package is not in this
 * bundle); what a read promises is checked by `normalise*` below, which fills
 * the defaults the contract gives (`previewPeaks: []`) and refuses a body that
 * is not the shape, the way a down API is refused.
 *
 * Every function throws `JamApiError`. `status` is the HTTP status, 0 for a
 * network failure, so a page can say "not found" and "try again" apart.
 */

export class JamApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "JamApiError";
  }
}

function base(): string {
  return import.meta.env.VITE_API_URL ?? "";
}

/**
 * An address the API hands out that points back at ITSELF (`/api/avatars/<id>`,
 * a server's icon) is root-relative, because the server does not know its own
 * public origin. The page does: this site is `jam.pqp.gg` and the API is
 * `api.pqp.gg`, two origins, with no dev proxy in a production build, so a bare
 * `/api/avatars/x` resolves against the site, 404s, and every person in the
 * mosaic is an initial. Same rule the app has (`resolveUploadedImageUrl`),
 * without its dependencies. Absolute URLs (a signed bucket address, a Clerk
 * picture) pass through; with no API base (same origin) so does everything.
 */
export function resolveApiUrl<T extends string | null | undefined>(value: T, apiBase: string = base()): T {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return value;
  }
  return `${apiBase.replace(/\/+$/, "")}${value}` as T;
}

function resolvePerson<T extends { avatarUrl: string | null }>(person: T): T {
  return person.avatarUrl ? { ...person, avatarUrl: resolveApiUrl(person.avatarUrl) } : person;
}

async function read<T>(path: string, signal?: AbortSignal, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base()}${path}`, {
      ...init,
      signal,
      headers: { accept: "application/json" },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new JamApiError(0, "network");
  }
  if (!response.ok) {
    throw new JamApiError(response.status, `http ${response.status}`);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new JamApiError(502, "bad body");
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export async function fetchJamConfig(signal?: AbortSignal): Promise<PublicJamConfig> {
  const body = await read<unknown>("/api/public/jams/config", signal);
  return { enabled: isObject(body) && body.enabled === true };
}

export interface JamListParams {
  sort?: PublicJamSort;
  needs?: Instrument;
  cursor?: string | null;
  limit?: number;
}

export function normaliseSong(raw: unknown): PublicJamListResponse["songs"][number] {
  if (!isObject(raw) || typeof raw.id !== "string" || typeof raw.title !== "string") {
    throw new JamApiError(502, "bad song");
  }
  const song = raw as unknown as PublicJamListResponse["songs"][number];
  return {
    ...song,
    coverUrl: resolveApiUrl(song.coverUrl ?? null),
    startedBy: song.startedBy ? resolvePerson(song.startedBy) : song.startedBy,
    origin: song.origin ? { ...song.origin, iconUrl: resolveApiUrl(song.origin.iconUrl) } : song.origin,
    previewPeaks: Array.isArray(song.previewPeaks) ? song.previewPeaks : [],
    parts: Array.isArray(song.parts) ? song.parts.map((part) => ({ ...part, person: resolvePerson(part.person) })) : [],
    needs: Array.isArray(song.needs) ? song.needs : [],
    plays: typeof song.plays === "number" ? song.plays : 0,
    likes: typeof song.likes === "number" ? song.likes : 0,
  };
}

export async function fetchJamList(
  params: JamListParams,
  signal?: AbortSignal,
): Promise<PublicJamListResponse> {
  const query = new URLSearchParams();
  if (params.sort) query.set("sort", params.sort);
  if (params.needs) query.set("needs", params.needs);
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit) query.set("limit", String(params.limit));
  const qs = query.toString();
  const body = await read<unknown>(`/api/public/jams${qs ? `?${qs}` : ""}`, signal);
  if (!isObject(body) || !Array.isArray(body.songs)) {
    throw new JamApiError(502, "bad list");
  }
  return {
    songs: body.songs.map(normaliseSong),
    nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : null,
  };
}

export async function fetchJam(songId: string, signal?: AbortSignal): Promise<PublicJamSongDetail> {
  const body = await read<unknown>(`/api/public/jams/${encodeURIComponent(songId)}`, signal);
  if (!isObject(body) || !isObject(body.song) || !Array.isArray(body.tracks)) {
    throw new JamApiError(502, "bad song");
  }
  const tracks = (body.tracks as unknown[]).map((raw) => {
    if (!isObject(raw) || typeof raw.id !== "string" || typeof raw.audioUrl !== "string") {
      throw new JamApiError(502, "bad track");
    }
    const track = raw as unknown as PublicJamSongDetail["tracks"][number];
    return {
      ...track,
      person: track.person ? resolvePerson(track.person) : track.person,
      peaks: Array.isArray(track.peaks) ? track.peaks : [],
      videoSources: Array.isArray(track.videoSources) ? track.videoSources : [],
      videoUrl: typeof track.videoUrl === "string" ? track.videoUrl : null,
    };
  });
  return {
    song: normaliseSong(body.song),
    tracks,
    mediaExpiresAt: typeof body.mediaExpiresAt === "string" ? body.mediaExpiresAt : "",
  };
}

/**
 * A play was pressed. Fire and forget: counted at most once per song per
 * address per hour by the server, and never allowed to get in the way.
 */
export function noteJamPlay(songId: string): void {
  try {
    void fetch(`${base()}/api/public/jams/${encodeURIComponent(songId)}/play`, {
      method: "POST",
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Nothing to do.
  }
}
