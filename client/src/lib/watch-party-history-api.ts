import { apiFetch } from "./api";

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
 */
export function fetchWatchPartyHistoryReplay(
  channelId: string,
  sessionId: string,
): Promise<{ hlsUrl: string }> {
  return apiFetch(
    `/api/channels/${channelId}/watch-party/history/${sessionId}/replay`,
  );
}
