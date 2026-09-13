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
 * AVAILABILITY MIRRORS THE SWEEP EXACTLY. `sessionReplayAvailable` is the
 * logical negation of `dueSessions`' WHERE clause in `hls-cleanup.ts`: a row
 * is still there when it has not been cleaned AND (either it is not marked
 * `keep_replay` and is younger than `LIVE_HLS_RETENTION_MINUTES`, or it IS
 * marked and is younger than `LIVE_HLS_REPLAY_HOURS`). Keeping the two
 * predicates as exact negations of each other, rather than approximating with
 * `cleaned_at IS NULL` alone, is what CLAUDE.md pitfall about "a finished
 * session went on answering as if it were live" was about: `cleaned_at` lags
 * the real window by up to one sweep tick (60s), so a session can be past its
 * window and still show `cleaned_at IS NULL`.
 */
import { getPool } from "../db.js";
import { signRequest } from "../lib/s3.js";
import {
  hlsObjectPrefix,
  hlsReplayHours,
  hlsRetentionMinutes,
  hlsUrlTtlSeconds,
  liveHlsStorageConfig,
} from "./hls-egress.js";
import { buildMasterPlaylist, LADDER_RUNGS, type MasterVariant } from "./hls-ladder.js";
import { HlsPlaylistNotFound, HlsPlaylistUnavailable } from "./hls-playlist-proxy.js";
import { HLS_VIEWER_TOKEN_PARAM } from "./hls-viewer-token.js";

const LADDER_RUNG_NAMES = Object.keys(LADDER_RUNGS);
const REQUEST_TIMEOUT_MS = 10_000;

export interface WatchPartyHistoryEntry {
  /** The broadcast's `started_at`, epoch milliseconds, as a string. Stable
   * across the list/patch/replay routes -- it is the same value `hls-egress.ts`
   * already uses to name the session in the live playlist URL. */
  sessionId: string;
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
         BOOL_OR(
           cleaned_at IS NULL
           AND ended_at IS NOT NULL
           AND (
             (keep_replay = FALSE AND ended_at >= NOW() - ($3 || ' minutes')::interval)
             OR (keep_replay = TRUE AND ended_at >= NOW() - ($4 || ' hours')::interval)
           )
         ) AS any_available
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
       (s.all_ended AND s.any_available) AS replay_available,
       presenter.user_id AS presenter_user_id,
       presenter.display_name AS presenter_display_name
     FROM sessions s
     LEFT JOIN LATERAL (
       SELECT cs.host_user_id AS user_id, u.display_name
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

async function sessionRowsExist(
  channelId: string,
  startedAtMs: number,
): Promise<boolean> {
  const result = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM hls_sessions
       WHERE channel_id = $1 AND started_at = to_timestamp($2 / 1000.0)
     ) AS exists`,
    [channelId, startedAtMs],
  );
  return result.rows[0]?.exists ?? false;
}

/** The negation of `dueSessions` in `hls-cleanup.ts` -- see file header. */
async function sessionReplayAvailable(
  channelId: string,
  startedAtMs: number,
): Promise<boolean> {
  const result = await getPool().query<{ available: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM hls_sessions
       WHERE channel_id = $1
         AND started_at = to_timestamp($2 / 1000.0)
         AND (rung IS NULL OR rung = ANY($5::text[]))
         AND cleaned_at IS NULL
         AND ended_at IS NOT NULL
         AND (
           (keep_replay = FALSE AND ended_at >= NOW() - ($3 || ' minutes')::interval)
           OR (keep_replay = TRUE AND ended_at >= NOW() - ($4 || ' hours')::interval)
         )
     ) AS available`,
    [channelId, startedAtMs, hlsRetentionMinutes(), hlsReplayHours(), LADDER_RUNG_NAMES],
  );
  return result.rows[0]?.available ?? false;
}

export type WatchPartyHistoryLookup = "ok" | "not-found" | "unavailable";

/** Used by the replay-URL route: does this broadcast exist, and can it still
 * be watched? Kept separate from the write below so a read never risks a
 * write's side effect. */
export async function checkWatchPartyReplayAccess(
  channelId: string,
  startedAtMs: number,
): Promise<WatchPartyHistoryLookup> {
  if (!(await sessionRowsExist(channelId, startedAtMs))) {
    return "not-found";
  }
  return (await sessionReplayAvailable(channelId, startedAtMs))
    ? "ok"
    : "unavailable";
}

/**
 * Flips `keep_replay` on every row of the broadcast (every ladder rung, the
 * mic archive and the camera pip alike), so the retention sweep keeps or
 * drops the whole thing together. Refuses once the segments are already gone
 * -- there is nothing left to keep, in either direction.
 */
export async function setWatchPartyKeepReplay(
  channelId: string,
  startedAtMs: number,
  keepReplay: boolean,
): Promise<WatchPartyHistoryLookup> {
  if (!(await sessionRowsExist(channelId, startedAtMs))) {
    return "not-found";
  }
  if (!(await sessionReplayAvailable(channelId, startedAtMs))) {
    return "unavailable";
  }
  await getPool().query(
    `UPDATE hls_sessions SET keep_replay = $3
     WHERE channel_id = $1 AND started_at = to_timestamp($2 / 1000.0)`,
    [channelId, startedAtMs, keepReplay],
  );
  return "ok";
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
 * underlying playlist is still being rewritten every segment. */
const REPLAY_CACHE_TTL_MS = 30_000;
const replayBodyCache = new Map<string, { body: string; at: number }>();
const replayRungCache = new Map<
  string,
  { rungs: string[]; at: number }
>();

export function resetHlsReplayCachesForTests(): void {
  replayBodyCache.clear();
  replayRungCache.clear();
}

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
  const result = await getPool().query<{ rung: string | null }>(
    `SELECT rung FROM hls_sessions
     WHERE channel_id = $1
       AND object_prefix LIKE $2
       AND rung IS NOT NULL
       AND ended_at IS NOT NULL
       AND cleaned_at IS NULL
     ORDER BY started_at ASC`,
    [channelId, `${hlsObjectPrefix(channelId, startedAt)}-%`],
  );
  const rungs = result.rows
    .map((row) => row.rung)
    .filter((rung): rung is string => Boolean(rung && LADDER_RUNGS[rung]));
  replayRungCache.set(key, { rungs, at: now });
  return rungs;
}

/** The master playlist for a replay, or null when the broadcast never ran a
 * ladder rung that is still available (a pre-ladder session, or one whose
 * objects are already swept). */
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

/** One rendition of a replay: the accumulated `-index.m3u8`, segment lines
 * rewritten into presigned URLs. Throws `HlsPlaylistNotFound` when this
 * broadcast never ended, was swept, or never existed, and
 * `HlsPlaylistUnavailable` when the bucket could not be read. */
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
       AND ended_at IS NOT NULL
       AND cleaned_at IS NULL`,
    [channelId, objectPrefix],
  );
  if (session.rowCount === 0) {
    replayBodyCache.delete(cacheKey);
    throw new HlsPlaylistNotFound(
      `No replay ${objectPrefix} for channel ${channelId}`,
    );
  }
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
  const body = await response.text();
  const ttl = hlsUrlTtlSeconds();
  const signedAt = new Date(now);
  const prefixDir = `${objectPrefix.split("/").slice(0, -1).join("/")}/`;
  const rewritten = body
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) {
        return line;
      }
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
  replayBodyCache.set(cacheKey, { body: rewritten, at: now });
  return rewritten;
}
