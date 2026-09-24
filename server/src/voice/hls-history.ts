/**
 * Past broadcasts for a watch-party channel: "Transmissões anteriores".
 *
 * WHAT A "SESSION" IS HERE. `hls_sessions` is scoped to one egress run per
 * RUNG (`docs/WATCH_PARTY.md`, `hls-egress.ts`), so one broadcast is several
 * rows sharing `(channel_id, started_at)` -- one per ladder rendition, plus
 * an optional `mic` archive and `cam360p30` camera pip row that are
 * deliberately not ladder rungs (see `MIC_ARCHIVE_RUNG` / `CAMERA_RUNG_NAME`).
 * This file groups by that pair to answer "one row per broadcast" the way a
 * moderator thinks about it, and treats `keep_replay` as a property of the
 * WHOLE broadcast: toggling it writes every row in the group (ladder rungs,
 * the mic archive and the camera pip together), so the retention sweep keeps
 * or drops them as one unit rather than leaving, say, the audio-only mic file
 * behind after the picture is gone.
 *
 * WHERE THE PRESENTER COMES FROM. `hls_sessions` carries no user id --
 * `presenter_peer_id` is an ephemeral LiveKit peer id, and the schema comment
 * on the table says in so many words that reconciling it with
 * `channel_sessions` (the party/event row, which DOES have `host_user_id`) is
 * future work, not done here. So the presenter is a best-effort join: the
 * `channel_sessions` row for this channel whose `went_live_at` is the latest
 * one at or before this broadcast's `started_at`. That is the host, not
 * necessarily whoever was on stage at any given second (a co-host can also
 * stream), but it is the only identity this schema can answer today without
 * inventing a column. A broadcast predating `channel_sessions.host_user_id`
 * (backfilled from `created_by`, see schema.sql) or with no matching party
 * row at all gets `presenter: null` rather than a guess.
 *
 * WHY NO PEAK-VIEWER COUNT. Nothing durable is ever recorded: the live
 * viewer count is derived from the roster at request time
 * (`liveStateFromRoster` in `@pqp/shared`) and never written anywhere. There
 * is no column and no metric to read it back from, so the field is left off
 * the response entirely rather than invented.
 *
 * AVAILABILITY IS "EVERY LADDER RUNG", NOT "ANY OF THEM", AND MIRRORS THE
 * SWEEP EXACTLY. `sessionReplayAvailable` requires every ladder-rung row of
 * the group (mic/camera excluded -- see above) to satisfy the negation of
 * `dueSessions`' WHERE clause in `hls-cleanup.ts`: not cleaned, and either not
 * `keep_replay` and younger than `LIVE_HLS_RETENTION_MINUTES`, or `keep_replay`
 * and younger than `LIVE_HLS_REPLAY_HOURS`. ANY-of-them would mark a broadcast
 * replayable after one of its renditions was swept and the rest were not,
 * which hands the master playlist an incomplete ladder while the client still
 * offers Watch and Keep recording as if the whole thing were intact. And
 * approximating with `cleaned_at IS NULL` alone, rather than the exact
 * predicate, is what CLAUDE.md's "a finished session went on answering as if
 * it were live" pitfall was about: `cleaned_at` lags the real window by up to
 * one sweep tick (60s), so a session can be past its window and still show
 * `cleaned_at IS NULL`. The replay-SERVING functions below (not just the
 * mint/list/patch ones) re-check this same predicate on every request, not
 * only `ended_at`/`cleaned_at`: a 60-minute viewer token easily outlives a
 * 10-minute default retention window, and without the re-check a request late
 * in that gap would keep being served after the history API already reports
 * the broadcast gone.
 */
