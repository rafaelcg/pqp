import { getPool } from "../db.js";
import { signRequest } from "../lib/s3.js";
import { verifyHlsViewerToken } from "./hls-viewer-token.js";
import {
  hlsObjectPrefix,
  hlsUrlTtlSeconds,
  liveHlsStorageConfig,
  internalPlaylistUrl,
  sessionPrefixPattern,
} from "./hls-egress.js";
import {
  buildMasterPlaylist,
  LADDER_RUNGS,
  type MasterVariant,
} from "./hls-ladder.js";
import { HLS_VIEWER_TOKEN_PARAM } from "./hls-viewer-token.js";
import { LiveWindowHistory, widenLivePlaylist } from "./hls-live-window.js";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * THE CLOCK A SEGMENT URL IS SIGNED WITH, AND WHY IT IS NOT `Date.now()`.
 *
 * A SEGMENT'S URL MUST NOT CHANGE WHILE IT IS LISTED. RFC 8216 6.2.1 allows a
 * live playlist to have entries appended and removed and nothing else: an
 * entry that is still listed must be byte-identical to the one the player
 * already read, because the URI IS the segment's identity. hls.js happens to
 * survive a breach of that because it keys fragments by media sequence
 * number, so the web audience never noticed. `AVPlayer` keys on the URI, as
 * the specification says to, and so does every other native player.
 *
 * This proxy re-renders once a second per rendition and used to re-sign every
 * line with the current clock, so the SAME segment came back under a
 * different `X-Amz-Date` and a different signature on every refresh.
 * Measured against the live party on 2026-09-12: `..._00230.ts` was listed as
 * three different URLs in renders 1.5 s apart. To iOS that reads as fifteen
 * unfamiliar segments every two seconds and nothing it has already fetched,
 * so the download queue it had built is worthless on each reload, it refetches
 * what is already in its buffer, and the picture hitches every ten to fifteen
 * seconds while the refetch races the playhead. Web viewers of the same
 * session were clean, which is the shape of pitfall #16 again: the failure
 * lived only in the client our tests do not imitate.
 *
 * So the signing instant is quantised. Every render inside one bucket signs a
 * given key to the same bytes, on this process and on any other, because the
 * bucket is a function of the wall clock and the bucket credentials and of no
 * per-process state. A segment therefore keeps one URL for its whole life in
 * the window: a 30 s window on a 5 minute bucket crosses a boundary about
 * once every ten windows, and that boundary re-signs everything once, which
 * costs a cache miss and not a discontinuity.
 *
 * The bucket is a third of the TTL, so a URL handed out at the very end of
 * its bucket still has two thirds of its life in front of it (600 s of the
 * default 900). An operator who shortens `LIVE_HLS_URL_TTL_SECONDS` shortens
 * the bucket with it, rather than being handed URLs that expired before they
 * were sent.
 */
export const SEGMENT_URL_BUCKET_MAX_MS = 5 * 60_000;

export function segmentSigningTime(now: number, ttlSeconds: number): Date {
  const bucketMs = Math.max(
    1_000,
    Math.min(SEGMENT_URL_BUCKET_MAX_MS, Math.floor((ttlSeconds * 1_000) / 3)),
  );
  return new Date(Math.floor(now / bucketMs) * bucketMs);
}

/**
 * Per rendition, the segments this process has seen listed, so the window a
 * viewer gets is wider than the five entries the egress writes. Keyed like
 * the render cache and dropped with it. See `hls-live-window.ts`.
 */
const windowHistory = new Map<string, LiveWindowHistory>();

function historyFor(key: string): LiveWindowHistory {
  let history = windowHistory.get(key);
  if (!history) {
    history = new LiveWindowHistory();
    windowHistory.set(key, history);
  }
  return history;
}

