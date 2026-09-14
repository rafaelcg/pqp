import { apiFetch } from "./api";
import { resolveHlsUrl } from "./hls-playback";

/**
 * "Transmissões anteriores": the owner/moderator surface for finding
 * yesterday's watch-party broadcasts. Thin wrappers, same reasoning as
 * `watch-parties-api.ts`: this feature's HTTP surface stays reviewable on
 * its own rather than dissolving into `api.ts`.
 *
 * One broadcast is one entry, keyed by `sessionId` -- the server's
 * `started_at` in epoch milliseconds, as a string (`server/src/voice/hls-history.ts`).
 * It is not a database id and carries no other meaning; treat it as opaque.
 */
export interface WatchPartyHistoryEntry {
  sessionId: string;
  /** The party's own title, falling back to the channel's name server-side. */
  title: string;
  startedAt: string;
  /** Null while the broadcast is still live. */
  endedAt: string | null;
  durationSeconds: number | null;
  presenter: { userId: string; displayName: string } | null;
  /** Whether the recording still exists to be watched. */
  replayAvailable: boolean;
  keepReplay: boolean;
}

export function fetchWatchPartyHistory(
  channelId: string,
  limit?: number,
  signal?: AbortSignal,
): Promise<{ broadcasts: WatchPartyHistoryEntry[] }> {
  const query = limit ? `?limit=${limit}` : "";
  return apiFetch(
    `/api/channels/${channelId}/watch-party/history${query}`,
    signal ? { signal } : {},
  );
}

/**
 * Flips whether a broadcast's recording is kept past the default retention
 * window. 409s (surfaced as `ApiError.status === 409`) once the segments are
 * already gone -- there is nothing left to keep, in either direction.
 */
export function setWatchPartyHistoryKeepReplay(
  channelId: string,
  sessionId: string,
  keepReplay: boolean,
): Promise<{ broadcasts: WatchPartyHistoryEntry[] }> {
  return apiFetch(
    `/api/channels/${channelId}/watch-party/history/${sessionId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ keepReplay }),
    },
  );
}

/**
 * Mints a playable URL for an ended broadcast that is still available --
 * same viewer-token machinery as a live stream, a 60-minute capability
 * already embedded in the URL. Feed it straight to `HlsWatchPlayer`'s `src`.
 *
 * RESOLVED HERE, NOT AT THE PLAYER. The server answers an API-relative
 * path (`/api/voice/hls-replay/...`), and the SPA does not live on the API
 * origin: hls.js resolved it against `pqp.gg`, Pages' `/*` catch-all
 * answered `index.html` with a 200, the manifest parser choked on HTML, and
 * the VOD holding screen showed a spinner at 0:00 / --:-- for as long as
 * the stall ladder took to give up (2026-09-14, Rafael's first replay). The
 * live doors all go through `resolveHlsUrl` (`hls-playback.ts` says why);
 * this was the fifth door that did not.
 */
export async function fetchWatchPartyHistoryReplay(
  channelId: string,
  sessionId: string,
): Promise<{ hlsUrl: string }> {
  const res = await apiFetch<{ hlsUrl: string }>(
    `/api/channels/${channelId}/watch-party/history/${sessionId}/replay`,
  );
  return { hlsUrl: resolveHlsUrl(res.hlsUrl) };
}