import { PassThrough, Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { getPool } from "../db.js";
import { listObjects, signRequest } from "../lib/s3.js";
import {
  hlsObjectPrefix,
  hlsReplayHours,
  hlsRetentionMinutes,
  hlsUrlTtlSeconds,
  liveHlsStorageConfig,
  micArchiveObjectKey,
  MIC_ARCHIVE_RUNG,
} from "./hls-egress.js";
import {
  buildMasterPlaylist,
  CAMERA_RUNG_NAME,
  LADDER_RUNGS,
  type MasterVariant,
} from "./hls-ladder.js";
import { HlsPlaylistNotFound, HlsPlaylistUnavailable } from "./hls-playlist-proxy.js";
import { HLS_VIEWER_TOKEN_PARAM } from "./hls-viewer-token.js";
import {
  type HlsRun,
  parseHlsRuns,
  stitchRunPlaylists,
} from "./hls-runs.js";
import { firstPts, TsTimestampShift } from "./ts-timestamp-shift.js";

const LADDER_RUNG_NAMES = Object.keys(LADDER_RUNGS);
const REQUEST_TIMEOUT_MS = 10_000;

/** The exact "still available" predicate, inlined into every query that
 * decides whether a row's segments are still there -- one string so the
 * mint-time check and the serve-time check cannot drift apart. */
const AVAILABLE_PREDICATE = `
  cleaned_at IS NULL
  AND ended_at IS NOT NULL
  AND (
    (keep_replay = FALSE AND ended_at >= NOW() - ($retentionParam || ' minutes')::interval)
    OR (keep_replay = TRUE AND ended_at >= NOW() - ($replayParam || ' hours')::interval)
  )
`;

/** `AVAILABLE_PREDICATE` with its named placeholders bound to real `$n`
 * positions, so every call site stays in sync with whatever positions it
 * actually passes. */
function availablePredicate(retentionParam: number, replayParam: number): string {
  return AVAILABLE_PREDICATE.replace(
    "$retentionParam",
    `$${retentionParam}`,
  ).replace("$replayParam", `$${replayParam}`);
}

export interface WatchPartyHistoryEntry {
  /** The broadcast's `started_at`, epoch milliseconds, as a string. Stable
   * across the list/patch/replay routes -- it is the same value `hls-egress.ts`
   * already uses to name the session in the live playlist URL. */
  sessionId: string;
  /** The party's own title (`channel_sessions.title` at the time of this
   * broadcast), falling back to the channel's name when no `channel_sessions`
   * row matches -- see the presenter join's comment below for why that can
   * happen. Never empty: the channel name always exists. */
  title: string;
  startedAt: string;
  /** Null while the broadcast is still live (at least one rung has not ended). */
  endedAt: string | null;
  durationSeconds: number | null;
  presenter: { userId: string; displayName: string } | null;
  replayAvailable: boolean;
  keepReplay: boolean;
  /**
   * How many people watched (`hls-viewer-counts.ts`): the most at once and
   * the distinct accounts. Null for a broadcast from before the count
   * existed, or one nobody watched. Up to a minute behind while live.
   */
  viewers: { peak: number; unique: number } | null;
}

interface HistoryRow {
  started_at: Date;
  started_at_ms: string;
  ended_at: Date | null;
  keep_replay: boolean;
  replay_available: boolean;
  presenter_user_id: string | null;
  presenter_display_name: string | null;
  title: string;
  peak_viewers: number | null;
  unique_viewers: number | null;
}

/** Newest first, capped by `limit`. */
export async function listWatchPartyHistory(
  channelId: string,
  limit: number,
): Promise<WatchPartyHistoryEntry[]> {
  const result = await getPool().query<HistoryRow>(
    `WITH sessions AS (
       SELECT
         channel_id,
         started_at,
         BOOL_OR(keep_replay) AS keep_replay,
         (COUNT(*) FILTER (WHERE ended_at IS NULL) = 0) AS all_ended,
         MAX(ended_at) AS ended_at,
         -- EVERY ladder-rung row of the group has to still be available, not
         -- just one of them -- see the file header on why ANY-of-them is
         -- wrong here.
         BOOL_AND(${availablePredicate(3, 4)}) AS fully_available
       FROM hls_sessions
       WHERE channel_id = $1
         AND (rung IS NULL OR rung = ANY($5::text[]))
       GROUP BY channel_id, started_at
       ORDER BY started_at DESC
       LIMIT $2
     )
     SELECT
       s.started_at,
       (EXTRACT(EPOCH FROM s.started_at) * 1000)::bigint AS started_at_ms,
       CASE WHEN s.all_ended THEN s.ended_at END AS ended_at,
       s.keep_replay,
       (s.all_ended AND s.fully_available) AS replay_available,
       presenter.user_id AS presenter_user_id,
       presenter.display_name AS presenter_display_name,
       COALESCE(presenter.title, c.name) AS title,
       vs.peak_viewers,
       vs.unique_viewers
     FROM sessions s
     JOIN channels c ON c.id = s.channel_id
     LEFT JOIN hls_session_viewer_stats vs
       ON vs.channel_id = s.channel_id
      AND vs.started_at_ms = (EXTRACT(EPOCH FROM s.started_at) * 1000)::bigint
     LEFT JOIN LATERAL (
       SELECT cs.host_user_id AS user_id, u.display_name, cs.title
       FROM channel_sessions cs
       JOIN users u ON u.id = cs.host_user_id
       WHERE cs.channel_id = s.channel_id
         AND cs.host_user_id IS NOT NULL
         AND cs.went_live_at IS NOT NULL
         AND cs.went_live_at <= s.started_at
       ORDER BY cs.went_live_at DESC
       LIMIT 1
     ) presenter ON TRUE
     ORDER BY s.started_at DESC`,
    [channelId, limit, hlsRetentionMinutes(), hlsReplayHours(), LADDER_RUNG_NAMES],
  );
  return result.rows.map((row) => ({
    sessionId: String(Number(row.started_at_ms)),
    title: row.title,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    durationSeconds: row.ended_at
      ? Math.max(
          0,
          Math.round((row.ended_at.getTime() - row.started_at.getTime()) / 1000),
        )
      : null,
    presenter: row.presenter_user_id
      ? {
          userId: row.presenter_user_id,
          displayName: row.presenter_display_name ?? "",
        }
      : null,
    replayAvailable: row.replay_available,
    keepReplay: row.keep_replay,
    viewers:
      row.unique_viewers !== null && row.unique_viewers > 0
        ? { peak: row.peak_viewers ?? 0, unique: row.unique_viewers }
        : null,
  }));
}

/** Used by the replay-URL route: does this broadcast exist, and can it still
 * be watched (every ladder-rung row still available)? */
export type WatchPartyHistoryLookup = "ok" | "not-found" | "unavailable";

export async function checkWatchPartyReplayAccess(
  channelId: string,
  startedAtMs: number,
): Promise<WatchPartyHistoryLookup> {
  const result = await getPool().query<{
    has_rows: boolean;
    has_ladder: boolean;
    fully_available: boolean;
  }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM hls_sessions
         WHERE channel_id = $1 AND started_at = to_timestamp($2 / 1000.0)
       ) AS has_rows,
       EXISTS (
         SELECT 1 FROM hls_sessions
         WHERE channel_id = $1 AND started_at = to_timestamp($2 / 1000.0)
           AND (rung IS NULL OR rung = ANY($5::text[]))
       ) AS has_ladder,
       NOT EXISTS (
         SELECT 1 FROM hls_sessions
         WHERE channel_id = $1 AND started_at = to_timestamp($2 / 1000.0)
           AND (rung IS NULL OR rung = ANY($5::text[]))
           AND NOT (${availablePredicate(3, 4)})
       ) AS fully_available`,
    [channelId, startedAtMs, hlsRetentionMinutes(), hlsReplayHours(), LADDER_RUNG_NAMES],
  );
  const row = result.rows[0];
  if (!row?.has_rows) {
    return "not-found";
  }
  return row.has_ladder && row.fully_available ? "ok" : "unavailable";
}

/**
 * Flips `keep_replay` on every row of the broadcast (every ladder rung, the
 * mic archive and the camera pip alike), so the retention sweep keeps or
 * drops the whole thing together. Refuses once the segments are already gone
 * -- there is nothing left to keep, in either direction.
 *
 * `SELECT ... FOR UPDATE` FIRST, THEN CHECK, THEN WRITE -- NOT A CTE
 * COMPUTING ELIGIBILITY IN ONE SHOT. An earlier version folded the
 * eligibility check and the `UPDATE` into one statement via a CTE, reasoning
 * that one statement could not have a gap a concurrent sweep lands in. It
 * still could: a CTE referenced more than once is materialised rather than
 * inlined, computed ONCE against the snapshot at the start of the statement.
 * If `sweepHlsSessions` holds a row lock on one of these rows when this
 * statement starts, the `UPDATE` blocks waiting for it, but Postgres's
 * conflict re-check (EvalPlanQual) re-applies only the `UPDATE`'s own WHERE
 * clause to the new row version -- it does not re-run the materialised CTE
 * that clause reads from. So the write could still land using the
 * PRE-sweep "available" answer, against a row the sweep had just cleaned out
 * from under it, and this function would still report "ok".
 *
 * Locking the rows explicitly closes that: whichever of this call and the
 * sweep's own `UPDATE ... WHERE id = $1` reaches a row first holds it until
 * it commits or rolls back, and the loser's next read (this transaction's
 * `SELECT ... FOR UPDATE`, or the sweep's own `WHERE ... AND ended_at IS NOT
 * NULL` filter re-run against a since-changed row) sees the finished result
 * rather than the state before it. Same pattern as `votePoll` in
 * `services/polls.ts`.
 */
export async function setWatchPartyKeepReplay(
  channelId: string,
  startedAtMs: number,
  keepReplay: boolean,
): Promise<WatchPartyHistoryLookup> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const rows = await client.query<{
      id: string;
      rung: string | null;
      cleaned_at: Date | null;
      ended_at: Date | null;
      keep_replay: boolean;
    }>(
      `SELECT id, rung, cleaned_at, ended_at, keep_replay
       FROM hls_sessions
       WHERE channel_id = $1 AND started_at = to_timestamp($2 / 1000.0)
       FOR UPDATE`,
      [channelId, startedAtMs],
    );
    if (rows.rows.length === 0) {
      await client.query("ROLLBACK");
      return "not-found";
    }
    const ladderRungs = new Set(LADDER_RUNG_NAMES);
    const isAvailable = (row: (typeof rows.rows)[number]): boolean => {
      if (row.cleaned_at !== null || row.ended_at === null) {
        return false;
      }
      // `<=`, not `<`, to match every SQL form of this predicate elsewhere
      // in this file (`ended_at >= NOW() - interval`).
      const ageMs = Date.now() - row.ended_at.getTime();
      return row.keep_replay
        ? ageMs <= hlsReplayHours() * 60 * 60 * 1000
        : ageMs <= hlsRetentionMinutes() * 60 * 1000;
    };
    const ladderRows = rows.rows.filter(
      (row) => row.rung === null || ladderRungs.has(row.rung),
    );
    const eligible = ladderRows.length > 0 && ladderRows.every(isAvailable);
    if (!eligible) {
      await client.query("ROLLBACK");
      return "unavailable";
    }
    await client.query(
      `UPDATE hls_sessions SET keep_replay = $2 WHERE id = ANY($1::uuid[])`,
      [rows.rows.map((row) => row.id), keepReplay],
    );
    await client.query("COMMIT");
    return "ok";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// --------------------------------------------------------------------------
// Serving the replay itself.
//
// LiveKit's `SegmentedFileOutput` already writes TWO playlists per rung: the
// rolling `livePlaylistName` the live proxy serves (`hls-playlist-proxy.ts`,
// deliberately refuses anything with `ended_at` set -- see that file's
// comment on the production incident that taught it to), and a second,
// ever-growing `playlistName` ("`<prefix>-index.m3u8`") that accumulates
// every segment for the whole run and is what a finished broadcast's replay
// actually is. So replay needs no playlist assembly of its own: it rewrites
// that existing object's segment lines into signed URLs, the same way the
// live proxy does, and serves it under its OWN path
// (`/api/voice/hls-replay/...`) rather than teaching the live one a second
// mode -- the live path's `ended_at IS NULL` guard is exactly the fix for a
// past incident and is not something this feature should loosen.
// --------------------------------------------------------------------------

function replayObjectKey(
  channelId: string,
  startedAt: number,
  rung: string | undefined,
): string {
  return `${hlsObjectPrefix(channelId, startedAt, rung)}-index.m3u8`;
}

/** A finished broadcast's segments do not change, so this is cheap to hold
 * for a while -- unlike the live proxy's 1s cache, which exists because the
 * underlying playlist is still being rewritten every segment.
 *
 * PRUNED ON EVERY INSERT, not just consulted by TTL. A viewer touches a
 * distinct `(channel, startedAt, rung)` key at most a handful of times, so
 * without eviction every broadcast and rendition ever requested by a
 * long-running process adds a permanent entry -- unbounded growth for a
 * process that is never restarted. `pruneStale` below is the same one-line
 * sweep on both maps. */
const REPLAY_CACHE_TTL_MS = 30_000;
const replayBodyCache = new Map<string, { body: string; at: number }>();
const replayRungCache = new Map<string, { rungs: string[]; at: number }>();
const llReplayMasterCache = new Map<string, { body: string | null; at: number }>();
const llReplayMasterInFlight = new Map<string, Promise<string | null>>();

function pruneStale<K, V extends { at: number }>(
  cache: Map<K, V>,
  now: number,
): void {
  for (const [key, value] of cache) {
    if (now - value.at >= REPLAY_CACHE_TTL_MS) {
      cache.delete(key);
    }
  }
}

export function resetHlsReplayCachesForTests(): void {
  replayBodyCache.clear();
  replayRungCache.clear();
  llReplayMasterCache.clear();
  llReplayMasterInFlight.clear();
}

/**
 * ALL OR NOTHING, matching `checkWatchPartyReplayAccess`'s definition of
 * "available" exactly: every ladder row of the broadcast, not just the ones
 * that still individually pass. Returning whichever rungs currently happen
 * to survive would let an already-minted master playlist quietly advertise
 * fewer renditions than the broadcast actually had (or, worse, disagree with
 * what `GET .../history` told the caller was available at all) the moment
 * one rung's `ended_at` falls out of its window slightly ahead of its
 * siblings -- rare since `setWatchPartyKeepReplay` now writes `keep_replay`
 * to every row atomically, but LiveKit can still stamp `ended_at` unevenly
 * across rungs (a stalled rendition stopped on its own, see
 * `docs/WATCH_PARTY.md` "When a session restarts").
 */
async function replaySessionRungs(
  channelId: string,
  startedAt: number,
  now: number,
): Promise<string[]> {
  const key = `${channelId}:${startedAt}`;
  const cached = replayRungCache.get(key);
  if (cached && now - cached.at < REPLAY_CACHE_TTL_MS) {
    return cached.rungs;
  }
  const result = await getPool().query<{
    rung: string | null;
    available: boolean;
  }>(
    `SELECT rung, (${availablePredicate(3, 4)}) AS available
     FROM hls_sessions
     WHERE channel_id = $1
       AND object_prefix LIKE $2
       AND rung IS NOT NULL
     ORDER BY started_at ASC`,
    [
      channelId,
      `${hlsObjectPrefix(channelId, startedAt)}-%`,
      hlsRetentionMinutes(),
      hlsReplayHours(),
    ],
  );
  const ladderRows = result.rows.filter(
    (row) => row.rung !== null && LADDER_RUNGS[row.rung] !== undefined,
  );
  const rungs =
    ladderRows.length > 0 && ladderRows.every((row) => row.available)
      ? ladderRows.map((row) => row.rung!)
      : [];
  pruneStale(replayRungCache, now);
  replayRungCache.set(key, { rungs, at: now });
  return rungs;
}

/** The master playlist for a replay, or null when the broadcast never ran a
 * ladder rung that is still available (a pre-ladder session, or one whose
 * objects are already swept or past their retention window). */
export async function buildReplayMasterPlaylist(input: {
  channelId: string;
  startedAt: number;
  token?: string | null;
  now?: number;
}): Promise<string | null> {
  const rungs = await replaySessionRungs(
    input.channelId,
    input.startedAt,
    input.now ?? Date.now(),
  );
  const query = input.token
    ? `?${HLS_VIEWER_TOKEN_PARAM}=${encodeURIComponent(input.token)}`
    : "";
  if (rungs.length === 0) {
    // No ladder rung: either a pre-ladder single rendition (the caller falls
    // through to the rung-less playlist) or a low-latency broadcast, which
    // has a master of its own.
    return buildLlReplayMasterPlaylist(
      input.channelId,
      input.startedAt,
      query,
      input.now ?? Date.now(),
    );
  }
  const variants: MasterVariant[] = rungs.map((rung) => ({
    rung: LADDER_RUNGS[rung]!,
    uri:
      `/api/voice/hls-replay/${encodeURIComponent(input.channelId)}` +
      `/${input.startedAt}/${encodeURIComponent(rung)}${query}`,
  }));
  return buildMasterPlaylist(variants);
}

/** How many segment/URI lines are signed before yielding the event loop.
 * A multi-hour broadcast can carry thousands of them, and `signRequest` is a
 * synchronous HMAC; without a yield the whole rewrite runs as one long
 * synchronous block on the API process, delaying every other request queued
 * behind it. 200 lines is a few milliseconds of work per slice, measured
 * against the ~2.3ms/30-line figure `hls-playlist-proxy.ts` documents for the
 * live path's much shorter windows. */
const SIGN_YIELD_EVERY = 200;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type ReplayStorageConfig = NonNullable<ReturnType<typeof liveHlsStorageConfig>>;

/** The accumulated `-index.m3u8` for one rendition, fetched from storage.
 * Shared by the replay rewrite below and by the download builder further
 * down, which needs the same object read for the same reason -- it is the
 * only record of what segments this run wrote AND in what order. */
async function fetchReplayPlaylistBody(
  config: ReplayStorageConfig,
  channelId: string,
  startedAt: number,
  rung: string | undefined,
): Promise<string> {
  const response = await fetchPlaylistObject(
    config,
    replayObjectKey(channelId, startedAt, rung),
  );
  if (!response.ok) {
    throw new HlsPlaylistUnavailable(
      `Storage returned HTTP ${response.status} for the replay playlist`,
    );
  }
  return response.text();
}

/** One playlist object, read with a short-lived signature. Storage being
 * unreachable throws; any HTTP answer is handed back for the caller to
 * judge, because a 404 means different things to different callers. */
async function fetchPlaylistObject(
  config: ReplayStorageConfig,
  key: string,
): Promise<Response> {
  const playlistUrl = signRequest({
    method: "GET",
    key,
    ttlSeconds: 60,
    forRead: false,
    config,
  }).url;
  try {
    return await fetch(playlistUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new HlsPlaylistUnavailable(
      error instanceof Error ? error.message : "Storage unreachable",
    );
  }
}

/**
 * Every object a media playlist names, rewritten into a presigned GET: the
 * segment lines, and the `URI` of every `#EXT-X-MAP` (the init segment of a
 * fragmented-MP4 playlist, which LiveKit's MPEG-TS never has and pqp-remux's
 * CMAF always does). Every other tag, `#EXT-X-DISCONTINUITY` included, passes
 * through untouched. A relative name resolves against `dir`; one with a `/`
 * in it is already a key.
 */
