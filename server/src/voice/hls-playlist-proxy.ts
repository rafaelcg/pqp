import { getPool } from "../db.js";
import { signRequest } from "../lib/s3.js";
import {
  mintHlsPartyPass,
  verifyHlsViewerToken,
  type HlsViewerTokenFailure,
} from "./hls-viewer-token.js";
import {
  hlsObjectPrefix,
  hlsUrlTtlSeconds,
  liveHlsStorageConfig,
  internalPlaylistUrl,
  playlistBaseUrl,
  sessionPrefixPattern,
} from "./hls-egress.js";
import {
  buildMasterPlaylist,
  hlsRungVideoKbps,
  LADDER_RUNGS,
  withPqpSessionTag,
  type MasterVariant,
} from "./hls-ladder.js";
import { HLS_PARTY_PASS_PARAM, HLS_VIEWER_TOKEN_PARAM } from "./hls-viewer-token.js";
import { LiveWindowHistory, widenLivePlaylist } from "./hls-live-window.js";
import { edgeSegmentUrl, hlsSegmentBaseUrl } from "./hls-segment-token.js";
import { hlsSessionOwnedElsewhere } from "./hls-ownership.js";
import {
  isBusEnabled,
  publishToCluster,
  subscribeToCluster,
} from "../lib/bus.js";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * A MEDIA SEGMENT NEVER CHANGES ONCE THE EGRESS WRITES IT, so every fetch of
 * one is a request for the same bytes forever -- the textbook case for
 * `Cache-Control: immutable`. Nothing in the write path can say so today:
 * LiveKit egress 1.14's `S3Upload` (`livekit.S3Upload` in
 * `@livekit/protocol`) carries `metadata` (arbitrary `x-amz-meta-*` pairs,
 * not a real HTTP header), `tagging` and `content_disposition`, and no field
 * for `Cache-Control` at all -- confirmed against the actual PUT, not just
 * the protobuf: `livekit/storage`'s `s3Storage.upload` (`s3.go`) builds its
 * `s3.PutObjectInput` from exactly `Body`, `Bucket`, `ContentType`, `Key`,
 * `Metadata` and `ContentDisposition` (defaulted to `"inline"`), nothing
 * else. So this cannot be set at PUT time without forking egress.
 *
 * This proxy is a GET path, not the PUT path, but S3's `GetObject` (which R2
 * implements) accepts a `response-cache-control` query override that
 * controls only the header THIS response carries, independent of what (if
 * anything) was stored on the object -- exactly the "Worker on GET" shape
 * `docs/plans/BROADCAST_PIPELINE.md` B1.4 asks for, minus a Worker: the
 * override rides on the presigned URL the client already fetches directly
 * from R2, so every viewer's own repeat requests (a seek backward, a stall
 * retry) hit their OWN browser cache instead of R2 again. It does NOT give
 * two different viewers a shared cache entry -- their URLs differ by SigV4
 * signature (`?X-Amz-Signature=...`), so a CDN sitting in front of the raw R2
 * endpoint (there isn't one today) would still see distinct URLs per viewer
 * per signing bucket. Cross-viewer sharing is what `LIVE_HLS_SEGMENT_BASE_URL`
 * does instead: the edge Worker serves segment bytes itself, off an R2
 * binding, from its colo cache (`hls-segment-token.ts`, and
 * `docs/WATCH_PARTY.md` §"Segments at the edge").
 */
const SEGMENT_CACHE_CONTROL = "public, max-age=31536000, immutable";

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
 * The exact presigned URL each segment object was first handed out under,
 * per rendition, so a segment that is still listed keeps BYTE-IDENTICAL bytes
 * for its whole life in the window.
 *
 * WHY THIS EXISTS, on top of the bucket. `segmentSigningTime` makes every
 * render INSIDE one bucket sign a given object to the same URL, which is most
 * of the fix. But a segment routinely survives a bucket boundary: the window
 * is 30 s and the default bucket is 5 minutes, so roughly once every ten
 * windows a boundary falls mid-life of every listed segment, and without this
 * the render after it re-signs ALL of them at once. `AVPlayer` keys fragments
 * by URI (RFC 8216 6.2.1: a live playlist may append and remove entries, not
 * restate them), so that single re-sign looks to it like fifteen unfamiliar
 * segments and none of the ones it has buffered, and it refetches its whole
 * buffer in one go -- the residual hitch #494's bucket left behind, about
 * once per bucket rather than once per second.
 *
 * So the URL a segment was first signed under is remembered and reused for as
 * long as that object stays in the window; only a segment appearing for the
 * first time is signed. The memo is bounded by the window: an object evicted
 * when it leaves (below), the whole rendition dropped with its history on
 * session end, and everything cleared by `resetHlsPlaylistCacheForTests`.
 */
interface MemoisedSegmentUrl {
  url: string;
  /** The instant baked into the URL's `X-Amz-Date`, for the expiry guard. */
  signedAtMs: number;
  /**
   * `LIVE_HLS_SEGMENT_BASE_URL` as it read when this URL was minted (null:
   * a presigned R2 URL). A memo entry is only reused under the same value.
   */
  segmentBase: string | null;
}
const segmentUrlMemo = new Map<string, Map<string, MemoisedSegmentUrl>>();

function segmentMemoFor(key: string): Map<string, MemoisedSegmentUrl> {
  let memo = segmentUrlMemo.get(key);
  if (!memo) {
    memo = new Map();
    segmentUrlMemo.set(key, memo);
  }
  return memo;
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

/**
 * How long a session this process last saw confirmed live may go on being
 * served while Postgres cannot answer: the breaker is open, or the pool is
 * timing out in the seconds before it opens. See `confirmSessionLive` for what
 * is served in that window (a FRESH render from storage, not a replay) and
 * `sessionRungs` for the master's rung list.
 *
 * It is bounded for one reason. A failed check means the `ended_at IS NULL`
 * question could not be asked, not that it was asked and passed, so a
 * session that ended during the outage is still rendered until the bound
 * runs out. What it renders is its own final playlist from the bucket, which
 * stops advancing when the egress stops, and access is still checked (the
 * viewer token, and in-memory revocation), so the cost of a longer bound is
 * small. It was 30 s, measured from a production blip it would not have
 * covered: 2026-09-23 21:42:46Z to 21:43:47Z, 61 s. Three minutes covers a
 * two-minute blip with the breaker's own cooldown and half-open trials on
 * top, and a sustained outage still degrades to the honest
 * `database_unavailable` after that.
 */
export const STALE_ON_BREAKER_MAX_MS = 3 * 60_000;

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
  liveConfirmed.clear();
  endedRungs.clear();
  endedRungsPruneAt = 1024;
  livenessInflight.clear();
  rungSessionIds.clear();
  rendersWithoutDb = 0;
  segmentUrlMemo.clear();
  stopAllKeepWarmLoops();
  keepWarmOwnership.clear();
  keepWarmHandovers.clear();
  keepWarmRelievedAt.clear();
  keepWarmRenders = 0;
  keepWarmDeclined = 0;
  keepWarmAdopted = 0;
  playlistRejections.clear();
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
  /** See `ViewerClaims.p` in `hls-viewer-token.ts`. The replay proxy passes
   * `"replay"` so an ordinary live-stream token cannot be reused against it. */
  purpose?: "live" | "replay";
}): { userId: string; issuedAt: number | null } | null {
  const fromToken = verifyHlsViewerToken(
    input.token,
    {
      channelId: input.channelId,
      startedAt: input.startedAt,
      purpose: input.purpose,
    },
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
      // No replayed body on a database failure any more: a live playlist
      // that stops advancing is a stall, not a fallback. A DB outage is
      // handled one level down, in `confirmSessionLive`, which renders FRESH
      // from storage on a recent confirmation and only throws when there is
      // none to lean on.
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
 *
 * AND ONE LOOP PER SESSION PER CLUSTER, not per machine. The loop is armed by
 * a VIEWER's request, and production runs two `pqp-api` machines behind a
 * proxy with no session affinity, so both of them arm a loop for the same
 * party within seconds of each other: two full ladder re-renders every two
 * seconds, two listings, two sets of signatures, for one set of playlists in
 * one bucket that neither machine's copy improves. Only the machine that owns
 * the session's `hls_sessions` rows warms it (`hlsSessionOwnedElsewhere`); the
 * other one serves every viewer exactly as before, from the shared cache and
 * from storage, and simply does not poll on its own clock.
 *
 * STANDING DOWN IS NOT ENOUGH ON ITS OWN, and getting that wrong would be a
 * worse bug than the one this fixes. The owner only arms a loop when a VIEWER
 * polls IT, so an audience that all landed on the other machine (two viewers,
 * or an owner whose own loop idled out hours into a party) would leave NOBODY
 * warming. So the machine that cannot do the work asks the one that can
 * (`voice.hlsKeepWarm`), the same shape as `voice.hlsReconcile`.
 *
 * AND IT DOES NOT STAND DOWN UNTIL THE OWNER SAYS IT HAS THE JOB. A publish is
 * fire-and-forget and the transport DROPS rather than buffers while it is
 * reconnecting, so "I published a hand-over" is not "somebody is warming
 * this": a frame lost in that window would take the stream's only warmer with
 * it, silently. The owner answers `voice.hlsKeepWarmTaken` once its own loop
 * is running, and only that answer stops this loop. No answer — a dropped
 * frame, a bus that is down, an owner that went away between the row and the
 * frame — means this machine keeps warming, which is the fail-open rule below
 * applied to the one case that cannot be detected locally.
 *
 * WARMING IS THE FAIL-OPEN SIDE. An unstamped row, the registry off, a bus
 * that is off (nobody to hand the job to), or a lookup this process could not
 * make all leave the loop running: a rung warmed twice costs money, a rung
 * warmed by nobody costs the viewer who switches to it a third of a window
 * (which is the bug this loop exists to fix).
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

/**
 * Loops this process declined to run (or stopped) because another live
 * instance owns the session. Pitfall 12: a guard nobody can count is a guard
 * nobody knows is running. Belongs at zero on one machine, and non-zero within
 * a minute of a watch party running on two.
 */
let keepWarmDeclined = 0;

/** Loops this process armed because the OTHER machine handed the job over. */
let keepWarmAdopted = 0;

/**
 * "I have a viewer for this session and it is not mine to warm." Published by
 * the machine standing down, acted on by the owner and by nobody else: every
 * instance that hears it asks the same ownership question, and only the one
 * whose answer is "not somebody else's" arms anything. A third machine
 * therefore stays quiet instead of arming a loop that would only stand down
 * again and re-publish.
 */
const HLS_KEEP_WARM_TOPIC = "voice.hlsKeepWarm";

/**
 * "I have it" — the owner's answer, and the only thing that stops a non-owner's
 * loop. See the `STANDING DOWN` note above for why an unacknowledged hand-over
 * must not.
 */
const HLS_KEEP_WARM_TAKEN_TOPIC = "voice.hlsKeepWarmTaken";

/**
 * How often a machine waiting to be relieved re-asks. The ask is one small
 * frame and the answer ends it, so this only repeats while frames are being
 * lost — precisely when repeating is the point.
 */
const HLS_KEEP_WARM_HANDOVER_RETRY_MS = 6_000;

/** Per session, when this process last asked the owner to take over. */
const keepWarmHandovers = new Map<string, number>();

/** Per session, when the owner last relieved this process of it. */
const keepWarmRelievedAt = new Map<string, number>();

/**
 * How long a machine that has been relieved stays stood down before a viewer
 * request re-arms it and re-asks. This is the window in which an owner that
 * dies leaves its stream unwarmed, so it is deliberately much shorter than the
 * ownership answer's own TTL: the re-ask is cheap and self-cancelling (the
 * owner answers in a round trip, long before the re-armed loop's first tick),
 * while the alternative is a party going cold for half a minute every time a
 * machine goes away.
 */
const KEEP_WARM_REARM_MS = 5_000;

/** Loops handed to the owner over the bus. For metrics. */
export function hlsKeepWarmAdopted(): number {
  return keepWarmAdopted;
}

/**
 * The ownership answer per session, so the decision costs one query per
 * session per TTL rather than one per two-second tick. Short on purpose: the
 * owner can change mid-party (a deploy hands the session to the machine that
 * adopts it), and this is how long the new owner waits before warming.
 */
const KEEP_WARM_OWNER_TTL_MS = 30_000;
const keepWarmOwnership = new Map<string, { ownedElsewhere: boolean; at: number }>();

/**
 * An entry is only useful while it is inside its TTL, and a process that runs
 * for weeks sees every session the deployment ever streamed. Pruned on every
 * write rather than on a timer of its own: the map is read on a two-second
 * tick and written once per session per TTL, so the sweep is cheap and there
 * is no case where an entry outlives its own expiry by more than one write.
 */
const KEEP_WARM_OWNERSHIP_MAX = 256;

function pruneKeepWarmOwnership(now: number): void {
  // AMORTISED, not per refresh. Scanning the whole map on every refresh is
  // O(N) work per session per TTL — quadratic in the number of sessions a box
  // holds at once, for a map that in practice has single digits in it. Past
  // the bound (far above any real concurrent-session count) one scan clears
  // every expired entry at once, so the cost per write is O(1) amortised and
  // the map is still bounded by what is genuinely live.
  if (keepWarmOwnership.size <= KEEP_WARM_OWNERSHIP_MAX) {
    return;
  }
  for (const [key, entry] of keepWarmOwnership) {
    if (now - entry.at >= KEEP_WARM_OWNER_TTL_MS) {
      keepWarmOwnership.delete(key);
    }
  }
  for (const [key, at] of keepWarmHandovers) {
    if (now - at >= KEEP_WARM_OWNER_TTL_MS) {
      keepWarmHandovers.delete(key);
    }
  }
  for (const [key, at] of keepWarmRelievedAt) {
    if (now - at >= KEEP_WARM_OWNER_TTL_MS) {
      keepWarmRelievedAt.delete(key);
    }
  }
}

/** Sessions this process left to the machine that owns them. For metrics. */
export function hlsKeepWarmDeclined(): number {
  return keepWarmDeclined;
}

/**
 * Is somebody else warming this session? Cached both ways for
 * `KEEP_WARM_OWNER_TTL_MS`, and a failed lookup keeps the previous answer
 * rather than inventing one: "could not ask" is not "nobody owns it", and it
 * is not "somebody does" either.
 */
async function keepWarmOwnedElsewhere(
  channelId: string,
  startedAt: number,
  key: string,
  now: number,
): Promise<boolean | null> {
  const known = keepWarmOwnership.get(key);
  if (known && now - known.at < KEEP_WARM_OWNER_TTL_MS) {
    return known.ownedElsewhere;
  }
  const answer = await hlsSessionOwnedElsewhere({
    channelId,
    objectPrefix: hlsObjectPrefix(channelId, startedAt),
    prefixPattern: sessionPrefixPattern(channelId, startedAt),
  });
  if (answer === null) {
    return known?.ownedElsewhere ?? null;
  }
  pruneKeepWarmOwnership(now);
  keepWarmOwnership.set(key, { ownedElsewhere: answer, at: now });
  return answer;
}

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

/**
 * Playlist requests refused by the viewer capability, by reason, cumulative
 * since boot, for `liveHls.playlistRejectedByReason` on
 * `GET /api/admin/metrics`.
 *
 * WHY THIS IS A COUNTER AND NOT JUST THE LOG. `voice.hlsPlaylistRejected` is
 * rate-limited per channel per reason (30s) so it does not drown the log
 * during a rolling `expired` wave — which is exactly the wave that stalled
 * every web viewer in pitfall 16, and exactly the shape a "many rejections"
 * alert needs a true count of. This counts EVERY rejection, before that
 * suppression, so the level is real. Bounded by `HlsViewerTokenFailure`'s
 * seven values; never a user id, token or channel.
 */
const playlistRejections = new Map<HlsViewerTokenFailure, number>();

/** Record one playlist rejection. Called from the proxy route in api/index.ts. */
export function noteHlsPlaylistRejected(reason: HlsViewerTokenFailure): void {
  playlistRejections.set(reason, (playlistRejections.get(reason) ?? 0) + 1);
}

/** Snapshot for metrics: only reasons actually seen appear (bounded set). */
export function hlsPlaylistRejectionsByReason(): Record<string, number> {
  return Object.fromEntries(playlistRejections);
}

function touchKeepWarmSession(channelId: string, startedAt: number, now: number): void {
  const key = keepWarmSessionKey(channelId, startedAt);
  const loop = keepWarmLoops.get(key);
  if (loop) {
    loop.lastRequestedAt = now;
    return;
  }
  // Handed over and relieved: serve this viewer from the shared cache and
  // storage, and do not re-arm a loop the owner would only relieve again — but
  // only for KEEP_WARM_REARM_MS, NOT for the whole ownership TTL.
  //
  // THE OWNER CAN DIE BETWEEN TWO OF THESE. If it does, nothing tells this
  // process: the rows still name a machine whose heartbeat has not expired
  // yet, and the audience is here. So it re-arms, and asks again AT ONCE
  // rather than on the loop's first tick — a live owner answers in a round
  // trip and this loop is stopped before it has rendered anything, while a
  // dead one answers never and this machine simply keeps warming, which is the
  // whole fail-open rule. The cost of an owner dying is then seconds instead
  // of half a minute, and the cost of one that has not is one frame each way
  // per `KEEP_WARM_REARM_MS`, whatever the audience does in between.
  const known = keepWarmOwnership.get(key);
  const elsewhere =
    known?.ownedElsewhere === true && now - known.at < KEEP_WARM_OWNER_TTL_MS;
  if (elsewhere) {
    const relievedAt = keepWarmRelievedAt.get(key);
    if (relievedAt !== undefined && now - relievedAt < KEEP_WARM_REARM_MS) {
      return;
    }
    if (isBusEnabled()) {
      keepWarmHandovers.set(key, now);
      publishToCluster(HLS_KEEP_WARM_TOPIC, { channelId, startedAt });
    }
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
    // WHOSE SESSION IS THIS? Asked before anything is fetched, so a machine
    // that is not the owner never touches the bucket on the loop's account.
    // `null` (the lookup failed and nothing was known) leaves the loop running
    // and tries again next tick: warming twice is the cheap mistake.
    const ownedElsewhere = await keepWarmOwnedElsewhere(
      channelId,
      startedAt,
      key,
      now,
    );
    if (ownedElsewhere === true && isBusEnabled()) {
      // ASK, AND KEEP WARMING UNTIL THE ANSWER COMES. Stopping here on the
      // strength of a fire-and-forget publish is how a stream ends up with no
      // warmer at all: the transport drops frames while it reconnects, and
      // nothing local can tell that apart from a frame that arrived. The loop
      // stops in the `voice.hlsKeepWarmTaken` handler and nowhere else.
      // Re-asked on a slow cadence so a lost frame is retried without turning
      // a two-second tick into a two-second publish.
      const askedAt = keepWarmHandovers.get(key) ?? 0;
      if (now - askedAt >= HLS_KEEP_WARM_HANDOVER_RETRY_MS) {
        keepWarmHandovers.set(key, now);
        publishToCluster(HLS_KEEP_WARM_TOPIC, { channelId, startedAt });
      }
    }
    let rungs: (string | undefined)[];
    try {
      const { rungs: list } = await sessionRungs(channelId, startedAt, now);
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

/**
 * The other machine has a viewer for a session it does not own. Every instance
 * hears this; only the owner acts on it. `false` from the probe means "no LIVE
 * instance other than me owns this", which on the machine holding the rows is
 * exactly "mine", and on a third machine (A owns, C is neither) is `true`, so
 * C stays quiet. A frame for a session whose rows are gone arms a loop that
 * stops itself on its first render, which is the same self-limiting path an
 * ended session already takes.
 */
subscribeToCluster(HLS_KEEP_WARM_TOPIC, (data) => {
  if (
    !data ||
    typeof data !== "object" ||
    typeof (data as { channelId?: unknown }).channelId !== "string" ||
    typeof (data as { startedAt?: unknown }).startedAt !== "number"
  ) {
    return;
  }
  const { channelId, startedAt } = data as {
    channelId: string;
    startedAt: number;
  };
  const key = keepWarmSessionKey(channelId, startedAt);
  // OWNERSHIP IS ASKED FIRST, EVEN WHEN THIS PROCESS IS ALREADY WARMING — and
  // "I have a loop" is emphatically not a reason to answer. Three machines and
  // an owner that has stopped reading its bus: B and C both ask, and a handler
  // that answered on the strength of its own running loop would have B relieve
  // C and C relieve B, both of them believing the session is A's, both
  // stopping. Nobody would be warming and every counter would say the
  // hand-over worked. Only an instance whose own answer is "not somebody
  // else's" — the owner, and nobody else — may reply.
  void keepWarmOwnedElsewhere(channelId, startedAt, key, Date.now())
    .then((elsewhere) => {
      // `null` (could not ask) is not "mine": guessing would put a second
      // warmer back on the same session, which is the bug this file fixes.
      if (elsewhere !== false) {
        return;
      }
      if (keepWarmLoops.has(key)) {
        // Already warming it. The hand-over counts as a touch, so the owner's
        // idle timer follows the audience on the OTHER machine as well as its
        // own.
        keepWarmLoops.get(key)!.lastRequestedAt = Date.now();
      } else {
        keepWarmAdopted += 1;
        touchKeepWarmSession(channelId, startedAt, Date.now());
      }
      // Answered only once the loop is actually running, never on intent: the
      // asker stops warming on this frame, so it has to mean what it says.
      if (keepWarmLoops.has(key)) {
        publishToCluster(HLS_KEEP_WARM_TAKEN_TOPIC, { channelId, startedAt });
      }
    })
    .catch(() => {
      // The probe swallows its own failures; this is belt and braces so a
      // rejection can never reach the bus dispatcher.
    });
});

/**
 * The owner has the job. THE ONE PLACE A NON-OWNER'S LOOP STOPS: everything
 * else about this hand-over is fire-and-forget, and a loop that stops on an
 * unanswered ask is a stream nobody is warming.
 */
subscribeToCluster(HLS_KEEP_WARM_TAKEN_TOPIC, (data) => {
  if (
    !data ||
    typeof data !== "object" ||
    typeof (data as { channelId?: unknown }).channelId !== "string" ||
    typeof (data as { startedAt?: unknown }).startedAt !== "number"
  ) {
    return;
  }
  const { channelId, startedAt } = data as {
    channelId: string;
    startedAt: number;
  };
  const key = keepWarmSessionKey(channelId, startedAt);
  if (!keepWarmLoops.has(key)) {
    return;
  }
  // Only the machine that asked stands down, and only while it still believes
  // the session is somebody else's. Without this check the OWNER would stop
  // its own loop on hearing a third machine's answer.
  const known = keepWarmOwnership.get(key);
  if (!known?.ownedElsewhere) {
    return;
  }
  keepWarmDeclined += 1;
  // The ask is spent; the next re-arm asks again immediately. What holds that
  // re-arm off for a few seconds is the relieved-at stamp, not this.
  keepWarmHandovers.delete(key);
  keepWarmRelievedAt.set(key, Date.now());
  stopKeepWarmLoop(key);
});

/**
 * RIDING OUT A DATABASE OUTAGE WITHOUT FREEZING THE PICTURE.
 *
 * The only thing a rendition render asks Postgres is "is this session still
 * live" (`ended_at IS NULL`). Everything a viewer actually plays comes from
 * storage: the egress keeps writing segments and rewriting its playlist in
 * the bucket whether or not the API can reach its database. So when the
 * database cannot answer, the right move is to keep rendering FRESH from
 * storage on the strength of a recent "yes", not to replay the last body.
 *
 * What this replaced, and why it mattered on 2026-09-23. The first cut of
 * A3.1 (`renderCachedPlaylist`'s fallback) served the last RENDERED BODY
 * while the breaker was open, for at most 30 s. A live playlist that stops
 * advancing is a stall with extra steps: the player sits on the last listed
 * segment, drains its buffer, and after 30 s gets `database_unavailable`
 * anyway. The production blip that day lasted 61 s, so every viewer of a
 * conventional party would have frozen at about the 12 s mark and errored at
 * 30. And before the breaker even opens (5 s of failing probes), each render
 * sat on a dead pool connection for up to `query_timeout` (16 s) with every
 * viewer's poll coalesced behind it.
 *
 * So, per session:
 *  - a successful check stamps `liveConfirmed` (and a non-empty rung list
 *    from `sessionRungs` does too: the same `ended_at IS NULL` question);
 *  - a check that FAILS for any reason, or does not answer within
 *    `HLS_LIVENESS_WAIT_MS`, is ridden out when that stamp is younger than
 *    `STALE_ON_BREAKER_MAX_MS`: the render proceeds from storage;
 *  - a slow check keeps running, and a late "not live" still ends it: the
 *    stamp is cleared and the next render asks again, now with no stamp to
 *    lean on;
 *  - past the bound, or with no stamp at all, the error propagates exactly as
 *    before (a viewer's very first request during an outage is not served on
 *    trust nobody ever established).
 *
 * WHAT IS GIVEN UP, and why it is small. The check is there so a session that
 * ENDED 404s and the client follows the current one. During an outage an
 * ended session keeps being rendered for at most the bound, and what it
 * renders is its own final playlist from the bucket, which stops advancing
 * the moment the egress stops. Access is untouched: the viewer token was
 * minted after a real access check, and revocation (`isHlsAccessRevoked`) is
 * an in-memory lookup that works with the database down. A viewer loses
 * nothing they could not already see, for at most three minutes, and only
 * while the database is down.
 */
export const HLS_LIVENESS_WAIT_MS = 1_500;

/**
 * Last time Postgres said this is live, keyed two ways: by RENDITION
 * (`cacheKey`, from that rung's own check) and by SESSION
 * (`keepWarmSessionKey`, from any rung's check or a non-empty rung list). A
 * rendition may ride out an outage on either, unless it is itself known to
 * have ended: one rung ending (a ladder trimmed mid-party) says nothing about
 * its siblings, and must not take their fallback away.
 */
const liveConfirmed = new Map<string, number>();

/**
 * Renditions a check found ended, with the session each belongs to. Never
 * ridden out, whatever the session says. Pruned only once the session has no
 * fresh confirmation left, because until then a forgotten marker would let
 * the ended rung ride on its live siblings' stamp.
 */
const endedRungs = new Map<string, string>();
let endedRungsPruneAt = 1024;

/**
 * The liveness check in flight per rendition, shared. A render that stops
 * waiting for a slow check does not abandon it, and the next render (a
 * second later) joins it instead of starting another: on a database that is
 * slow rather than gone, one outstanding query per rendition, not one per
 * refresh piling onto the pool the fallback exists to spare.
 */
const livenessInflight = new Map<string, Promise<string | null>>();

/** The `hls_sessions.id` each rendition's last successful check returned. */
const rungSessionIds = new Map<string, string | null>();

/** Renders served from storage on a recent confirmation because the check failed or was slow. */
let rendersWithoutDb = 0;

/** For metrics: belongs at zero outside a database incident. */
export function hlsPlaylistRendersWithoutDb(): number {
  return rendersWithoutDb;
}

function stampLive(key: string, now: number): void {
  const previous = liveConfirmed.get(key) ?? 0;
  if (now > previous) {
    liveConfirmed.set(key, now);
  }
  // Bounded without a timer: a stamp older than the bound can no longer
  // excuse anything, so it is only memory.
  if (liveConfirmed.size > 512) {
    for (const [other, at] of liveConfirmed) {
      if (now - at > STALE_ON_BREAKER_MAX_MS) {
        liveConfirmed.delete(other);
      }
    }
  }
}

function noteSessionLive(channelId: string, startedAt: number, now: number): void {
  stampLive(keepWarmSessionKey(channelId, startedAt), now);
}

function freshStamp(key: string, now: number): boolean {
  const at = liveConfirmed.get(key);
  return at !== undefined && now - at <= STALE_ON_BREAKER_MAX_MS;
}

function canRideOutDbFailure(
  channelId: string,
  startedAt: number,
  rungKey: string,
  now: number,
): boolean {
  if (endedRungs.has(rungKey)) {
    return false;
  }
  return (
    freshStamp(rungKey, now) ||
    freshStamp(keepWarmSessionKey(channelId, startedAt), now)
  );
}

type DbRead<T> =
  | { kind: "ok"; value: T }
  | { kind: "failed"; error: unknown }
  | { kind: "slow" };

/** Wait at most `waitMs` for `lookup`; the lookup itself is never abandoned. */
async function readWithin<T>(lookup: Promise<T>, waitMs: number): Promise<DbRead<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<DbRead<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "slow" }), waitMs);
    timer.unref?.();
  });
  const settled = lookup.then(
    (value): DbRead<T> => ({ kind: "ok", value }),
    (error: unknown): DbRead<T> => ({ kind: "failed", error }),
  );
  try {
    return await Promise.race([settled, slow]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One rendition's `ended_at IS NULL` check, shared while in flight (see
 * `livenessInflight`), recording its answer whoever is still waiting for
 * it: a late "ended" still ends the rendition.
 */
function livenessCheck(
  channelId: string,
  startedAt: number,
  objectPrefix: string,
  rungKey: string,
  now: number,
): Promise<string | null> {
  const existing = livenessInflight.get(rungKey);
  if (existing) {
    return existing;
  }
  const check = getPool()
    .query<{ id: string }>(
      `SELECT id FROM hls_sessions
       WHERE channel_id = $1
         AND object_prefix = $2
         AND ended_at IS NULL
         AND cleaned_at IS NULL`,
      [channelId, objectPrefix],
    )
    .then((session) => {
      if (!session.rowCount) {
        // This rendition is over: forget its window and its segment-URL memo
        // too, so neither map keeps one entry per session this process ever
        // served, and make sure an outage cannot resurrect it. Its siblings'
        // evidence is theirs and is left alone.
        windowHistory.delete(rungKey);
        segmentUrlMemo.delete(rungKey);
        rungSessionIds.delete(rungKey);
        liveConfirmed.delete(rungKey);
        // Amortised: a pass that could not shrink the map raises the
        // threshold, so a large, still-live set is not rescanned per insert.
        if (endedRungs.size > endedRungsPruneAt) {
          for (const [ended, session] of endedRungs) {
            if (!freshStamp(session, now)) {
              endedRungs.delete(ended);
            }
          }
          endedRungsPruneAt = Math.max(1024, endedRungs.size * 2);
        }
        endedRungs.set(rungKey, keepWarmSessionKey(channelId, startedAt));
        throw new HlsPlaylistNotFound(
          `No live HLS session ${objectPrefix} for channel ${channelId}`,
        );
      }
      const id = session.rows?.[0]?.id ?? null;
      rungSessionIds.set(rungKey, id);
      endedRungs.delete(rungKey);
      stampLive(rungKey, now);
      noteSessionLive(channelId, startedAt, now);
      return id;
    })
    .finally(() => {
      livenessInflight.delete(rungKey);
    });
  // Nobody may be waiting by the time it settles.
  check.catch(() => {});
  livenessInflight.set(rungKey, check);
  return check;
}

/**
 * The liveness check for one rendition, with the outage rules in the block
 * above. Resolves to the rendition's `hls_sessions.id`, or throws
 * `HlsPlaylistNotFound` when it is over.
 */
async function confirmSessionLive(
  channelId: string,
  startedAt: number,
  objectPrefix: string,
  rungKey: string,
  now: number,
): Promise<string | null> {
  const check = livenessCheck(channelId, startedAt, objectPrefix, rungKey, now);
  if (!canRideOutDbFailure(channelId, startedAt, rungKey, now)) {
    return check;
  }
  const read = await readWithin(check, HLS_LIVENESS_WAIT_MS);
  if (read.kind === "ok") {
    return read.value;
  }
  if (read.kind === "failed" && read.error instanceof HlsPlaylistNotFound) {
    throw read.error;
  }
  rendersWithoutDb += 1;
  return rungSessionIds.get(rungKey) ?? null;
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
  const rungKey = cacheKey(channelId, startedAt, rung);
  const sessionId = await confirmSessionLive(
    channelId,
    startedAt,
    objectPrefix,
    rungKey,
    now,
  );
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
  const history = historyFor(cacheKey(channelId, startedAt, rung));
  const body = widenLivePlaylist(history, await response.text(), undefined, now);
  const ttl = hlsUrlTtlSeconds();
  // Quantised, never `new Date()`: see `segmentSigningTime` above. A segment
  // appearing for the first time is signed at this instant; one already in
  // the memo keeps the URL it was first handed out under (see the memo above).
  const signedAt = segmentSigningTime(now, ttl);
  const prefixDir = `${objectPrefix.split("/").slice(0, -1).join("/")}/`;

  const segmentBase = hlsSegmentBaseUrl();
  const memoKey = cacheKey(channelId, startedAt, rung);
  const memo = segmentMemoFor(memoKey);
  const present = new Set<string>();
  // A memoised URL is reused unless it would expire while still listed, which
  // only a huge-window + short-TTL operator config can produce: re-signing a
  // listed segment costs one hitch, serving an expired URL costs a 403.
  const ttlMs = ttl * 1_000;
  const reuseGuardMs = Math.min(ttlMs / 3, SEGMENT_URL_BUCKET_MAX_MS);

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
      present.add(key);
      const existing = memo.get(key);
      // A memoised URL from the OTHER delivery mode is not reused: flipping
      // `LIVE_HLS_SEGMENT_BASE_URL` mid-party moves every listed segment on
      // the next render (one refetch for AVPlayer, the same cost a bucket
      // boundary has) rather than leaving the window split between two hosts
      // for as long as the memo lives.
      if (
        existing &&
        now - existing.signedAtMs < ttlMs - reuseGuardMs &&
        existing.segmentBase === segmentBase
      ) {
        return existing.url;
      }
      // SEGMENTS AT THE EDGE (`LIVE_HLS_SEGMENT_BASE_URL`, see
      // `hls-segment-token.ts`): the same quantised instant, so a segment
      // keeps one URL for its whole life in the window whichever way it is
      // served. Null (flag off, no key, a line the edge cannot name) falls
      // through to the presigned R2 URL every deployment had before.
      const url =
        (segmentBase
          ? edgeSegmentUrl({
              base: segmentBase,
              channelId,
              startedAt,
              rung,
              key,
              signedAtMs: signedAt.getTime(),
              ttlSeconds: ttl,
            })
          : null) ??
        signRequest({
          method: "GET",
          key,
          ttlSeconds: ttl,
          forRead: true,
          config,
          now: signedAt,
          query: { "response-cache-control": SEGMENT_CACHE_CONTROL },
        }).url;
      memo.set(key, { url, signedAtMs: signedAt.getTime(), segmentBase });
      return url;
    })
    .join("\n");

  // Evict any segment that has left this render's window, so the memo can
  // never grow past the segments actually listed.
  for (const key of memo.keys()) {
    if (!present.has(key)) {
      memo.delete(key);
    }
  }

  return withPqpSessionTag(rewritten, sessionId);
}

