/**
 * The inbound URL shape this Worker answers — mirrors the API's own
 * `HLS_PLAYLIST_PATH` in `server/src/api/index.ts` exactly (see `index.ts`'s
 * module doc comment for why: `LIVE_HLS_PLAYLIST_BASE_URL` on the server just
 * prepends this Worker's host to that same path).
 *
 * Kept separate from `playlist-origin.ts` on purpose: this shape is what a
 * VIEWER'S CLIENT requests, and it does not change no matter where the
 * response's bytes end up coming from — the API today, R2 directly once the
 * always-on work lands (see `docs/plans/ALWAYS_ON.md` task A1.x and
 * `playlist-origin.ts`'s doc comment). Parsing the request and fetching the
 * response are two different jobs that happen to be one function today.
 */

export interface PlaylistRouteMatch {
  channelId: string;
  startedAt: string;
  /** Absent: the session/master playlist route. Present: one rendition. */
  rung?: string;
}

/** Same shape as `HLS_PLAYLIST_PATH` in `server/src/api/index.ts`. */
const PLAYLIST_PATH =
  /^\/api\/voice\/hls-playlist\/([^/]{1,64})\/(\d{1,20})(?:\/([A-Za-z0-9]{1,16}))?$/;

export function parsePlaylistPath(pathname: string): PlaylistRouteMatch | null {
  const match = PLAYLIST_PATH.exec(pathname);
  if (!match) {
    return null;
  }
  return { channelId: match[1]!, startedAt: match[2]!, rung: match[3] };
}