async function signPlaylistObjects(
  body: string,
  dir: string,
  config: ReplayStorageConfig,
  now: number,
): Promise<string> {
  const ttl = hlsUrlTtlSeconds();
  const signedAt = new Date(now);
  const sign = (name: string): string =>
    signRequest({
      method: "GET",
      key: name.includes("/") ? name : `${dir}${name}`,
      ttlSeconds: ttl,
      forRead: true,
      config,
      now: signedAt,
    }).url;
  const lines = body.split("\n");
  const rewrittenLines = new Array<string>(lines.length);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith("#EXT-X-MAP:")) {
      rewrittenLines[i] = line.replace(
        /URI="([^"]+)"/,
        (_match, uri: string) => `URI="${sign(uri)}"`,
      );
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("#")) {
      rewrittenLines[i] = line;
      continue;
    }
    rewrittenLines[i] = sign(trimmed);
    if (i > 0 && i % SIGN_YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
  }
  return rewrittenLines.join("\n");
}

/** One rendition of a replay: the accumulated `-index.m3u8`, segment lines
 * rewritten into presigned URLs. Throws `HlsPlaylistNotFound` when this
 * broadcast never ended, was swept, fell outside its retention window, or
 * never existed, and `HlsPlaylistUnavailable` when the bucket could not be
 * read. */
