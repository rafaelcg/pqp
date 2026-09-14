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
import { Readable } from "node:stream";
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
       COALESCE(presenter.title, c.name) AS title
     FROM sessions s
     JOIN channels c ON c.id = s.channel_id
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
  if (rungs.length === 0) {
    return null;
  }
  const query = input.token
    ? `?${HLS_VIEWER_TOKEN_PARAM}=${encodeURIComponent(input.token)}`
    : "";
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

/** The accumulated `-index.m3u8` for one rendition, fetched from storage.
 * Shared by the replay rewrite below and by the download builder further
 * down, which needs the same object read for the same reason -- it is the
 * only record of what segments this run wrote AND in what order. */
async function fetchReplayPlaylistBody(
  config: NonNullable<ReturnType<typeof liveHlsStorageConfig>>,
  channelId: string,
  startedAt: number,
  rung: string | undefined,
): Promise<string> {
  const playlistUrl = signRequest({
    method: "GET",
    key: replayObjectKey(channelId, startedAt, rung),
    ttlSeconds: 60,
    forRead: false,
    config,
  }).url;
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
      `Storage returned HTTP ${response.status} for the replay playlist`,
    );
  }
  return response.text();
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
  const session = await getPool().query(
    `SELECT 1 FROM hls_sessions
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
  const body = await fetchReplayPlaylistBody(config, channelId, startedAt, rung);
  const ttl = hlsUrlTtlSeconds();
  const signedAt = new Date(now);
  const prefixDir = `${objectPrefix.split("/").slice(0, -1).join("/")}/`;
  const lines = body.split("\n");
  const rewrittenLines = new Array<string>(lines.length);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      rewrittenLines[i] = line;
      continue;
    }
    const key = trimmed.includes("/") ? trimmed : `${prefixDir}${trimmed}`;
    rewrittenLines[i] = signRequest({
      method: "GET",
      key,
      ttlSeconds: ttl,
      forRead: true,
      config,
      now: signedAt,
    }).url;
    if (i > 0 && i % SIGN_YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
  }
  const rewritten = rewrittenLines.join("\n");
  pruneStale(replayBodyCache, now);
  replayBodyCache.set(cacheKey, { body: rewritten, at: now });
  return rewritten;
}

// --------------------------------------------------------------------------
// Downloading a past broadcast.
//
// WHAT A DOWNLOAD IS HERE: the objects the egress already wrote, handed back
// verbatim and in order. Nothing is transcoded, remuxed or muxed together on
// the API. Three separate files rather than one muxed deliverable, for the
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

/** What one kind weighs, or null when this broadcast has no such file. */
export interface WatchPartyDownloadSizes {
  film: number | null;
  camera: number | null;
  voice: number | null;
}

/** Everything the byte route needs: which objects, in what order, and how
 * big the concatenation is (null when the listing and the playlist disagree
 * -- see `planFromRung`). */
export interface WatchPartyDownloadPlan {
  kind: WatchPartyDownloadKind;
  contentType: string;
  /** Appended to the caller's filename stem. */
  extension: "ts" | "ogg";
  keys: string[];
  bytes: number | null;
}

const DOWNLOAD_CONTENT_TYPE: Record<WatchPartyDownloadKind, string> = {
  film: "video/mp2t",
  camera: "video/mp2t",
  voice: "audio/ogg",
};

/**
 * Per-object signature lifetime while streaming. Generous on purpose: a
 * download is consumed at the CLIENT's pace, and the signed GET is only
 * issued when its turn comes, so the relevant clock is "how long one object
 * takes on a slow link", not "how long the whole file takes".
 */
const DOWNLOAD_OBJECT_TTL_SECONDS = 900;

/**
 * Per-object read timeout, which is NOT `REQUEST_TIMEOUT_MS`. `fetch`'s
 * signal aborts the body as well as the headers, and this body is drained
 * against a browser's backpressure: a 3 MB segment on a 2 Mbit link is over
 * ten seconds of perfectly healthy transfer. Ten minutes is long enough that
 * only a genuinely stuck object trips it.
 */
const DOWNLOAD_OBJECT_TIMEOUT_MS = 600_000;

/** Sizes are a `ListObjectsV2` per rung, which is why they are cached rather
 * than folded into `listWatchPartyHistory`: a history load listing objects
 * for twenty broadcasts would be sixty bucket round-trips for a dialog that
 * usually downloads none of them. The dialog asks per broadcast, when the
 * download menu is opened. A finished broadcast's objects never change, so
 * the entry is good for as long as the retention window lets it exist. */
const DOWNLOAD_SIZE_TTL_MS = 300_000;
const downloadSizeCache = new Map<
  string,
  { sizes: WatchPartyDownloadSizes; at: number }
>();

export function resetWatchPartyDownloadCacheForTests(): void {
  downloadSizeCache.clear();
}

interface BroadcastRungRow {
  rung: string | null;
  available: boolean;
}

/** Every row of this broadcast with its own availability, by the same
 * predicate the replay paths use. */
async function broadcastRungRows(
  channelId: string,
  startedAtMs: number,
): Promise<BroadcastRungRow[]> {
  const result = await getPool().query<BroadcastRungRow>(
    `SELECT rung, (${availablePredicate(3, 4)}) AS available
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

async function objectSizes(
  prefix: string,
  config: NonNullable<ReturnType<typeof liveHlsStorageConfig>>,
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const object of await listObjects(prefix, config)) {
    sizes.set(object.key, object.size);
  }
  return sizes;
}