/**
 * How long one session's rendered playlist is reused.
 *
 * WHY THIS EXISTS. Every viewer refetches the playlist every 2 s, and each
 * refetch used to cost this API a fresh render: a Postgres lookup, an
 * upstream HTTPS GET of the source playlist from R2, and a SigV4 signature
 * per segment line. That is per viewer, so the audience cost scaled on OUR
 * box rather than on the bucket, which is the opposite of the reason watch
 * mode uses HLS at all. Measured locally on a 30-segment playlist, one render
 * is 2.3 ms of CPU, so 300 viewers (150 req/s) is about a third of a core
 * spent re-deriving a body that is identical for all of them.
 *
 * It is safe to share one body between viewers because the body IS shared:
 * `buildSignedPlaylist` takes no viewer, and the segment URLs it writes are
 * signed with the BUCKET's credentials (`signRequest`), not with anything
 * belonging to the person asking. Two viewers of the same session receive
 * byte-identical playlists.
 *
 * What is NOT cached is permission. `requireChannelAccess` runs in the route
 * on every single request, before this is ever consulted, so a viewer who
 * may not see the channel gets a 401 and never reaches a cached body. The
 * key is the session (channel + startedAt) and nothing else, so it cannot be
 * poisoned by who asked.
 *
 * One second rather than two: a viewer must never be handed a window that is
 * already a full segment stale, or the player sits on the live edge waiting
 * for a segment the playlist has not admitted exists yet.
 */
export const HLS_PLAYLIST_CACHE_TTL_MS = 1_000;

interface CachedPlaylist {
  /** Resolved body, once the render finished. */
  body?: string;
  /** The in-flight render, so concurrent viewers coalesce into one fetch. */
  inflight?: Promise<string>;
  /** When `body` was produced. */
  at: number;
}

const playlistCache = new Map<string, CachedPlaylist>();

/**
 * RENDITION identity, and deliberately nothing about the viewer.
 *
 * The rung is part of the key and must stay that way. A ladder's renditions
 * share a channel and a `startedAt` and differ only in the rung, so a key
 * without it would hand a viewer on 720p the 1080p segment list: the same
 * cache that makes an audience cheap would quietly serve everyone the wrong
 * bitrate.
 */
function cacheKey(channelId: string, startedAt: number, rung?: string): string {
  return `${channelId}/${startedAt}/${rung ?? ""}`;
}

export function resetHlsPlaylistCacheForTests(): void {
  playlistCache.clear();
  rungCache.clear();
  windowHistory.clear();
  stopAllKeepWarmLoops();
  keepWarmRenders = 0;
}

/**
 * Who is asking for the playlist, and whether they proved it with something
 * that already carries a permission decision.
 *
 * THE TOKEN IS PREFERRED OVER THE HEADER, which is the opposite of what this
 * did before and is the whole performance fix. A valid `?t=` is signed by us
 * and names this exact user, channel and session, and it was minted only
 * after a real access check. So it IS the capability: the caller may serve it
 * without asking the database anything. The Bearer header proves identity but
 * not access, so a header-only caller still pays for the check.
 *
 * hls.js sends both, so preferring the token is what takes the common case
 * off the database entirely. Null is a 401.
 */
export function resolveHlsPlaylistViewer(input: {
  bearerUserId: string | null | undefined;
  token: string | null | undefined;
  channelId: string;
  startedAt: number;
  now?: number;
}): { userId: string; issuedAt: number | null } | null {
  const fromToken = verifyHlsViewerToken(
    input.token,
    { channelId: input.channelId, startedAt: input.startedAt },
    input.now,
  );
  // A token that verifies but names somebody else than the authenticated
  // caller is not this caller's capability. Fall back to the header.
  if (
    fromToken &&
    (!input.bearerUserId || fromToken.userId === input.bearerUserId)
  ) {
    return fromToken;
  }
  if (input.bearerUserId) {
    return { userId: input.bearerUserId, issuedAt: null };
  }
  return null;
}

/** Playlist proxy could not find a live session for this channel. */
export class HlsPlaylistNotFound extends Error {}

/** Storage is not configured, so there is nothing to fetch or sign. */
export class HlsPlaylistUnavailable extends Error {}