export async function buildReplaySignedPlaylist(
  channelId: string,
  startedAt: number,
  rung: string | undefined,
  now = Date.now(),
): Promise<string> {
  if (rung !== undefined && isLlReplayTrack(rung)) {
    return buildLlReplaySignedPlaylist(channelId, startedAt, rung, now);
  }
  const cacheKey = `${channelId}:${startedAt}:${rung ?? ""}`;
  const cached = replayBodyCache.get(cacheKey);
  if (cached && now - cached.at < REPLAY_CACHE_TTL_MS) {
    return cached.body;
  }
  const config = liveHlsStorageConfig();
  if (!config) {
    throw new HlsPlaylistUnavailable("Live HLS storage is not configured");
  }
  const objectPrefix = hlsObjectPrefix(channelId, startedAt, rung);
  const session = await getPool().query<{ runs: unknown }>(
    `SELECT runs FROM hls_sessions
     WHERE channel_id = $1
       AND object_prefix = $2
       AND ${availablePredicate(3, 4)}`,
    [channelId, objectPrefix, hlsRetentionMinutes(), hlsReplayHours()],
  );
  if (session.rowCount === 0) {
    replayBodyCache.delete(cacheKey);
    throw new HlsPlaylistNotFound(
      `No replay ${objectPrefix} for channel ${channelId}`,
    );
  }
  const runs = parseHlsRuns(session.rows[0]?.runs ?? null);
  const body =
    runs.length === 1 && runs[0]!.suffix === ""
      ? await fetchReplayPlaylistBody(config, channelId, startedAt, rung)
      : await stitchedReplayBody(config, objectPrefix, runs);
  const prefixDir = `${objectPrefix.split("/").slice(0, -1).join("/")}/`;
  const rewritten = await signPlaylistObjects(body, prefixDir, config, now);
  pruneStale(replayBodyCache, now);
  replayBodyCache.set(cacheKey, { body: rewritten, at: now });
  return rewritten;
}

/**
 * A rung whose egress restarted in place (`hls-runs.ts`): every run's
 * `-index.m3u8`, in start order, stitched into one VOD playlist. A run whose
 * playlist is gone or lists nothing is left out (a restart that failed before
 * its first segment writes neither); when none is left, the same error a
 * single run's missing playlist raises.
 */
async function stitchedReplayBody(
  config: ReplayStorageConfig,
  objectPrefix: string,
  runs: readonly HlsRun[],
): Promise<string> {
  const bodies = await mapWithConcurrency(
    runs,
    CAMERA_PLAN_CONCURRENCY,
    async (run) => {
      const response = await fetchPlaylistObject(
        config,
        `${objectPrefix}${run.suffix}-index.m3u8`,
      );
      if (response.status === 404) {
        return "";
      }
      if (!response.ok) {
        // A transient failure is not a missing run: a replay cached with a
        // hole in it would be served for REPLAY_CACHE_TTL_MS.
        throw new HlsPlaylistUnavailable(
          `Storage returned HTTP ${response.status} for the replay playlist`,
        );
      }
      return response.text();
    },
  );
  const caps = runs.map((run, index) => {
    const next = runs[index + 1];
    return next ? next.base - run.base : null;
  });
  const stitched = stitchRunPlaylists(bodies, caps);
  if (stitched === null) {
    throw new HlsPlaylistUnavailable(
      "Storage returned HTTP 404 for the replay playlist",
    );
  }
  return stitched;
}

// --------------------------------------------------------------------------
// Replaying a low-latency broadcast.
//
// A `mode = 'll'` row is one pqp-remux session, and its objects are laid out
// differently from a LiveKit rung's: `object_prefix` is a DIRECTORY
// (`live/<channel>/<startedAt>-ll/video-seg-12.m4s`), the media is CMAF with
// its own init segments, and video and audio are two renditions rather than
// two tracks of one. Since 2026-09-22 the box also writes `master.m3u8`,
// `video.m3u8` and `audio.m3u8` there (`internal/r2.VodIndex` in
// tools/pqp-remux): ordinary HLS playlists over the whole session, one
// `#EXT-X-MAP` per init and a `#EXT-X-DISCONTINUITY` ahead of every change.
// So replay is the same job as for a rung: read what the box wrote and sign
// what it names. The two media playlists are served under the rung route as
// `llvideo` and `llaudio`, names no ladder rung can ever take.
//
// THE ROW'S OWN PREFIX, NEVER ONE REBUILT FROM `startedAt`. Every LL session
// before 2026-09-22 was written under the box's clock rather than the API's,
// a few milliseconds off `started_at`, and the reconcile script
// (`server/scripts/hls-reconcile-ll-prefixes.ts`) repairs such a row by
// rewriting `object_prefix` alone. Deriving the prefix here would undo that.
// --------------------------------------------------------------------------

const LL_REPLAY_TRACKS = {
  llvideo: "video.m3u8",
  llaudio: "audio.m3u8",
} as const;

type LlReplayTrack = keyof typeof LL_REPLAY_TRACKS;

function isLlReplayTrack(rung: string): rung is LlReplayTrack {
  return Object.prototype.hasOwnProperty.call(LL_REPLAY_TRACKS, rung);
}

/** The still-available LL row of this broadcast's `object_prefix`, or null. */
async function llReplayPrefix(
  channelId: string,
  startedAt: number,
): Promise<string | null> {
  const result = await getPool().query<{ object_prefix: string }>(
    `SELECT object_prefix FROM hls_sessions
     WHERE channel_id = $1
       AND started_at = to_timestamp($2 / 1000.0)
       AND mode = 'll'
       AND ${availablePredicate(3, 4)}
     LIMIT 1`,
    [channelId, startedAt, hlsRetentionMinutes(), hlsReplayHours()],
  );
  return result.rows[0]?.object_prefix ?? null;
}

/**
 * The box's `master.m3u8` with its two playlist references pointed at this
 * API's replay route, or null when there is no LL row or the box never wrote
 * one (every LL broadcast from before the box knew how). Null rather than a
 * throw for the second case: "this recording has no playlist" is a 404, not a
 * storage outage.
 */
async function buildLlReplayMasterPlaylist(
  channelId: string,
  startedAt: number,
  query: string,
  now = Date.now(),
): Promise<string | null> {
  const raw = await llReplayMasterBody(channelId, startedAt, now);
  if (raw === null) {
    return null;
  }
  const routeFor = (name: string): string | null => {
    const track = (Object.keys(LL_REPLAY_TRACKS) as LlReplayTrack[]).find(
      (key) => LL_REPLAY_TRACKS[key] === name,
    );
    return track
      ? `/api/voice/hls-replay/${encodeURIComponent(channelId)}` +
          `/${startedAt}/${track}${query}`
      : null;
  };
  return raw
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("#EXT-X-MEDIA:")) {
        return line.replace(
          /URI="([^"]+)"/,
          (match, uri: string) => {
            const route = routeFor(uri);
            return route ? `URI="${route}"` : match;
          },
        );
      }
      if (trimmed === "" || trimmed.startsWith("#")) {
        return line;
      }
      return routeFor(trimmed) ?? line;
    })
    .join("\n");
}

/**
 * The box's own `master.m3u8` for this broadcast, or null (no available LL
 * row, or none written). Cached for the same `REPLAY_CACHE_TTL_MS` as a
 * rung's availability, token-free, because an audience opening one replay
 * all asks for the same tiny object and the per-viewer part is only the
 * query string `buildLlReplayMasterPlaylist` puts on the two URIs. A null is
 * cached too: it is as stable as a body for a finished broadcast.
 */
async function llReplayMasterBody(
  channelId: string,
  startedAt: number,
  now: number,
): Promise<string | null> {
  const cacheKey = `${channelId}:${startedAt}:llmaster`;
  const cached = llReplayMasterCache.get(cacheKey);
  if (cached && now - cached.at < REPLAY_CACHE_TTL_MS) {
    return cached.body;
  }
  // An audience pressing Watch together all miss the cache together; one
  // read answers them all.
  const inFlight = llReplayMasterInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }
  const read = readLlReplayMasterBody(channelId, startedAt, cacheKey, now);
  llReplayMasterInFlight.set(cacheKey, read);
  try {
    return await read;
  } finally {
    llReplayMasterInFlight.delete(cacheKey);
  }
}

async function readLlReplayMasterBody(
  channelId: string,
  startedAt: number,
  cacheKey: string,
  now: number,
): Promise<string | null> {
  const prefix = await llReplayPrefix(channelId, startedAt);
  let body: string | null = null;
  if (prefix !== null) {
    const config = liveHlsStorageConfig();
    if (!config) {
      throw new HlsPlaylistUnavailable("Live HLS storage is not configured");
    }
    const response = await fetchPlaylistObject(config, `${prefix}/master.m3u8`);
    if (response.ok) {
      body = await response.text();
    } else if (response.status !== 404) {
      // Not cached: an outage is not a fact about the recording.
      throw new HlsPlaylistUnavailable(
        `Storage returned HTTP ${response.status} for the LL replay master`,
      );
    }
  }
  pruneStale(llReplayMasterCache, now);
  llReplayMasterCache.set(cacheKey, { body, at: now });
  return body;
}