/**
 * `X-Pqp-Playlist-Age-Ms` (BROADCAST_PIPELINE B0.3): how stale, in
 * milliseconds, the freshest segment in this render already was when it was
 * served -- `now` minus the wall clock this process first saw that segment
 * listed (`LiveWindowHistory.newestFirstSeenAt`). Null when nothing has been
 * rendered for this rendition yet (a viewer's very first request, before
 * `buildSignedPlaylist` has populated the history), in which case the route
 * omits the header rather than sending a lie.
 *
 * Reads the same in-process history `buildSignedPlaylist` just populated, so
 * call this AFTER awaiting it, not before.
 */
export function hlsPlaylistAgeMs(
  channelId: string,
  startedAt: number,
  rung?: string,
  now = Date.now(),
): number | null {
  const history = windowHistory.get(cacheKey(channelId, startedAt, rung));
  const firstSeenAt = history?.newestFirstSeenAt ?? null;
  return firstSeenAt === null ? null : Math.max(0, now - firstSeenAt);
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
interface SessionRungs {
  rungs: string[];
  /**
   * One `hls_sessions.id` representing the whole party for the
   * `#EXT-X-PQP-SESSION` tag on the master (BROADCAST_PIPELINE B0.4): the
   * lowest-bitrate row, same tiebreak the rungs themselves are ordered by
   * plus `id` for determinism when two rows share a `started_at`. Null only
   * when there are no rungs at all.
   */
  sessionId: string | null;
}

const rungCache = new Map<
  string,
  { rungs?: SessionRungs; inflight?: Promise<SessionRungs>; at: number }
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
): Promise<SessionRungs> {
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
      return rungsWithin(cached.inflight, cached.rungs, cached.at, now);
    }
  }
  const inflight = getPool()
    .query<{ id: string; rung: string | null }>(
      `SELECT id, rung FROM hls_sessions
       WHERE channel_id = $1
         AND object_prefix LIKE $2
         AND rung IS NOT NULL
         AND ended_at IS NULL
         AND cleaned_at IS NULL
       ORDER BY started_at ASC, id ASC`,
      [channelId, sessionPrefixPattern(channelId, startedAt)],
    )
    .then((rows) => {
      const known = (rows.rows ?? []).filter((row) =>
        Boolean(row.rung && LADDER_RUNGS[row.rung]),
      );
      // The canonical session id is the LOWEST-bitrate rung's row -- the one
      // `buildMasterPlaylistFor`'s callers always have a variant for and the
      // one a viewer with no explicit pick lands on -- not whichever row this
      // query happened to return first. `started_at, id` orders the SQL
      // result deterministically; it says nothing about bitrate (a Farol
      // finding, 2026-09-13: `ORDER BY started_at ASC, id ASC` was read as if
      // it also meant "lowest bitrate first").
      const byBitrate = [...known].sort((a, b) => {
        const kbpsA = hlsRungVideoKbps(a.rung!) ?? Number.MAX_SAFE_INTEGER;
        const kbpsB = hlsRungVideoKbps(b.rung!) ?? Number.MAX_SAFE_INTEGER;
        return kbpsA !== kbpsB ? kbpsA - kbpsB : a.id.localeCompare(b.id);
      });
      const result: SessionRungs = {
        rungs: known.map((row) => row.rung!),
        sessionId: byBitrate[0]?.id ?? null,
      };
      rungCache.set(key, { rungs: result, at: now });
      // Non-empty is the same `ended_at IS NULL` answer a rendition check
      // gives. Empty is NOT "ended": a pre-ladder session has no rung rows.
      if (result.rungs.length > 0) {
        noteSessionLive(channelId, startedAt, now);
      }
      return result;
    })
    .catch((error: unknown) => {
      // A3.1: the breaker is open. Same reasoning as `renderCachedPlaylist`'s
      // fallback — the rung list rarely changes mid-party, so the last list
      // this process read is still almost certainly right, and serving it
      // keeps the master playlist (and therefore every rendition it points
      // at) answering through a DB blip instead of 503ing viewers who are
      // mid-ladder-switch.
      //
      // Any failure, not only the breaker's own error: in the seconds before
      // the breaker opens, the same outage arrives as a connection timeout.
      if (
        cached?.rungs !== undefined &&
        now - cached.at <= STALE_ON_BREAKER_MAX_MS
      ) {
        rungCache.set(key, { rungs: cached.rungs, at: cached.at });
        return cached.rungs;
      }
      // Same rule as the playlist cache: a failed read is not remembered.
      rungCache.delete(key);
      throw error;
    });
  rungCache.set(key, { ...cached, inflight, at: cached?.at ?? 0 });
  return rungsWithin(inflight, cached?.rungs, cached?.at ?? 0, now);
}