/**
 * The signed alternative to handing a viewer the raw public bucket URL.
 *
 * hls.js (and Safari's native player) resolve a playlist's segment lines
 * relative to the playlist's own URL, and relative resolution drops the base
 * URL's query string -- so presigning only the playlist would leave every
 * segment request unsigned and, once the bucket is not public, a 403. This
 * fetches the live playlist through an internal signed GET (the bucket can
 * be fully private), then rewrites every segment/media line into its own
 * absolute presigned URL before handing the rewritten playlist back. The
 * route this backs (`GET /api/voice/hls-playlist/:channelId/:startedAt`) is
 * Bearer-authed like every other route (CLAUDE.md pitfall #8), or carries the
 * per-viewer `?t=` token for players that cannot send a header (see
 * `resolveHlsPlaylistViewer` above); only the objects it points at need a
 * signature of their own.
 *
 * `startedAt` names the exact session (it is the same value `hls-egress.ts`
 * put in the URL it handed the viewer), rather than "whatever is live right
 * now" -- so a stale link from a session that already ended still 404s
 * cleanly instead of silently serving a different session's stream.
 */
export async function buildSignedPlaylist(
  channelId: string,
  startedAt: number,
  rung?: string,
  now = Date.now(),
): Promise<string> {
  // A real viewer asked for this session: keep it warm, and remember that
  // someone is still watching. Must run before the cache/inflight logic
  // below so a viewer's very first request both renders AND arms the loop.
  touchKeepWarmSession(channelId, startedAt, now);
  return renderCachedPlaylist(channelId, startedAt, rung, now);
}

/**
 * The cache/inflight-coalescing logic `buildSignedPlaylist` has always had,
 * pulled out so the keep-warm loop below can share it without also touching
 * "a viewer asked for this" bookkeeping -- the loop's own renders must not
 * look like viewer activity, or the idle timeout below could never fire.
 */
async function renderCachedPlaylist(
  channelId: string,
  startedAt: number,
  rung: string | undefined,
  now: number,
): Promise<string> {
  const key = cacheKey(channelId, startedAt, rung);
  const cached = playlistCache.get(key);
  if (cached) {
    if (cached.body !== undefined && now - cached.at < HLS_PLAYLIST_CACHE_TTL_MS) {
      return cached.body;
    }
    if (cached.inflight) {
      // Someone else is already doing the expensive part. Wait for theirs
      // rather than starting a second identical fetch: a room joining at
      // once is exactly when this matters most.
      return cached.inflight;
    }
  }
  const inflight = renderSignedPlaylist(channelId, startedAt, rung, now)
    .then((body) => {
      // Stamped with the caller's clock, not a fresh read, so a test (and a
      // slow render) measure the TTL from the same instant the caller did.
      playlistCache.set(key, { body, at: now });
      return body;
    })
    .catch((error: unknown) => {
      // A failed render is not cached: the next viewer should retry rather
      // than inherit a 404 from a session that was mid-cleanup.
      playlistCache.delete(key);
      throw error;
    });
  playlistCache.set(key, { ...cached, inflight, at: cached?.at ?? 0 });
  return inflight;
}

/**
 * KEEP-WARM: a per-session loop that renders every rung of a live session on
 * the server's own clock, so a rung nobody happens to be watching still has a
 * full window when someone switches to it.
 *
 * WHY THIS EXISTS. `LiveWindowHistory` only grows when a viewer requests that
 * rendition -- the history is a side effect of `renderSignedPlaylist`, not a
 * background process. A rung with no audience (a viewer on 1080p while
 * everyone else is on 720p, say) never gets rendered, so its history sits at
 * whatever the egress's own five-entry window last happened to hold. Read on
 * production 2026-09-12 15:41Z: a rung nobody had polled for a while came
 * back with exactly 5 entries (20 s at 4 s segments, `EGRESS_LIVE_WINDOW_SEGMENTS`)
 * because the history had a gap and `window()` stops at a gap. A viewer who
 * switches to that rung -- the whole point of a ladder -- lands in a window a
 * third the width of a rung someone had been watching the whole time.
 *
 * So while a session is live, every rung it has is rendered from the server
 * side too, on the same cadence a viewer's own poll would use. The render is
 * `renderCachedPlaylist`, the exact function a viewer's request shares, so a
 * warm tick costs nothing extra when a viewer's own poll lands in the same
 * second -- one of them does the work, both get the body.
 *
 * ONE LOOP PER SESSION, not per rung: `sessionRungs` is re-read every tick
 * (itself cached, so this costs nothing beyond what a master request already
 * costs), so a rung that starts mid-party is picked up on the next tick
 * without restarting anything.
 */