/**
 * One of an LL broadcast's two media playlists, every segment and init
 * signed. Always served as a finished VOD: the row is ended (the availability
 * predicate requires it), and a box that died before its final write left the
 * playlist as an open `EVENT` with no `#EXT-X-ENDLIST`, which a player would
 * keep polling for segments that are never coming.
 */
async function buildLlReplaySignedPlaylist(
  channelId: string,
  startedAt: number,
  track: LlReplayTrack,
  now: number,
): Promise<string> {
  const cacheKey = `${channelId}:${startedAt}:${track}`;
  const cached = replayBodyCache.get(cacheKey);
  if (cached && now - cached.at < REPLAY_CACHE_TTL_MS) {
    return cached.body;
  }
  const config = liveHlsStorageConfig();
  if (!config) {
    throw new HlsPlaylistUnavailable("Live HLS storage is not configured");
  }
  const prefix = await llReplayPrefix(channelId, startedAt);
  if (prefix === null) {
    replayBodyCache.delete(cacheKey);
    throw new HlsPlaylistNotFound(
      `No LL replay for channel ${channelId} at ${startedAt}`,
    );
  }
  const response = await fetchPlaylistObject(
    config,
    `${prefix}/${LL_REPLAY_TRACKS[track]}`,
  );
  if (response.status === 404) {
    throw new HlsPlaylistNotFound(`No ${track} playlist under ${prefix}`);
  }
  if (!response.ok) {
    throw new HlsPlaylistUnavailable(
      `Storage returned HTTP ${response.status} for the LL replay ${track}`,
    );
  }
  const signed = await signPlaylistObjects(
    closeLlPlaylist(await response.text()),
    `${prefix}/`,
    config,
    now,
  );
  pruneStale(replayBodyCache, now);
  replayBodyCache.set(cacheKey, { body: signed, at: now });
  return signed;
}

/** `EVENT` becomes `VOD`, and a missing `#EXT-X-ENDLIST` is appended. */
function closeLlPlaylist(body: string): string {
  const closed = body.replace(
    /^#EXT-X-PLAYLIST-TYPE:EVENT$/m,
    "#EXT-X-PLAYLIST-TYPE:VOD",
  );
  if (/^#EXT-X-ENDLIST\s*$/m.test(closed)) {
    return closed;
  }
  return `${closed.replace(/\n*$/, "\n")}#EXT-X-ENDLIST\n`;
}

// --------------------------------------------------------------------------
// Downloading a past broadcast.
//
// WHAT A DOWNLOAD IS HERE: the objects the egress already wrote, handed back
// verbatim and in order. Nothing is transcoded, remuxed or muxed together on
// the API. (An LL broadcast's film is one object too, but the box made it
// after the show; see "An LL broadcast's film" below.) Three separate files rather than one muxed deliverable, for the
// same reason `LIVE_HLS_MIC_ARCHIVE` writes a second object at all
// (`docs/WATCH_PARTY.md`, "The host's voice as its own file"): the picture,
// the host's camera and the host's voice are useful as separate tracks in an
// editor, and welding them together would mean an ffmpeg process per
// download on a box that is running a chat API.
//
// WHY CONCATENATED MPEG-TS IS A REAL FILE. A rung's segments are MPEG-TS,
// and MPEG-TS is a stream format: 188-byte packets carrying their own PAT/PMT
// and timestamps, with no header at the front and no index at the back. Byte
// concatenation in playlist order is therefore exactly what a player would
// have seen had it played the playlist, which is why `cat *.ts > out.ts`
// works and why the same trick does NOT work for fragmented MP4. A viewer
// plays the result directly (VLC, mpv, ffmpeg); for something an editor or a
// browser likes better, `ffmpeg -i out.ts -c copy out.mp4` remuxes it without
// re-encoding. The dialog says as much, and so does `docs/WATCH_PARTY.md`.
//
// ORDER COMES FROM THE PLAYLIST, NOT FROM THE LISTING. `ListObjectsV2`
// answers in lexicographic key order, which matches segment order only while
// the numbering stays the same width -- one roll from `_00999` to `_01000` is
// fine, but nothing in the egress promises that, and a broadcast reassembled
// in the wrong order is a corrupt file that still plays for its first few
// seconds. The accumulated `-index.m3u8` is the run's own record of what it
// wrote and when, so that is what is read.
// --------------------------------------------------------------------------

/** The three files a broadcast can yield. `film` is the top available ladder
 * rung (the picture the audience watched), `camera` the presenter's pip, and
 * `voice` the host's microphone archive. */
export type WatchPartyDownloadKind = "film" | "camera" | "voice";

export const WATCH_PARTY_DOWNLOAD_KINDS: readonly WatchPartyDownloadKind[] = [
  "film",
  "camera",
  "voice",
];

export function isWatchPartyDownloadKind(
  value: string,
): value is WatchPartyDownloadKind {
  return (WATCH_PARTY_DOWNLOAD_KINDS as readonly string[]).includes(value);
}

/** What one kind weighs, or null when this broadcast has no such file.
 * `preparing` names the kinds that do not exist YET but are being made: an
 * LL broadcast's film, which the box encodes after the show
 * (tools/pqp-remux/internal/film). A kind is never both sized and preparing. */
export interface WatchPartyDownloadSizes {
  film: number | null;
  camera: number | null;
  voice: number | null;
  preparing: WatchPartyDownloadKind[];
}

/** Everything the byte route needs: which objects, in what order, and how
 * big the concatenation is. */
export interface WatchPartyDownloadPlan {
  kind: WatchPartyDownloadKind;
  contentType: string;
  /** Appended to the caller's filename stem. */
  extension: "ts" | "ogg" | "mp4";
  keys: string[];
  /** Per key, 90 kHz ticks to move that object's MPEG-TS timestamps by
   * (`ts-timestamp-shift.ts`). Absent, or 0, means byte for byte. Set for a
   * camera or a film rung with more than one run, so the runs play one after
   * another. */
  ptsOffsets?: number[];
  /** Exact: every object the download concatenates was priced by the same
   * listing that proved it is there, so this is a `Content-Length` the
   * browser can hold us to. */
  bytes: number;
}

const DOWNLOAD_CONTENT_TYPE: Record<WatchPartyDownloadKind, string> = {
  film: "video/mp2t",
  camera: "video/mp2t",
  voice: "audio/ogg",
};

// --------------------------------------------------------------------------
// An LL broadcast's film.
//
// There is no ladder rung to concatenate: the picture is pqp-remux's CMAF,
// many init segments deep, which no byte concatenation turns into a file.
// So the box makes one after the show, `<prefix>/film.mp4` beside the
// segments (tools/pqp-remux/internal/film), and writes `<prefix>/film.json`
// while it works. The film lives under the LL row's own prefix, so the
// retention sweep deletes it with the session and `keep_replay` keeps it,
// with no row of its own.
//
// "BEING PREPARED" IS A CLAIM WITH A CLOCK ON IT. film.json says queued or
// processing and carries `updatedAt`, which the box rewrites every 30 s while
// the job lives. A status that has stopped moving is a job whose process
// died (a deploy, a crash), and saying "being prepared" about it forever
// would be a lie, so past LL_FILM_STALE_MS it is read as no film. Between the
// show ending and the box's first write there is no status at all, which
// LL_FILM_GRACE_MS covers from the row's `ended_at`.
// --------------------------------------------------------------------------

export const LL_FILM_OBJECT = "film.mp4";
export const LL_FILM_STATUS_OBJECT = "film.json";
const LL_FILM_STALE_MS = 150_000;
const LL_FILM_GRACE_MS = 180_000;

type FilmSource =
  | { type: "rung"; rung: string }
  | { type: "ll"; prefix: string; endedAt: Date | null };

type LlFilmState = { bytes: number } | { preparing: true } | null;