/**
 * A known rung list and a database that is slow to answer: do not hold a
 * master request (a player recovering, a viewer switching) behind a dead pool
 * connection for `query_timeout`. The query keeps running and refreshes the
 * cache when it lands. Without a list young enough to trust, this is just
 * `inflight`.
 */
async function rungsWithin(
  inflight: Promise<SessionRungs>,
  known: SessionRungs | undefined,
  knownAt: number,
  now: number,
): Promise<SessionRungs> {
  if (known === undefined || now - knownAt > STALE_ON_BREAKER_MAX_MS) {
    return inflight;
  }
  const read = await readWithin(inflight, HLS_LIVENESS_WAIT_MS);
  if (read.kind === "ok") {
    return read.value;
  }
  if (read.kind === "slow") {
    void inflight.catch(() => {});
  }
  return known;
}

/**
 * The canonical `hls_sessions.id` for a channel/`startedAt` pair -- the SAME
 * string the master playlist's `#EXT-X-PQP-SESSION` tag carries
 * (`buildMasterPlaylistFor` below reads it off this same `sessionRungs`) and
 * `voice.hlsStarted` logs as `sessionId` (`primary.sessionId` in
 * `hls-egress.ts`, the lowest-bitrate rung -- the same tiebreak this
 * function's own sort uses). `hls-latency-metrics.ts`'s telemetry route
 * calls this so an accepted batch's recorded session id is the one a human
 * can actually join against the egress log by equality, rather than a
 * `channelId:startedAt` pair that reads the same to a person but is a
 * different string (a Farol finding, 2026-09-14). Null when the session has
 * no known rungs right now -- ended, not yet recorded, or an operator
 * downgraded past what this build's ladder knows -- in which case the
 * caller falls back to its own opaque label rather than losing the batch.
 *
 * Shares `sessionRungs`'s cache, so this is a fresh query only on a cache
 * miss: in practice never, because the same session's own viewers are
 * already polling the master playlist (and so keeping the cache warm) at
 * the same time they are sampled for telemetry.
 */