export const HLS_KEEP_WARM_INTERVAL_MS = 2_000;

/** No viewer of ANY rung of this session for this long: stop polling the bucket for it. */
export const HLS_KEEP_WARM_IDLE_MS = 10 * 60_000;

interface KeepWarmLoop {
  timer: ReturnType<typeof setInterval>;
  /** Last time a viewer (not the loop itself) requested any rung of this session. */
  lastRequestedAt: number;
  /** Guards against overlapping ticks if a render is slower than the interval. */
  ticking: boolean;
}

const keepWarmLoops = new Map<string, KeepWarmLoop>();

/** Warm renders performed by the loop, for metrics. */
let keepWarmRenders = 0;

function keepWarmSessionKey(channelId: string, startedAt: number): string {
  return `${channelId}/${startedAt}`;
}

/** How many sessions currently have a keep-warm loop running. For metrics. */
export function hlsKeepWarmLoopsActive(): number {
  return keepWarmLoops.size;
}

/** How many warm (non-viewer) renders the keep-warm loop(s) have performed. For metrics. */
export function hlsKeepWarmRenders(): number {
  return keepWarmRenders;
}

function touchKeepWarmSession(channelId: string, startedAt: number, now: number): void {
  const key = keepWarmSessionKey(channelId, startedAt);
  const loop = keepWarmLoops.get(key);
  if (loop) {
    loop.lastRequestedAt = now;
    return;
  }
  const timer = setInterval(() => {
    void runKeepWarmTick(channelId, startedAt, key);
  }, HLS_KEEP_WARM_INTERVAL_MS);
  // Never holds the process open: a keep-warm loop for a session nobody ever
  // tears down explicitly (a crash, a test that forgets to reset) must not
  // be why `node` refuses to exit.
  timer.unref?.();
  keepWarmLoops.set(key, { timer, lastRequestedAt: now, ticking: false });
}

async function runKeepWarmTick(
  channelId: string,
  startedAt: number,
  key: string,
): Promise<void> {
  const loop = keepWarmLoops.get(key);
  if (!loop || loop.ticking) {
    return;
  }
  const now = Date.now();
  if (now - loop.lastRequestedAt >= HLS_KEEP_WARM_IDLE_MS) {
    // Abandoned: nobody has watched any rung of this session in a while.
    // Stop polling the bucket for it rather than doing this forever.
    stopKeepWarmLoop(key);
    return;
  }
  loop.ticking = true;
  try {
    let rungs: (string | undefined)[];
    try {
      const list = await sessionRungs(channelId, startedAt, now);
      // A pre-ladder session (no rung rows at all) still has one media
      // playlist to keep warm: `rung: undefined`.
      rungs = list.length > 0 ? list : [undefined];
    } catch {
      // Could not even list the rungs (DB hiccup): try again next tick.
      return;
    }
    for (const rung of rungs) {
      try {
        await renderCachedPlaylist(channelId, startedAt, rung, now);
        keepWarmRenders += 1;
      } catch (error) {
        if (error instanceof HlsPlaylistNotFound) {
          // The session ended. Nothing left to keep warm.
          stopKeepWarmLoop(key);
          return;
        }
        // Any other failure (storage unreachable, a slow upstream) is
        // swallowed: a warm tick is a courtesy, not a request anyone is
        // waiting on, and the next tick tries again.
      }
    }
  } finally {
    loop.ticking = false;
  }
}

function stopKeepWarmLoop(key: string): void {
  const loop = keepWarmLoops.get(key);
  if (!loop) {
    return;
  }
  clearInterval(loop.timer);
  keepWarmLoops.delete(key);
}

function stopAllKeepWarmLoops(): void {
  for (const key of [...keepWarmLoops.keys()]) {
    stopKeepWarmLoop(key);
  }
}