async function llFilmState(
  source: Extract<FilmSource, { type: "ll" }>,
  config: ReplayStorageConfig,
  now = Date.now(),
): Promise<LlFilmState> {
  const filmKey = `${source.prefix}/${LL_FILM_OBJECT}`;
  const statusKey = `${source.prefix}/${LL_FILM_STATUS_OBJECT}`;
  let sizes = await objectSizes(`${source.prefix}/film`, config, now);
  if (!sizes.has(filmKey)) {
    // The memo is there for sizes that cannot change; a film that is being
    // made is the one thing under this prefix that can. Ask again.
    sizes = await objectSizes(`${source.prefix}/film`, config, now, {
      fresh: true,
    });
  }
  const bytes = sizes.get(filmKey);
  if (bytes !== undefined && bytes > 0) {
    return { bytes };
  }
  if (!sizes.has(statusKey)) {
    const endedAt = source.endedAt?.getTime() ?? null;
    return endedAt !== null && now - endedAt < LL_FILM_GRACE_MS
      ? { preparing: true }
      : null;
  }
  const response = await fetchPlaylistObject(config, statusKey);
  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new HlsPlaylistUnavailable(
      `Storage returned HTTP ${response.status} for ${statusKey}`,
    );
  }
  let status: { state?: unknown; updatedAt?: unknown };
  try {
    status = (await response.json()) as typeof status;
  } catch {
    return null;
  }
  const updatedAt =
    typeof status.updatedAt === "string" ? Date.parse(status.updatedAt) : NaN;
  const live = status.state === "queued" || status.state === "processing";
  return live && Number.isFinite(updatedAt) && now - updatedAt < LL_FILM_STALE_MS
    ? { preparing: true }
    : null;
}

/**
 * Per-object signature lifetime while streaming. Generous on purpose: a
 * download is consumed at the CLIENT's pace, and the signed GET is only
 * issued when its turn comes, so the relevant clock is "how long one object
 * takes on a slow link", not "how long the whole file takes".
 */
const DOWNLOAD_OBJECT_TTL_SECONDS = 900;

/**
 * How long a download may make NO progress before it is abandoned, and
 * progress means bytes the client actually took.
 *
 * Idle, not elapsed: a body is drained at the client's pace, so an hour of
 * film down a slow link is a completely healthy transfer and a deadline on
 * the object would kill exactly the downloads that need the most patience.
 * But "the destination is backpressured" is NOT a reason to keep waiting
 * either -- a reader that stops reading altogether would then hold a storage
 * connection and a server pipeline open forever. So the clock is restarted by
 * a chunk arriving from storage AND by the socket draining what it was handed,
 * and by nothing else: a slow client keeps draining, a dead one does not.
 */
const DOWNLOAD_OBJECT_IDLE_MS = 120_000;

/** How often the clock above is examined. */
const DOWNLOAD_PROGRESS_TICK_MS = 5_000;

/**
 * The absolute ceiling on one download, whatever it is doing. Six hours is
 * far past any real broadcast down any real link, and exists so a pathological
 * client that dribbles one byte every two minutes forever still ends.
 */
const DOWNLOAD_MAX_MS = 6 * 60 * 60 * 1000;

/** A `ListObjectsV2` per rung prefix, memoised because two different
 * requests want the same answer: the panel opening (to price the files) and,
 * moments later, the download itself (to set `Content-Length` and to know
 * every segment is really there). A finished broadcast's objects never
 * change, so one listing serves both. This is also why sizes are NOT folded
 * into `listWatchPartyHistory`: twenty broadcasts would be sixty bucket
 * round-trips for a dialog that usually downloads none of them.
 *
 * THIRTY SECONDS, NOT THE FIVE MINUTES A FINISHED BROADCAST'S OBJECTS ARE
 * ACTUALLY STABLE FOR. The window that matters is the gap between opening the
 * panel and clicking a link, which is seconds; holding the listing longer only
 * widens the one case where it is wrong -- the retention sweep deleting
 * objects underneath a plan that has already been priced and checked, which
 * ends in a truncated attachment because the head is out by then.
 *
 * FAILURES ARE NEVER CACHED, and never returned as an empty listing: "the
 * bucket did not answer" and "that file was never written" are different
 * facts, and conflating them tells a moderator the camera was off when
 * storage was merely down. A failure throws. */
const DOWNLOAD_LISTING_TTL_MS = 30_000;

/** How many rung prefixes the memo may hold. One entry is every key and size
 * of one rendition of one broadcast, which for a three-hour film is thousands
 * of strings -- so this is a real memory bound, not a tidiness rule. Oldest
 * insertion first, which is also least-recently-listed: each entry is written
 * once and read for its 30 seconds. */
const DOWNLOAD_LISTING_MAX_ENTRIES = 32;
const objectListingCache = new Map<
  string,
  { sizes: Map<string, number>; at: number }
>();

export function resetWatchPartyDownloadCacheForTests(): void {
  objectListingCache.clear();
}

interface BroadcastRungRow {
  rung: string | null;
  mode: string | null;
  object_prefix: string;
  ended_at: Date | null;
  available: boolean;
}

/** Every row of this broadcast with its own availability, by the same
 * predicate the replay paths use. */
async function broadcastRungRows(
  channelId: string,
  startedAtMs: number,
): Promise<BroadcastRungRow[]> {
  const result = await getPool().query<BroadcastRungRow>(
    `SELECT rung, mode, object_prefix, ended_at,
            (${availablePredicate(3, 4)}) AS available
     FROM hls_sessions
     WHERE channel_id = $1 AND started_at = to_timestamp($2 / 1000.0)`,
    [channelId, startedAtMs, hlsRetentionMinutes(), hlsReplayHours()],
  );
  return result.rows;
}

/**
 * The rung whose file is "the stream": the tallest available ladder rendition,
 * bitrate breaking a tie. The audience saw whichever rung their link could
 * carry, but the archive should be the best copy that exists -- picking the
 * lowest would hand a moderator a 480p file of a 1080p night.
 */
function topLadderRung(rows: BroadcastRungRow[]): string | null {
  let best: { rung: string; height: number; kbps: number } | null = null;
  for (const row of rows) {
    if (!row.available || row.rung === null) {
      continue;
    }
    const ladder = LADDER_RUNGS[row.rung];
    if (!ladder) {
      continue;
    }
    if (
      !best ||
      ladder.height > best.height ||
      (ladder.height === best.height && ladder.videoKbps > best.kbps)
    ) {
      best = { rung: row.rung, height: ladder.height, kbps: ladder.videoKbps };
    }
  }
  return best?.rung ?? null;
}

function hasAvailableRung(rows: BroadcastRungRow[], rung: string): boolean {
  return rows.some((row) => row.rung === rung && row.available);
}

/** Which rung (if any) backs each kind for this broadcast. */
function downloadRungs(rows: BroadcastRungRow[]): Record<
  WatchPartyDownloadKind,
  string | null
> {
  return {
    film: topLadderRung(rows),
    camera: hasAvailableRung(rows, CAMERA_RUNG_NAME) ? CAMERA_RUNG_NAME : null,
    voice: hasAvailableRung(rows, MIC_ARCHIVE_RUNG) ? MIC_ARCHIVE_RUNG : null,
  };
}

/** Where the film comes from: the top ladder rung, or, for a broadcast that
 * has none, its available LL row (the ROW's prefix, never one rebuilt from
 * `started_at`: see the LL replay section on the reconcile script). */
function filmSource(rows: BroadcastRungRow[]): FilmSource | null {
  const rung = topLadderRung(rows);
  if (rung) {
    return { type: "rung", rung };
  }
  const ll = rows.find((row) => row.mode === "ll" && row.available);
  return ll
    ? { type: "ll", prefix: ll.object_prefix, endedAt: ll.ended_at }
    : null;
}

async function objectSizes(
  prefix: string,
  config: NonNullable<ReturnType<typeof liveHlsStorageConfig>>,
  now = Date.now(),
  options: { fresh?: boolean } = {},
): Promise<Map<string, number>> {
  const cached = options.fresh ? undefined : objectListingCache.get(prefix);
  if (cached && now - cached.at < DOWNLOAD_LISTING_TTL_MS) {
    return cached.sizes;
  }
  const sizes = new Map<string, number>();
  let listing: Awaited<ReturnType<typeof listObjects>>;
  try {
    listing = await listObjects(prefix, config);
  } catch (error) {
    throw new HlsPlaylistUnavailable(
      error instanceof Error ? error.message : "Storage unreachable",
    );
  }
  for (const object of listing) {
    sizes.set(object.key, object.size);
  }
  pruneStale(objectListingCache, now);
  objectListingCache.set(prefix, { sizes, at: now });
  while (objectListingCache.size > DOWNLOAD_LISTING_MAX_ENTRIES) {
    const oldest = objectListingCache.keys().next();
    if (oldest.done) {
      break;
    }
    objectListingCache.delete(oldest.value);
  }
  return sizes;
}