export async function resolveHlsSessionId(
  channelId: string,
  startedAt: number,
  now: number = Date.now(),
): Promise<string | null> {
  try {
    const { sessionId } = await sessionRungs(channelId, startedAt, now);
    return sessionId;
  } catch {
    // A failed lookup (the pool is unhappy, say) must not turn a telemetry
    // batch into a 500 -- this is a measurement, not a critical path. The
    // caller's own fallback label covers it.
    return null;
  }
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
 * URL here would do neither. And because the URI is root-relative, a master
 * served THROUGH the edge Worker (`LIVE_HLS_PLAYLIST_BASE_URL`) resolves its
 * variant lines against the EDGE host, not this API — the same "no client
 * rebuild" trick `stampViewerStream` relies on for the session URL itself.
 *
 * EVERY VARIANT ALSO CARRIES A FRESH PARTY PASS, NOT JUST THE TOKEN. This
 * was a real gap, not a cosmetic one: `stampViewerStream` stamps `?pp=` onto
 * the SESSION url a viewer is initially handed, but once that session has
 * run a ladder, the session url IS this master, and the URIs a player
 * actually polls every 2-4s are the VARIANT lines below -- which, before
 * this, carried only `?t=`. A party pass that never reaches the edge
 * Worker's rendition route is useless there, so for any session that ever
 * ran a ladder (the normal case), `?pp=` was live on the initial fetch and
 * then silently dropped from every subsequent poll the moment the master
 * was rendered. Minting fresh here (rather than trying to forward the
 * caller's own `?pp=`, which the edge Worker deliberately never looks at on
 * THIS route -- see its own module doc comment) needs nothing from the
 * caller: this function already has `userId` from the same access check
 * that authorized the request. Gated on `playlistBaseUrl()` for the same
 * reason `stampViewerStream` gates it: a pass nobody's Worker will ever
 * check is wasted bytes on every variant line.
 *
 * A session with no rung rows at all is a pre-ladder session: its single
 * media playlist is served directly, so an in-flight viewer from before this
 * deploy is not handed a master listing nothing.
 */
export async function buildMasterPlaylistFor(input: {
  channelId: string;
  startedAt: number;
  userId: string;
  /** The `?t=` the request arrived with, stamped onto each variant. */
  token?: string | null;
  now?: number;
}): Promise<string | null> {
  const { rungs, sessionId } = await sessionRungs(
    input.channelId,
    input.startedAt,
    input.now ?? Date.now(),
  );
  if (rungs.length === 0) {
    return null;
  }
  const now = input.now ?? Date.now();
  const partyPass = playlistBaseUrl()
    ? mintHlsPartyPass({
        userId: input.userId,
        channelId: input.channelId,
        startedAt: input.startedAt,
        now,
      })
    : null;
  const params = new URLSearchParams();
  if (input.token) {
    params.set(HLS_VIEWER_TOKEN_PARAM, input.token);
  }
  if (partyPass) {
    params.set(HLS_PARTY_PASS_PARAM, partyPass);
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const variants: MasterVariant[] = rungs.map((rung) => ({
    rung: LADDER_RUNGS[rung]!,
    uri:
      `/api/voice/hls-playlist/${encodeURIComponent(input.channelId)}` +
      `/${input.startedAt}/${encodeURIComponent(rung)}${query}`,
  }));
  return buildMasterPlaylist(variants, sessionId);
}