async function renderSignedPlaylist(
  channelId: string,
  startedAt: number,
  rung: string | undefined,
  now: number,
): Promise<string> {
  const config = liveHlsStorageConfig();
  if (!config) {
    throw new HlsPlaylistUnavailable("Live HLS storage is not configured");
  }

  const objectPrefix = hlsObjectPrefix(channelId, startedAt, rung);
  // `ended_at IS NULL`, NOT just `cleaned_at IS NULL`, and the difference is
  // the whole bug. `cleaned_at` is "the objects have not been deleted yet",
  // which after retention was raised to 180 minutes means a session that
  // finished three hours ago still answered here as if it were live. Read
  // from the production bucket on 2026-09-09: a superseded session's live
  // playlist had a LastModified one second old and a newest entry seven
  // minutes stale, because a LiveKit egress whose input track is gone keeps
  // rewriting its playlist while producing no new segments. A player pinned
  // to it polls a file that keeps changing, concludes the stream is live, and
  // never receives media: buffer drains, "Loading stream", retry, repeat,
  // every ten to twenty seconds, and on iOS never recovers because there is
  // nothing to recover to.
  //
  // The comment on `buildSignedPlaylist` above has always claimed that a link
  // from a session that already ended "404s cleanly". This is the clause that
  // makes that true. A 404 is what the client's watchdog wants: it refetches
  // `GET /api/channels/:id/live` and follows the current session, which is
  // machinery that already exists and already works.
  const session = await getPool().query(
    `SELECT 1 FROM hls_sessions
     WHERE channel_id = $1
       AND object_prefix = $2
       AND ended_at IS NULL
       AND cleaned_at IS NULL`,
    [channelId, objectPrefix],
  );
  if (session.rowCount === 0) {
    // The session is over: forget its window too, so the map does not keep
    // one history per session this process ever served.
    windowHistory.delete(cacheKey(channelId, startedAt, rung));
    throw new HlsPlaylistNotFound(
      `No live HLS session ${objectPrefix} for channel ${channelId}`,
    );
  }
  // A presigned endpoint-form GET: the bucket can be fully private and no
  // public base is needed (production runs that way).
  const playlistUrl = internalPlaylistUrl(channelId, startedAt, rung);

  let response: Response;
  try {
    response = await fetch(playlistUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new HlsPlaylistUnavailable(
      error instanceof Error ? error.message : "Storage unreachable",
    );
  }
  if (!response.ok) {
    throw new HlsPlaylistUnavailable(
      `Storage returned HTTP ${response.status} for the playlist`,
    );
  }
  // The egress lists five segments. Remember them and list more: the
  // objects are still in the bucket, and a viewer with only two seconds of
  // listed media behind the playhead stalls on every slow poll. The widened
  // body still carries the egress's own URI lines, so the rewrite below is
  // unchanged.
  const body = widenLivePlaylist(
    historyFor(cacheKey(channelId, startedAt, rung)),
    await response.text(),
  );
  const ttl = hlsUrlTtlSeconds();
  // Quantised, never `new Date()`: see `segmentSigningTime` above. This one
  // argument is the whole fix for the native stall.
  const signedAt = segmentSigningTime(now, ttl);
  const prefixDir = `${objectPrefix.split("/").slice(0, -1).join("/")}/`;

  const rewritten = body
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) {
        return line;
      }
      // Segment/media lines in this playlist are always a bare filename in
      // the same "directory" as the playlist itself (LiveKit's
      // `filenamePrefix` is a file prefix, not a real directory, but every
      // sibling object it writes shares the playlist's own prefix path).
      const key = trimmed.includes("/") ? trimmed : `${prefixDir}${trimmed}`;
      return signRequest({
        method: "GET",
        key,
        ttlSeconds: ttl,
        forRead: true,
        config,
        now: signedAt,
      }).url;
    })
    .join("\n");

  return rewritten;
}

/**
 * A session's rungs, cached on the same terms and for the same reason as the
 * rendered playlists above: a master is refetched far less often than a media
 * playlist, but a room joining at once still asks for it at once, and the
 * answer is identical for every one of them.
 *
 * The rung LIST is cached, not the master body, because the body carries each
 * viewer's own token and is therefore not shared. Building the string from a
 * cached list costs nothing.
 */
const rungCache = new Map<
  string,
  { rungs?: string[]; inflight?: Promise<string[]>; at: number }
>();