/** Where one kind's objects live: the mic archive is a single object, every
 * other kind is a rung's prefix. */
function downloadPrefix(
  channelId: string,
  startedAtMs: number,
  kind: WatchPartyDownloadKind,
  rung: string,
): string {
  return kind === "voice"
    ? micArchiveObjectKey(channelId, startedAtMs)
    : hlsObjectPrefix(channelId, startedAtMs, rung);
}

/**
 * How big each of the three files is, or null for one this broadcast never
 * wrote. Sizes are approximate by contract -- what the bucket reports for the
 * objects the download concatenates -- and belong on a button, not in a
 * promise.
 *
 * Throws `HlsPlaylistUnavailable` when storage is unset or will not answer,
 * rather than reporting every kind as absent: a caller that cannot tell the
 * two apart shows "câmera não usada" during an outage.
 */
export async function watchPartyDownloadSizes(
  channelId: string,
  startedAtMs: number,
): Promise<WatchPartyDownloadSizes> {
  const config = liveHlsStorageConfig();
  if (!config) {
    throw new HlsPlaylistUnavailable("Live HLS storage is not configured");
  }
  const sizes: WatchPartyDownloadSizes = {
    film: null,
    camera: null,
    voice: null,
    preparing: [],
  };
  const rows = await broadcastRungRows(channelId, startedAtMs);
  const rungs = downloadRungs(rows);
  const film = filmSource(rows);
  if (film?.type === "ll") {
    const state = await llFilmState(film, config);
    if (state && "bytes" in state) {
      sizes.film = state.bytes;
    } else if (state) {
      sizes.preparing.push("film");
    }
  }
  for (const kind of WATCH_PARTY_DOWNLOAD_KINDS) {
    const rung = rungs[kind];
    if (!rung) {
      continue;
    }
    let total = 0;
    for (const [key, size] of await objectSizes(
      downloadPrefix(channelId, startedAtMs, kind, rung),
      config,
    )) {
      // Playlists are a rounding error next to the segments, but counting
      // them would make the number disagree with what is actually sent.
      if (kind === "voice" || key.endsWith(".ts")) {
        total += size;
      }
    }
    sizes[kind] = total > 0 ? total : null;
  }
  return sizes;
}

/** Segment keys in playlist order. Relative lines are resolved against the
 * rung's own directory, exactly as `buildReplaySignedPlaylist` does. */
function playlistKeys(body: string, objectPrefix: string): string[] {
  const prefixDir = `${objectPrefix.split("/").slice(0, -1).join("/")}/`;
  const keys: string[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    keys.push(trimmed.includes("/") ? trimmed : `${prefixDir}${trimmed}`);
  }
  return keys;
}

/**
 * What to stream for one kind, or null when this broadcast has no such file.
 * Throws `HlsPlaylistUnavailable` when storage is not configured or cannot be
 * read, and `HlsPlaylistNotFound` when the playlist names an object the
 * bucket does not have -- a half-swept recording, which the route answers
 * with the same 409 as a fully swept one. Discovering that mid-stream is not
 * an option: the head is out by then and the moderator is left with a file
 * that looks complete and is not.
 */
export async function buildWatchPartyDownloadPlan(
  channelId: string,
  startedAtMs: number,
  kind: WatchPartyDownloadKind,
): Promise<WatchPartyDownloadPlan | null> {
  const config = liveHlsStorageConfig();
  if (!config) {
    throw new HlsPlaylistUnavailable("Live HLS storage is not configured");
  }
  const rows = await broadcastRungRows(channelId, startedAtMs);
  if (kind === "film") {
    const film = filmSource(rows);
    if (film?.type === "ll") {
      // One object the box already made: nothing to concatenate, and only
      // offered once it is really there (a film still being made is a 404
      // here, which the dialog never links to anyway).
      const state = await llFilmState(film, config);
      if (!state || !("bytes" in state)) {
        return null;
      }
      return {
        kind,
        contentType: "video/mp4",
        extension: "mp4",
        keys: [`${film.prefix}/${LL_FILM_OBJECT}`],
        bytes: state.bytes,
      };
    }
  }
  const rung = downloadRungs(rows)[kind];
  if (!rung) {
    return null;
  }
  const prefix = downloadPrefix(channelId, startedAtMs, kind, rung);
  // The same listing the panel already paid for, memoised: opening the panel
  // and then downloading from it must not scan the prefix twice.
  const sizes = await objectSizes(prefix, config);
  if (kind === "camera") {
    return buildRunsDownloadPlan(kind, prefix, sizes, config);
  }
  if (kind === "voice") {
    const size = sizes.get(prefix);
    if (size === undefined) {
      return null;
    }
    return {
      kind,
      contentType: DOWNLOAD_CONTENT_TYPE[kind],
      extension: "ogg",
      keys: [prefix],
      bytes: size,
    };
  }
  // A rung whose egress restarted in place wrote one run per egress, the
  // camera's name shape exactly, so it is planned the camera's way. Read from
  // the listing rather than the row's `runs`: the objects are what the file
  // is made of. One run (the legacy index alone) stays byte for byte.
  if (
    cameraRunPlaylistKeys(prefix, sizes.keys()).some(
      (key) => key !== `${prefix}-index.m3u8`,
    )
  ) {
    return buildRunsDownloadPlan(kind, prefix, sizes, config);
  }
  const keys = playlistKeys(
    await fetchReplayPlaylistBody(config, channelId, startedAtMs, rung),
    prefix,
  );
  if (keys.length === 0) {
    return null;
  }
  let total = 0;
  for (const key of keys) {
    const size = sizes.get(key);
    if (size === undefined) {
      throw new HlsPlaylistNotFound(
        `Replay ${prefix} is missing ${key}, which its playlist names`,
      );
    }
    total += size;
  }
  return {
    kind,
    contentType: DOWNLOAD_CONTENT_TYPE[kind],
    extension: "ts",
    keys,
    bytes: total,
  };
}

// --------------------------------------------------------------------------
// The presenter's camera, every run of it (and a ladder rung's, the same way).
//
// The camera stops and starts inside a broadcast (turned off and on, a device
// switch, a dead egress coming back), and every run is its own egress writing
// under its own names (`cameraRunNames` in hls-egress.ts). A film rung that
// restarted in place (`hls-runs.ts`) writes the same shape: the first run as
// `<prefix>_NNNNN.ts` with `<prefix>-index.m3u8`, every later one as
// `<prefix>-r<its start, ms>_NNNNN.ts` with `<prefix>-r<ms>-index.m3u8`. All
// of them sit under the one row's prefix, so the listing that prices the
// download finds them all.
//
// ONE FILE, IN ORDER, ON ONE CLOCK. Each egress starts its MPEG-TS clock in
// the same place, so the runs are placed by the wall clock their own playlists
// carry (`#EXT-X-PROGRAM-DATE-TIME`, which LiveKit writes): run k is moved so
// its first frame lands `(its PDT - the first run's PDT)` after the first
// run's first frame. The camera being off is then a gap the player holds the
// last picture across, which is what happened. Without a PDT, a run follows
// the previous one's summed EXTINF instead. Never earlier than the previous
// run ended, whatever the clocks say.
// --------------------------------------------------------------------------

const CAMERA_RUN_INDEX = /-r(\d{1,16})-index\.m3u8$/;
/** How much of a segment's head is read to find its first PTS. */
const CAMERA_PTS_PROBE_BYTES = 64 * 1024;
/** Storage requests in flight at once while planning a download over runs
 * (or stitching a replay over them). */
const CAMERA_PLAN_CONCURRENCY = 4;

/** `items.map(fn)`, at most `limit` at a time, results in input order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/** The run playlists under `prefix` (a camera or a restarted rung), first run
 * first. Only `<prefix>-index.m3u8` and `<prefix>-r<digits>-index.m3u8`
 * count, so another run's live playlist or a segment never does. */
export function cameraRunPlaylistKeys(
  prefix: string,
  keys: Iterable<string>,
): string[] {
  const first = `${prefix}-index.m3u8`;
  const later: { key: string; at: number }[] = [];
  let hasFirst = false;
  for (const key of keys) {
    if (key === first) {
      hasFirst = true;
      continue;
    }
    if (!key.startsWith(`${prefix}-r`)) {
      continue;
    }
    const run = CAMERA_RUN_INDEX.exec(key);
    if (run && key === `${prefix}-r${run[1]}-index.m3u8`) {
      later.push({ key, at: Number(run[1]) });
    }
  }
  later.sort((a, b) => a.at - b.at);
  return [...(hasFirst ? [first] : []), ...later.map((entry) => entry.key)];
}

