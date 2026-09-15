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
  /**
   * Present only on the LL MEDIA route (task `L2.3`, `ll-media.ts`): the
   * file name an LL playlist's own URI named — `init.mp4`, `seg-41.m4s`,
   * `part-164.m4s`, or an `audio-` twin. Never set without `rung`.
   */
  media?: string;
}

/**
 * Same shape as `HLS_PLAYLIST_PATH` in `server/src/api/index.ts`, plus one
 * segment the API does not have: the LL media name.
 *
 * TWO DELIBERATE DIFFERENCES FROM THE API'S COPY.
 *
 *  - **The rung may contain a hyphen.** The API's rungs are all
 *    `[A-Za-z0-9]` (`720p30`, `1080p60`), and this pattern was a
 *    character-for-character copy of its regex — which meant `ll-audio`,
 *    the rung name `ll-playlist.js` has emitted since `L2.2`, did not match
 *    this route at all and 404'd from the edge before any of the LL code
 *    ever ran. The LL AUDIO rendition was unreachable for that reason
 *    alone; the video rung (`ll`) matched and worked. Found writing
 *    `L2.3`'s tests.
 *  - **An optional fourth segment**, the media name, bounded by the SAME
 *    pattern `ll-state.js`'s `isSafeUriSegment` applies to every name
 *    `state.json` hands this Worker (no `/`, no `..`, no query, no control
 *    characters) — because that name is what gets appended to the remux
 *    origin's `/s/:sessionId/` path, and a route that accepted more than
 *    the state document can legally contain would be a wider door than the
 *    one thing on the other side of it.
 */
const PLAYLIST_PATH =
  /^\/api\/voice\/hls-playlist\/([^/]{1,64})\/(\d{1,20})(?:\/([A-Za-z0-9][A-Za-z0-9-]{0,15})(?:\/([A-Za-z0-9][A-Za-z0-9._-]{0,190}))?)?$/;

export function parsePlaylistPath(pathname: string): PlaylistRouteMatch | null {
  const match = PLAYLIST_PATH.exec(pathname);
  if (!match) {
    return null;
  }
  return { channelId: match[1]!, startedAt: match[2]!, rung: match[3], media: match[4] };
}

/**
 * `LIVE_HLS_MODE_PARAM` / `LIVE_HLS_MODE_LL` in
 * `packages/shared/src/live-hls.ts`, ported here for the same reason
 * `hls-viewer-token.js` and `ll-session.js` port their halves: this Worker
 * deploys separately from the API, in a different repo boundary, with no
 * module boundary to share across. Two string literals, pinned by
 * `test/playlist-route.test.mjs` against the exact URL the API builds
 * (`llPlaylistUrl` in `server/src/voice/hls-remux.ts`).
 */
export const LL_MODE_PARAM = "mode";
export const LL_MODE_VALUE = "ll";

/**
 * Whether THIS request asks for the low-latency rendering of its session.
 *
 * The one and only signal. The Worker used to answer that question by
 * probing the remux origin for a `state.json` and reading "no state" as
 * "this party is conventional" — which is false for every LL session in its
 * first second, and is why low-latency was enabled in production four times
 * on 2026-09-15 and no viewer was ever handed the low-latency stream. The
 * API chose the mode; the API now says so in the URL it hands out, and this
 * function is where that statement is read.
 *
 * Anything other than exactly `mode=ll` is conventional, including a
 * repeated or unparseable parameter (`URLSearchParams.get` returns the
 * FIRST value, so `?mode=ll&mode=x` still reads `ll` and `?mode=x&mode=ll`
 * does not — either way one deterministic answer, never a probe).
 */
export function requestsLlMode(url: URL): boolean {
  return url.searchParams.get(LL_MODE_PARAM) === LL_MODE_VALUE;
}