/**
 * The rungs one session is serving right now, lowest bitrate first, read from
 * the rows the egress writer recorded. The database rather than the
 * in-process room map on purpose: a request that lands while the room is
 * being reconciled still answers, and a session adopted back after a restart
 * is in the rows before it is in memory.
 *
 * A row whose `rung` names nothing this build knows (an operator downgraded
 * mid-stream) is dropped rather than guessed at: the master lists what it can
 * describe truthfully, and a viewer plays the rest.
 *
 * ENDED ROWS ARE NOT RUNGS. Same clause and same reason as
 * `renderSignedPlaylist`: without it a finished session goes on advertising
 * its variants for the whole retention window, so a viewer who never learns
 * about the new session is handed a master pointing at a corpse.
 */
async function sessionRungs(
  channelId: string,
  startedAt: number,
  now: number,
): Promise<string[]> {
  const key = cacheKey(channelId, startedAt, "master");
  const cached = rungCache.get(key);
  if (cached) {
    if (cached.rungs !== undefined && now - cached.at < HLS_PLAYLIST_CACHE_TTL_MS) {
      return cached.rungs;
    }
    // COALESCE THE STAMPEDE. A party's audience arrives together, and every
    // one of them asks for the master first. Measured on staging 2026-09-12:
    // 500 viewers ramping over 30 s put 500 copies of this query on a pool
    // of 10 at once, 491 of them timed out at 15 s, and those viewers saw
    // "Loading the stream" while the media polls beside them answered in
    // 450 ms. One query per session per second, whoever asks.
    if (cached.inflight) {
      return cached.inflight;
    }
  }
  const inflight = getPool()
    .query<{ rung: string | null }>(
      `SELECT rung FROM hls_sessions
       WHERE channel_id = $1
         AND object_prefix LIKE $2
         AND rung IS NOT NULL
         AND ended_at IS NULL
         AND cleaned_at IS NULL
       ORDER BY started_at ASC`,
      [channelId, sessionPrefixPattern(channelId, startedAt)],
    )
    .then((rows) => {
      const rungs = rows.rows
        .map((row) => row.rung)
        .filter((rung): rung is string => Boolean(rung && LADDER_RUNGS[rung]));
      rungCache.set(key, { rungs, at: now });
      return rungs;
    })
    .catch((error: unknown) => {
      // Same rule as the playlist cache: a failed read is not remembered.
      rungCache.delete(key);
      throw error;
    });
  rungCache.set(key, { ...cached, inflight, at: cached?.at ?? 0 });
  return inflight;
}

/**
 * The master playlist a viewer is handed: one variant per rendition that
 * actually started, so hls.js and native players pick per viewer and switch
 * as the link changes.
 *
 * VARIANT URIs ARE ROOT-RELATIVE AND CARRY THE VIEWER'S OWN TOKEN. Both
 * halves matter. Relative resolution against the master's URL drops the
 * MASTER's query string but keeps the variant's, which is the only way a
 * header-less player (Safari's native HLS, iOS) can authorise the second
 * request; and staying on this API's own origin is what makes hls.js attach
 * the Bearer header through `isOwnHlsPlaylistProxyUrl`. An absolute bucket
 * URL here would do neither.
 *
 * A session with no rung rows at all is a pre-ladder session: its single
 * media playlist is served directly, so an in-flight viewer from before this
 * deploy is not handed a master listing nothing.
 */
export async function buildMasterPlaylistFor(input: {
  channelId: string;
  startedAt: number;
  /** The `?t=` the request arrived with, stamped onto each variant. */
  token?: string | null;
  now?: number;
}): Promise<string | null> {
  const rungs = await sessionRungs(
    input.channelId,
    input.startedAt,
    input.now ?? Date.now(),
  );
  if (rungs.length === 0) {
    return null;
  }
  const query = input.token
    ? `?${HLS_VIEWER_TOKEN_PARAM}=${encodeURIComponent(input.token)}`
    : "";
  const variants: MasterVariant[] = rungs.map((rung) => ({
    rung: LADDER_RUNGS[rung]!,
    uri:
      `/api/voice/hls-playlist/${encodeURIComponent(input.channelId)}` +
      `/${input.startedAt}/${encodeURIComponent(rung)}${query}`,
  }));
  return buildMasterPlaylist(variants);
}