function playlistProgramDateTime(body: string): number | null {
  const match = /^#EXT-X-PROGRAM-DATE-TIME:(.+)$/m.exec(body);
  if (!match) {
    return null;
  }
  const at = Date.parse(match[1]!.trim());
  return Number.isFinite(at) ? at : null;
}

function playlistSeconds(body: string): number {
  let total = 0;
  for (const match of body.matchAll(/^#EXTINF:([0-9.]+)/gm)) {
    total += Number(match[1]);
  }
  return total;
}

async function segmentFirstPts(
  config: ReplayStorageConfig,
  key: string,
): Promise<number | null> {
  const url = signRequest({
    method: "GET",
    key,
    ttlSeconds: 60,
    forRead: true,
    config,
  }).url;
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      headers: { range: `bytes=0-${CAMERA_PTS_PROBE_BYTES - 1}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new HlsPlaylistUnavailable(
      error instanceof Error ? error.message : "Storage unreachable",
    );
  }
  if (!response.ok) {
    throw new HlsPlaylistUnavailable(
      `Storage returned HTTP ${response.status} for ${key}`,
    );
  }
  return firstPts(new Uint8Array(await response.arrayBuffer()));
}

async function buildRunsDownloadPlan(
  kind: "camera" | "film",
  prefix: string,
  sizes: Map<string, number>,
  config: ReplayStorageConfig,
): Promise<WatchPartyDownloadPlan | null> {
  // Every run's playlist, and (for more than one run) every run's first PTS,
  // fetched CAMERA_PLAN_CONCURRENCY at a time: a camera toggled a dozen times
  // must not be two dozen storage round trips in a row before the head goes
  // out. Each request is bounded by REQUEST_TIMEOUT_MS on its own.
  const fetched = await mapWithConcurrency(
    cameraRunPlaylistKeys(prefix, sizes.keys()),
    CAMERA_PLAN_CONCURRENCY,
    async (playlistKey) => {
      const response = await fetchPlaylistObject(config, playlistKey);
      if (!response.ok) {
        throw new HlsPlaylistUnavailable(
          `Storage returned HTTP ${response.status} for ${playlistKey}`,
        );
      }
      const body = await response.text();
      return {
        keys: playlistKeys(body, prefix),
        pdt: playlistProgramDateTime(body),
        seconds: playlistSeconds(body),
      };
    },
  );
  const runs = fetched.filter((run) => run.keys.length > 0);
  if (runs.length === 0) {
    return null;
  }
  const firstPtsOfRun =
    runs.length > 1
      ? await mapWithConcurrency(runs, CAMERA_PLAN_CONCURRENCY, (run) =>
          segmentFirstPts(config, run.keys[0]!),
        )
      : runs.map(() => null);
  const keys: string[] = [];
  const ptsOffsets: number[] = [];
  let total = 0;
  // The first run's first PTS and wall clock, and where the previous run
  // ended on the film's clock: the reference every later run is placed by.
  let origin: { pts: number; pdt: number | null } | null = null;
  let previousEnd = 0;
  for (const [index, run] of runs.entries()) {
    let offset = 0;
    if (runs.length > 1) {
      const pts = firstPtsOfRun[index] ?? null;
      if (pts !== null) {
        if (!origin) {
          origin = { pts, pdt: run.pdt };
          previousEnd = pts;
        }
        let target =
          index === 0
            ? pts
            : origin.pdt !== null && run.pdt !== null
              ? origin.pts + (run.pdt - origin.pdt) * 90
              : previousEnd;
        target = Math.max(target, previousEnd);
        offset = Math.round(target - pts);
        previousEnd = target + run.seconds * 90_000;
      }
    }
    for (const key of run.keys) {
      const size = sizes.get(key);
      if (size === undefined) {
        throw new HlsPlaylistNotFound(
          `Replay ${prefix} is missing ${key}, which its playlist names`,
        );
      }
      total += size;
      keys.push(key);
      ptsOffsets.push(offset);
    }
  }
  return {
    kind,
    contentType: DOWNLOAD_CONTENT_TYPE[kind],
    extension: "ts",
    keys,
    ...(ptsOffsets.some((offset) => offset !== 0) ? { ptsOffsets } : {}),
    bytes: total,
  };
}

/**
 * Pipes the plan's objects into `target`, one after another, with
 * backpressure: `pipeline` only pulls the next chunk out of storage when the
 * socket has taken the last one, so a three-hour broadcast never exists in
 * this process's memory. `{ end: false }` keeps the response open between
 * objects; the caller ends it.
 *
 * ONE `AbortSignal` DRIVES BOTH HALVES. It is handed to the storage `fetch`
 * and to `pipeline`, because either half can be the one that stops: storage
 * going quiet, or a client that stops reading with the body already buffered
 * (aborting only the fetch there does nothing at all -- the fetch has
 * finished). Firing it tears the whole chain down, which is the only way to
 * be sure a stalled download stops costing a connection and a socket buffer.
 *
 * Once the first byte is out there is no way to turn the answer into an HTTP
 * error, so a failure mid-stream can only destroy the response and let the
 * client see a truncated download -- which is why the plan is built (and
 * every "is this still there" question answered) BEFORE the head is written.
 *
 * `idleMs` / `maxMs` are the tests' way in; nothing in production passes them.
 */
export async function streamWatchPartyDownload(
  plan: WatchPartyDownloadPlan,
  target: Writable,
  options: { idleMs?: number; maxMs?: number } = {},
): Promise<void> {
  const config = liveHlsStorageConfig();
  if (!config) {
    throw new HlsPlaylistUnavailable("Live HLS storage is not configured");
  }
  const idleMs = options.idleMs ?? DOWNLOAD_OBJECT_IDLE_MS;
  const maxMs = options.maxMs ?? DOWNLOAD_MAX_MS;
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  const noteProgress = (): void => {
    lastProgressAt = Date.now();
  };
  // The socket taking what it was handed is the only proof the client is
  // still there; a chunk arriving from storage is the proof for the other
  // half. Nothing else counts as progress.
  target.on("drain", noteProgress);
  try {
    for (const [index, key] of plan.keys.entries()) {
      const shift = plan.ptsOffsets?.[index] ?? 0;
      // Checked between objects as well as on the tick below: a download of
      // many small segments can finish each one inside a single tick and
      // never be examined at all.
      if (Date.now() - startedAt >= maxMs) {
        throw new HlsPlaylistUnavailable(
          `Download of ${plan.kind} outlived its ceiling`,
        );
      }
      const url = signRequest({
        method: "GET",
        key,
        ttlSeconds: DOWNLOAD_OBJECT_TTL_SECONDS,
        forRead: true,
        config,
      }).url;
      const controller = new AbortController();
      const watchdog = setInterval(
        () => {
          const now = Date.now();
          if (now - lastProgressAt >= idleMs || now - startedAt >= maxMs) {
            controller.abort();
          }
        },
        Math.max(250, Math.min(DOWNLOAD_PROGRESS_TICK_MS, idleMs, maxMs)),
      );
      try {
        let response: Response;
        try {
          response = await fetch(url, {
            cache: "no-store",
            signal: controller.signal,
          });
        } catch (error) {
          throw new HlsPlaylistUnavailable(
            error instanceof Error ? error.message : "Storage unreachable",
          );
        }
        if (!response.ok || !response.body) {
          throw new HlsPlaylistUnavailable(
            `Storage returned HTTP ${response.status} for ${key}`,
          );
        }
        noteProgress();
        await pipeline(
          // `fetch`'s body is typed as the DOM `ReadableStream`,
          // `Readable.fromWeb` takes the `node:stream/web` one; they are the
          // same object at runtime and differ only in how the two lib
          // definitions spell it.
          Readable.fromWeb(
            response.body as unknown as NodeReadableStream<Uint8Array>,
          ),
          new Transform({
            transform(chunk, _encoding, done) {
              noteProgress();
              done(null, chunk);
            },
          }),
          shift === 0 ? new PassThrough() : new TsTimestampShift(shift),
          target,
          { end: false, signal: controller.signal },
        );
      } finally {
        clearInterval(watchdog);
      }
    }
  } finally {
    target.off("drain", noteProgress);
  }
}