/**
 * How big each of the three files is, or null for one this broadcast never
 * wrote. Sizes are approximate by contract -- they are what the bucket
 * reports for the objects under the rung's prefix, which is exactly what the
 * download concatenates, but a caller should treat them as a label on a
 * button rather than a `Content-Length` promise.
 *
 * Refuses (throws) nothing when storage is down: a listing that fails leaves
 * that kind `null`, because "we could not price it" and "it is not there"
 * both mean the same thing to the dialog, and a bucket hiccup should not
 * take the whole history dialog with it.
 */
export async function watchPartyDownloadSizes(
  channelId: string,
  startedAtMs: number,
  now = Date.now(),
): Promise<WatchPartyDownloadSizes> {
  const cacheKey = `${channelId}:${startedAtMs}`;
  const cached = downloadSizeCache.get(cacheKey);
  if (cached && now - cached.at < DOWNLOAD_SIZE_TTL_MS) {
    return cached.sizes;
  }
  const sizes: WatchPartyDownloadSizes = {
    film: null,
    camera: null,
    voice: null,
  };
  const config = liveHlsStorageConfig();
  if (config) {
    const rungs = downloadRungs(await broadcastRungRows(channelId, startedAtMs));
    for (const kind of WATCH_PARTY_DOWNLOAD_KINDS) {
      const rung = rungs[kind];
      if (!rung) {
        continue;
      }
      const prefix =
        kind === "voice"
          ? micArchiveObjectKey(channelId, startedAtMs)
          : `${hlsObjectPrefix(channelId, startedAtMs, rung)}`;
      try {
        let total = 0;
        for (const object of await listObjects(prefix, config)) {
          // Playlists are a rounding error next to the segments, but counting
          // them would make the number disagree with what is actually sent.
          if (kind === "voice" || object.key.endsWith(".ts")) {
            total += object.size;
          }
        }
        sizes[kind] = total > 0 ? total : null;
      } catch (error) {
        console.warn(
          `[voice] could not size the ${kind} download for ${channelId}/${startedAtMs}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
  pruneStale(downloadSizeCache, now);
  downloadSizeCache.set(cacheKey, { sizes, at: now });
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
 * read -- the same two errors the replay builders raise, mapped by the route
 * to the same statuses.
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
  const rung = downloadRungs(await broadcastRungRows(channelId, startedAtMs))[
    kind
  ];
  if (!rung) {
    return null;
  }
  if (kind === "voice") {
    // One object, whose size the bucket can state exactly.
    const key = micArchiveObjectKey(channelId, startedAtMs);
    const sizes = await objectSizes(key, config);
    if (!sizes.has(key)) {
      return null;
    }
    return {
      kind,
      contentType: DOWNLOAD_CONTENT_TYPE[kind],
      extension: "ogg",
      keys: [key],
      bytes: sizes.get(key)!,
    };
  }
  const objectPrefix = hlsObjectPrefix(channelId, startedAtMs, rung);
  const keys = playlistKeys(
    await fetchReplayPlaylistBody(config, channelId, startedAtMs, rung),
    objectPrefix,
  );
  if (keys.length === 0) {
    return null;
  }
  // `Content-Length` only when every segment the playlist names was priced by
  // the listing. A number that is merely close is worse than none at all: the
  // browser would report the download as failed (short) or hang waiting for
  // bytes that never come (long).
  const sizes = await objectSizes(objectPrefix, config);
  let total = 0;
  let exact = true;
  for (const key of keys) {
    const size = sizes.get(key);
    if (size === undefined) {
      exact = false;
      break;
    }
    total += size;
  }
  return {
    kind,
    contentType: DOWNLOAD_CONTENT_TYPE[kind],
    extension: "ts",
    keys,
    bytes: exact ? total : null,
  };
}

/**
 * Pipes the plan's objects into `target`, one after another, with
 * backpressure: `pipeline` only pulls the next chunk out of storage when the
 * socket has taken the last one, so a three-hour broadcast never exists in
 * this process's memory. `{ end: false }` keeps the response open between
 * objects; the caller ends it.
 *
 * Once the first byte is out there is no way to turn the answer into an HTTP
 * error, so a failure mid-stream can only destroy the response and let the
 * client see a truncated download -- which is why the plan is built (and
 * every "is this still there" question answered) BEFORE the head is written.
 */
export async function streamWatchPartyDownload(
  plan: WatchPartyDownloadPlan,
  target: NodeJS.WritableStream,
): Promise<void> {
  const config = liveHlsStorageConfig();
  if (!config) {
    throw new HlsPlaylistUnavailable("Live HLS storage is not configured");
  }
  for (const key of plan.keys) {
    const url = signRequest({
      method: "GET",
      key,
      ttlSeconds: DOWNLOAD_OBJECT_TTL_SECONDS,
      forRead: true,
      config,
    }).url;
    let response: Response;
    try {
      response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(DOWNLOAD_OBJECT_TIMEOUT_MS),
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
    await pipeline(
      // `fetch`'s body is typed as the DOM `ReadableStream`, `Readable.fromWeb`
      // takes the `node:stream/web` one; they are the same object at runtime
      // and differ only in how the two lib definitions spell it.
      Readable.fromWeb(
        response.body as unknown as NodeReadableStream<Uint8Array>,
      ),
      target,
      { end: false },
    );
  }
}
