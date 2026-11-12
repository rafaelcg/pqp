import { randomUUID } from "node:crypto";
import {
  JAM_AUDIO_CONTENT_TYPES,
  JAM_AUDIO_MAX_BYTES,
  JAM_COVER_CONTENT_TYPES,
  JAM_COVER_MAX_BYTES,
  JAM_ERRORS,
  JAM_INSTRUMENTS,
  JAM_MAX_TRACKS_PER_AUTHOR,
  JAM_MAX_TRACKS_PER_SONG,
  JAM_PAGE_SIZE,
  JAM_PREVIEW_CONTRIBUTORS_MAX,
  JAM_PREVIEW_PEAKS_MAX,
  JAM_SONGS_PER_WINDOW,
  JAM_UPLOADS_PER_WINDOW,
  JAM_VIDEO_CONTENT_TYPES,
  JAM_VIDEO_MAX_BYTES,
  JAM_WINDOW_MS,
  type AddJamTrackRequest,
  type CreateJamSongRequest,
  type CreateJamUploadRequest,
  type JamInstrument,
  type JamJoinMode,
  type JamSongSummary,
  type JamTrack,
  type JamVideoSource,
  type JamUploadKind,
  type JamUploadTicket,
  type ListJamSongsQuery,
  type UpdateJamSongRequest,
  type UpdateJamTrackRequest,
} from "@pqp/shared";
import type { PoolClient } from "pg";
import { getPool } from "../db.js";
import { sharedRateLimit } from "../lib/cluster-rate-limit.js";
import { HttpError } from "../lib/http.js";
import { sniffImage } from "../lib/image-info.js";
import {
  deleteObject,
  getObjectPrefix,
  headObject,
  isStorageConfigured,
  presignGet,
  presignPut,
} from "../lib/s3.js";
import { attachmentUrlTtlSeconds } from "./attachments.js";
import { enqueueJamVideoTranscode } from "./jam-video-transcode.js";

/**
 * Jam channels: songs, tracks, votes and the upload ledger. The contract and
 * the meaning of every field are in `packages/shared/src/jam.ts`; the route
 * layer (`api/jam-routes.ts`) decides who may do what and calls these, and
 * the realtime frames are sent from there too, so nothing in this file knows
 * about a socket.
 *
 * Three rules shaped it, all from CLAUDE.md:
 *  - NOTHING between BEGIN and COMMIT touches the network. The two HEADs that
 *    verify an upload run before the claim transaction opens, on the pool.
 *  - Writes are ordered by a row lock, not by hope: adding a track locks the
 *    song row (`FOR UPDATE`), so the track limits, the `joinMode` check and
 *    "first take of an instrument" are all decided against the same state the
 *    insert lands in, even with two API instances.
 *  - No new column on a hot table (pitfall 22): everything here is a new
 *    table.
 */

/** Presigned PUT lifetime, the attachments' number. */
const UPLOAD_URL_TTL_SECONDS = 15 * 60;
/** An unclaimed upload is deleted after this. */
const ORPHAN_GRACE = "1 hour";
/** A deleted track's objects are kept this long before the sweep deletes them. */
const PURGE_GRACE = "1 day";
/**
 * A song with no track since this long is deleted by the sweep. Such a song is
 * what a first take leaves behind when the page was closed between creating the
 * song and finishing the upload; only its author can see it until then.
 */
const EMPTY_SONG_GRACE = "24 hours";
/** How much of a cover's start is read to check it is the picture it says it is. */
const COVER_SNIFF_BYTES = 256 * 1024;
/** Rows per sweep pass. */
const SWEEP_BATCH = 100;

const SONG_BUCKET = {
  bucket: "jam-song",
  capacity: JAM_SONGS_PER_WINDOW,
  refillPerSecond: JAM_SONGS_PER_WINDOW / (JAM_WINDOW_MS / 1000),
} as const;
const UPLOAD_BUCKET = {
  bucket: "jam-upload",
  capacity: JAM_UPLOADS_PER_WINDOW,
  refillPerSecond: JAM_UPLOADS_PER_WINDOW / (JAM_WINDOW_MS / 1000),
} as const;

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "audio/flac": ".flac",
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "video/webm": ".webm",
  "video/mp4": ".mp4",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

type Db = Pick<PoolClient, "query">;

// ---------------------------------------------------------------- rows

export interface JamSongRow {
  id: string;
  channel_id: string;
  server_id: string;
  author_id: string | null;
  title: string;
  artist: string | null;
  join_mode: JamJoinMode;
  wanted_instruments: string[];
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface JamTrackRow {
  id: string;
  song_id: string;
  author_id: string;
  instrument: string;
  label: string | null;
  audio_key: string;
  audio_content_type: string;
  audio_bytes: string;
  video_key: string | null;
  video_content_type: string | null;
  video_bytes: string | null;
  /** The worker's MP4 copy (null until it is made); the type is set last and is what a read checks. */
  video_mp4_key: string | null;
  video_mp4_content_type: string | null;
  video_mp4_bytes: string | null;
  offset_ms: number;
  trim_start_ms: number;
  trim_end_ms: number;
  duration_ms: number;
  gain: number;
  peaks: number[];
  in_mix: boolean;
  created_at: Date;
  deleted_at: Date | null;
}

const SONG_COLUMNS = `s.id, s.channel_id, s.server_id, s.author_id, s.title, s.artist,
       s.join_mode, s.wanted_instruments, s.created_at, s.updated_at, s.deleted_at`;

/** A live song, or null. The service never returns a deleted one. */
export async function getJamSongRow(
  songId: string,
  db: Db = getPool(),
): Promise<JamSongRow | null> {
  const result = await db.query<JamSongRow>(
    `SELECT ${SONG_COLUMNS} FROM jam_songs s WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [songId],
  );
  return result.rows[0] ?? null;
}

/** A live track and its live song's ids, or null. */
export async function getJamTrackRow(
  trackId: string,
  db: Db = getPool(),
): Promise<(JamTrackRow & { channel_id: string; server_id: string; song_author_id: string | null }) | null> {
  const result = await db.query<
    JamTrackRow & { channel_id: string; server_id: string; song_author_id: string | null }
  >(
    `SELECT t.*, s.channel_id, s.server_id, s.author_id AS song_author_id
       FROM jam_tracks t JOIN jam_songs s ON s.id = t.song_id
      WHERE t.id = $1 AND t.deleted_at IS NULL AND s.deleted_at IS NULL`,
    [trackId],
  );
  return result.rows[0] ?? null;
}

/**
 * The one 404 the jam answers for a missing channel, song or track, to a caller
 * who may not see it and to one who asked for something that is not there: the
 * wording must not tell the two apart.
 */
export const JAM_NOT_FOUND = "Not found";

/** A summary for a song that was live a moment ago; 404 if a delete got there first. */
async function requireSummary(songId: string): Promise<JamSongSummary> {
  const summary = await getJamSongSummary(songId);
  if (!summary) {
    throw new HttpError(404, JAM_NOT_FOUND);
  }
  return summary;
}

// ------------------------------------------------------------- mapping

function instrumentRank(instrument: string): number {
  const index = (JAM_INSTRUMENTS as readonly string[]).indexOf(instrument);
  return index === -1 ? JAM_INSTRUMENTS.length : index;
}

function sortInstruments(list: readonly string[]): JamInstrument[] {
  return [...list]
    .sort((a, b) => instrumentRank(a) - instrumentRank(b))
    .map((one) => ((JAM_INSTRUMENTS as readonly string[]).includes(one) ? one : "other") as JamInstrument);
}

interface SongSummaryRow extends JamSongRow {
  author_name: string | null;
  author_avatar_url: string | null;
  track_count: number;
  instruments: string[];
  contributor_count: number;
  mix_start: number | null;
  mix_end: number | null;
  has_video: boolean | null;
  /** The object key of the song's cover, when it has one. */
  cover_key: string | null;
  preview_peaks: number[] | null;
  contributors: Array<{ id: string; name: string | null; avatarUrl: string | null }> | null;
  created_cursor: string;
  updated_cursor: string;
}

/**
 * One query for the summaries of a set of songs (a page, or one): the author's
 * name as the server shows it (nickname first) and the live-track aggregates,
 * with a LATERAL so a page of 25 is 25 index probes on
 * `idx_jam_tracks_song`, not a scan of every track.
 */
const SUMMARY_SELECT = `
  SELECT ${SONG_COLUMNS},
         COALESCE(NULLIF(sm.nickname, ''), u.display_name) AS author_name,
         u.avatar_url AS author_avatar_url,
         agg.track_count, agg.instruments, agg.contributor_count,
         agg.mix_start, agg.mix_end, agg.has_video,
         cover.storage_key AS cover_key,
         prev.preview_peaks, contrib.contributors,
         -- The keyset cursor carries the timestamps at full microsecond
         -- precision: a JS Date keeps milliseconds, and two songs written in
         -- one millisecond would otherwise straddle a page boundary and one
         -- of them be skipped.
         to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_cursor,
         to_char(s.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_cursor
    FROM jam_songs s
    LEFT JOIN users u ON u.id = s.author_id
    LEFT JOIN server_members sm ON sm.server_id = s.server_id AND sm.user_id = s.author_id
    LEFT JOIN jam_song_covers sc ON sc.song_id = s.id
    LEFT JOIN jam_uploads cover ON cover.id = sc.upload_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS track_count,
             COALESCE(array_agg(DISTINCT t.instrument), '{}') AS instruments,
             COUNT(DISTINCT t.author_id)::int AS contributor_count,
             -- Earliest to latest HEARD sample. offset_ms is the song time of the
             -- stored file's first sample and a trim hides audio without moving
             -- it (header of packages/shared/src/jam.ts).
             MIN(t.offset_ms + t.trim_start_ms) FILTER (WHERE t.in_mix) AS mix_start,
             MAX(t.offset_ms + t.duration_ms - t.trim_end_ms)
               FILTER (WHERE t.in_mix) AS mix_end,
             BOOL_OR(t.video_key IS NOT NULL) AS has_video
        FROM jam_tracks t
       WHERE t.song_id = s.id AND t.deleted_at IS NULL
    ) agg ON TRUE
    -- The preview waveform: the in-mix track with the most signal. The sum runs
    -- over at most 32 tracks x 400 numbers per song, on the rows the aggregate
    -- above already reads from the same index, and never leaves the database.
    LEFT JOIN LATERAL (
      SELECT t.peaks AS preview_peaks
        FROM jam_tracks t
       WHERE t.song_id = s.id AND t.deleted_at IS NULL AND t.in_mix
         AND jsonb_array_length(t.peaks) > 0
       ORDER BY (SELECT COALESCE(SUM(v::float8), 0) FROM jsonb_array_elements_text(t.peaks) v) DESC,
                t.created_at, t.id
       LIMIT 1
    ) prev ON TRUE
    -- The first people to add a track, named as the server names them.
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
               jsonb_build_object('id', c.author_id, 'name', c.name, 'avatarUrl', c.avatar)
               ORDER BY c.first_at, c.author_id) AS contributors
        FROM (
          SELECT t.author_id, MIN(t.created_at) AS first_at,
                 COALESCE(NULLIF(MAX(sm2.nickname), ''), MAX(u2.display_name)) AS name,
                 MAX(u2.avatar_url) AS avatar
            FROM jam_tracks t
            JOIN users u2 ON u2.id = t.author_id
            LEFT JOIN server_members sm2 ON sm2.server_id = s.server_id AND sm2.user_id = t.author_id
           WHERE t.song_id = s.id AND t.deleted_at IS NULL
           GROUP BY t.author_id
           ORDER BY MIN(t.created_at), t.author_id
           LIMIT ${JAM_PREVIEW_CONTRIBUTORS_MAX}
        ) c
    ) contrib ON TRUE`;

/**
 * At most `JAM_PREVIEW_PEAKS_MAX` values: the loudest value of each bucket, so a
 * short transient survives the reduction. Values are clamped to 0..1 (the
 * column holds what the recorder sent, already bounded, but a reader should not
 * have to trust that).
 */
export function reducePeaks(peaks: readonly number[], max = JAM_PREVIEW_PEAKS_MAX): number[] {
  const clean = peaks.map((value) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0));
  if (clean.length <= max) {
    return clean;
  }
  const out: number[] = [];
  for (let bucket = 0; bucket < max; bucket += 1) {
    const from = Math.floor((bucket * clean.length) / max);
    const to = Math.max(from + 1, Math.floor(((bucket + 1) * clean.length) / max));
    out.push(Math.max(...clean.slice(from, to)));
  }
  return out;
}

function mapSong(row: SongSummaryRow): JamSongSummary {
  const present = new Set(row.instruments ?? []);
  return {
    id: row.id,
    channelId: row.channel_id,
    serverId: row.server_id,
    title: row.title,
    artist: row.artist,
    joinMode: row.join_mode,
    wantedInstruments: sortInstruments(row.wanted_instruments),
    authorId: row.author_id,
    authorName: row.author_name,
    authorAvatarUrl: row.author_avatar_url,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    trackCount: row.track_count ?? 0,
    instruments: sortInstruments(row.instruments ?? []),
    contributorCount: row.contributor_count ?? 0,
    mixDurationMs:
      row.mix_start === null || row.mix_end === null || row.mix_start === undefined
        ? null
        : Math.max(0, row.mix_end - row.mix_start),
    previewPeaks: row.preview_peaks ? reducePeaks(row.preview_peaks) : [],
    hasVideo: row.has_video === true,
    coverUrl: row.cover_key ? signedUrl(row.cover_key, attachmentUrlTtlSeconds()) || null : null,
    contributors: (row.contributors ?? []).map((one) => ({
      id: one.id,
      name: one.name,
      avatarUrl: one.avatarUrl,
    })),
    missingInstruments:
      row.join_mode === "wanted"
        ? sortInstruments(row.wanted_instruments.filter((one) => !present.has(one)))
        : [],
  };
}

/** The summary of one live song, or null. */
export async function getJamSongSummary(
  songId: string,
  db: Db = getPool(),
): Promise<JamSongSummary | null> {
  const result = await db.query<SongSummaryRow>(
    `${SUMMARY_SELECT} WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [songId],
  );
  return result.rows[0] ? mapSong(result.rows[0]) : null;
}

interface TrackJoinRow extends JamTrackRow {
  author_name: string | null;
  author_avatar_url: string | null;
  vote_count: number;
}

const TRACK_SELECT = `
  SELECT t.*,
         COALESCE(NULLIF(sm.nickname, ''), u.display_name) AS author_name,
         u.avatar_url AS author_avatar_url,
         (SELECT COUNT(*)::int FROM jam_track_votes v WHERE v.track_id = t.id) AS vote_count
    FROM jam_tracks t
    JOIN jam_songs s ON s.id = t.song_id
    JOIN users u ON u.id = t.author_id
    LEFT JOIN server_members sm ON sm.server_id = s.server_id AND sm.user_id = t.author_id`;

function signedUrl(key: string, ttlSeconds: number): string {
  // A deployment that turned storage off after tracks existed cannot sign:
  // the track still lists, with no way to play it, instead of failing the read.
  return isStorageConfigured() ? presignGet(key, { ttlSeconds }) : "";
}

/**
 * The files a track's video exists as, best first: the worker's MP4 copy (once
 * its content type is set, which is the last write of the job), then the
 * recorded file. See `jamVideoSourceSchema`.
 */
function videoSourcesOf(row: JamTrackRow, ttl: number): JamVideoSource[] {
  const sources: JamVideoSource[] = [];
  if (row.video_mp4_key && row.video_mp4_content_type) {
    sources.push({
      url: signedUrl(row.video_mp4_key, ttl),
      contentType: row.video_mp4_content_type,
      bytes: row.video_mp4_bytes === null ? 0 : Number(row.video_mp4_bytes),
    });
  }
  if (row.video_key) {
    sources.push({
      url: signedUrl(row.video_key, ttl),
      contentType: row.video_content_type ?? "video/webm",
      bytes: row.video_bytes === null ? 0 : Number(row.video_bytes),
    });
  }
  return sources;
}

function mapTrack(row: TrackJoinRow): JamTrack {
  const ttl = attachmentUrlTtlSeconds();
  const videoSources = videoSourcesOf(row, ttl);
  // `videoUrl` stays the one best file for a client that reads no list: the
  // copy when there is one, the recorded file otherwise (null for no video).
  const best = videoSources[0] ?? null;
  return {
    id: row.id,
    songId: row.song_id,
    authorId: row.author_id,
    authorName: row.author_name,
    authorAvatarUrl: row.author_avatar_url,
    instrument: (JAM_INSTRUMENTS as readonly string[]).includes(row.instrument)
      ? (row.instrument as JamInstrument)
      : "other",
    label: row.label,
    audioUrl: signedUrl(row.audio_key, ttl),
    audioContentType: row.audio_content_type,
    audioBytes: Number(row.audio_bytes),
    videoUrl: best ? best.url : null,
    videoContentType: best ? best.contentType : row.video_content_type,
    videoBytes: best ? best.bytes : row.video_bytes === null ? null : Number(row.video_bytes),
    videoSources,
    mediaExpiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    offsetMs: row.offset_ms,
    trimStartMs: row.trim_start_ms,
    trimEndMs: row.trim_end_ms,
    durationMs: row.duration_ms,
    gain: row.gain,
    peaks: row.peaks,
    inMix: row.in_mix,
    voteCount: row.vote_count,
    createdAt: row.created_at.toISOString(),
  };
}

/** One live track, as a viewer reads it, or null. */
export async function getJamTrack(
  trackId: string,
  db: Db = getPool(),
): Promise<JamTrack | null> {
  const result = await db.query<TrackJoinRow>(
    `${TRACK_SELECT} WHERE t.id = $1 AND t.deleted_at IS NULL AND s.deleted_at IS NULL`,
    [trackId],
  );
  return result.rows[0] ? mapTrack(result.rows[0]) : null;
}

/** A song's live tracks, oldest first. */
export async function listJamTracks(
  songId: string,
  db: Db = getPool(),
): Promise<JamTrack[]> {
  const result = await db.query<TrackJoinRow>(
    `${TRACK_SELECT}
      WHERE t.song_id = $1 AND t.deleted_at IS NULL AND s.deleted_at IS NULL
      ORDER BY t.created_at, t.id`,
    [songId],
  );
  return result.rows.map(mapTrack);
}

/** The tracks (ids) of one song this person has voted for. */
export async function listVotedTrackIds(
  songId: string,
  userId: string,
): Promise<string[]> {
  const result = await getPool().query<{ track_id: string }>(
    `SELECT v.track_id
       FROM jam_track_votes v JOIN jam_tracks t ON t.id = v.track_id
      WHERE t.song_id = $1 AND t.deleted_at IS NULL AND v.user_id = $2`,
    [songId, userId],
  );
  return result.rows.map((row) => row.track_id);
}

// ---------------------------------------------------------------- list

interface ListCursor {
  at: string;
  id: string;
}

function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(raw: string): ListCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as ListCursor;
    return typeof parsed.at === "string" &&
      !Number.isNaN(Date.parse(parsed.at)) &&
      typeof parsed.id === "string" &&
      /^[0-9a-f-]{36}$/i.test(parsed.id)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** A page of a channel's songs. A cursor that does not parse is read as page one. */
export async function listJamSongs(input: {
  channelId: string;
  viewerId: string;
  query: ListJamSongsQuery;
}): Promise<{ songs: JamSongSummary[]; nextCursor: string | null }> {
  const { channelId, viewerId, query } = input;
  const limit = query.limit ?? JAM_PAGE_SIZE;
  const sortColumn = query.sort === "created" ? "s.created_at" : "s.updated_at";
  const params: unknown[] = [channelId];
  const where = [`s.channel_id = $1`, `s.deleted_at IS NULL`];

  // A song with no track is its author's alone: it is what a first take that
  // never finished uploading leaves behind, and to everybody else it is a tile
  // that plays nothing. The frames follow the same rule (`jam-routes.ts`).
  params.push(viewerId);
  where.push(`(agg.track_count > 0 OR s.author_id = $${params.length})`);
  if (query.mine) {
    params.push(viewerId);
    where.push(`s.author_id = $${params.length}`);
  }
  if (query.wanting) {
    params.push(query.wanting);
    where.push(`s.join_mode = 'wanted' AND $${params.length}::text = ANY(s.wanted_instruments)`);
  }
  if (query.q) {
    // Case and accent insensitive without the unaccent extension (not
    // installed everywhere): fold both sides through translate().
    params.push(`%${escapeLike(fold(query.q))}%`);
    where.push(
      `(${FOLD_SQL("s.title")} LIKE $${params.length} ESCAPE '\\'
        OR ${FOLD_SQL("COALESCE(s.artist, '')")} LIKE $${params.length} ESCAPE '\\')`,
    );
  }
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (cursor) {
    params.push(cursor.at, cursor.id);
    where.push(`(${sortColumn}, s.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  const result = await getPool().query<SongSummaryRow>(
    `${SUMMARY_SELECT}
      WHERE ${where.join(" AND ")}
      ORDER BY ${sortColumn} DESC, s.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const rows = result.rows;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const more = rows.length > limit && last !== undefined;
  return {
    songs: page.map(mapSong),
    nextCursor: more
      ? encodeCursor({
          at: query.sort === "created" ? last.created_cursor : last.updated_cursor,
          id: last.id,
        })
      : null,
  };
}

// Accent folding for the title search, without the `unaccent` extension (not
// installed everywhere). Translated BEFORE lower(), so the result does not
// depend on the database's locale knowing how to lower an accented capital.
const ACCENTED = "áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ";
const PLAIN = "aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN";

function fold(value: string): string {
  return value
    .toLowerCase()
    .replace(/[áàâãä]/g, "a")
    .replace(/[éèêë]/g, "e")
    .replace(/[íìîï]/g, "i")
    .replace(/[óòôõö]/g, "o")
    .replace(/[úùûü]/g, "u")
    .replace(/ç/g, "c")
    .replace(/ñ/g, "n");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

const FOLD_SQL = (expression: string): string =>
  `lower(translate(${expression}, '${ACCENTED}', '${PLAIN}'))`;

// ----------------------------------------------------------- songs: write

/**
 * The live song a person already made in a channel with this nonce, or null.
 * A DELETED song's nonce is free again (the unique index is partial on live
 * rows), so a deleted song is neither returned nor in the way.
 */
async function songForNonce(
  channelId: string,
  authorId: string,
  nonce: string,
): Promise<JamSongSummary | null> {
  const existing = await getPool().query<{ id: string }>(
    `SELECT id FROM jam_songs
      WHERE channel_id = $1 AND author_id = $2 AND client_nonce = $3 AND deleted_at IS NULL`,
    [channelId, authorId, nonce],
  );
  return existing.rows[0] ? getJamSongSummary(existing.rows[0].id) : null;
}

/**
 * Create a song. A retried POST with the same nonce returns the LIVE song it
 * made (`created: false`) and spends no rate-limit token. A nonce whose song
 * was deleted is free: the create makes a new song. A constraint is never an
 * error to the caller: two creates racing on one nonce resolve to the
 * winner's song, and the rare loser whose winner was deleted before it could
 * read it inserts once more.
 */
export async function createJamSong(input: {
  channelId: string;
  serverId: string;
  authorId: string;
  request: CreateJamSongRequest;
}): Promise<{ song: JamSongSummary; created: boolean }> {
  const { channelId, serverId, authorId, request } = input;
  if (request.nonce) {
    const existing = await songForNonce(channelId, authorId, request.nonce);
    if (existing) {
      return { song: existing, created: false };
    }
  }
  if (!(await sharedRateLimit(SONG_BUCKET, authorId))) {
    throw new HttpError(429, JAM_ERRORS.rateLimited);
  }
  const joinMode = request.joinMode ?? "open";
  const wanted = joinMode === "wanted" ? (request.wantedInstruments ?? []) : [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await getPool().query<{ id: string }>(
        `INSERT INTO jam_songs
           (channel_id, server_id, author_id, title, artist, join_mode, wanted_instruments, client_nonce)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8)
         RETURNING id`,
        [
          channelId,
          serverId,
          authorId,
          request.title,
          request.artist ?? null,
          joinMode,
          wanted,
          request.nonce ?? null,
        ],
      );
      return { song: await requireSummary(result.rows[0]!.id), created: true };
    } catch (error) {
      // Two requests with one nonce raced: the loser reads the winner's song.
      if ((error as { code?: string }).code === "23505" && request.nonce) {
        const existing = await songForNonce(channelId, authorId, request.nonce);
        if (existing) {
          return { song: existing, created: false };
        }
        // The winner was deleted between the two statements: the nonce is free
        // again, so insert once more. A second miss is a 409, never a 500.
        if (attempt === 0) {
          continue;
        }
        throw new HttpError(409, JAM_ERRORS.nonceConflict);
      }
      throw error;
    }
  }
}

/**
 * Edit a song. The effective join mode and list are computed from the stored
 * row plus the patch: leaving `wanted` clears the list, and `wanted` with an
 * empty list (sent, or left over) is 422.
 */
export async function updateJamSong(
  song: JamSongRow,
  patch: UpdateJamSongRequest,
): Promise<JamSongSummary> {
  const joinMode = patch.joinMode ?? song.join_mode;
  let wanted =
    patch.wantedInstruments !== undefined ? patch.wantedInstruments : song.wanted_instruments;
  if (joinMode !== "wanted") {
    wanted = [];
  } else if (wanted.length === 0) {
    throw new HttpError(422, JAM_ERRORS.wantedNeedsInstruments);
  }
  const result = await getPool().query(
    `UPDATE jam_songs
        SET title = $2,
            artist = $3,
            join_mode = $4,
            wanted_instruments = $5::text[],
            updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL`,
    [
      song.id,
      patch.title ?? song.title,
      patch.artist !== undefined ? patch.artist : song.artist,
      joinMode,
      wanted,
    ],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new HttpError(404, JAM_NOT_FOUND);
  }
  return (await requireSummary(song.id));
}

// ------------------------------------------------------------------ cover

/**
 * Drop the object of a cover nothing points at any more, then its ledger row.
 * Best effort and never awaited by a request: the write that stopped pointing
 * at it has already committed, and a bucket that does not answer must not undo
 * it. The sweep (`sweepJamMedia`) is the backstop for a delete that failed.
 * The row goes only while no song names it, so a late retry can never remove
 * the object of a cover somebody has since set.
 */
function discardCoverUpload(previous: { id: string; storage_key: string } | undefined): void {
  if (!previous || !isStorageConfigured()) {
    return;
  }
  void (async () => {
    try {
      await deleteObject(previous.storage_key);
      await getPool().query(
        `DELETE FROM jam_uploads u
          WHERE u.id = $1 AND u.kind = 'cover'
            AND NOT EXISTS (SELECT 1 FROM jam_song_covers c WHERE c.upload_id = u.id)`,
        [previous.id],
      );
    } catch (error) {
      console.error(
        `[jam] could not delete the old cover ${previous.storage_key}:`,
        error instanceof Error ? error.message : error,
      );
    }
  })();
}

/**
 * The summary a cover write answers (and the route announces) once its change is
 * committed. A read that fails here would leave a committed change with no frame
 * and an error for the caller, so it is tried a few times first: a blip of the
 * database is the usual reason, and the write is already safe. A song that is
 * gone (an HttpError) is not retried. If it still fails the caller gets the
 * error, and its retry of the same call answers and announces (the claim and the
 * removal are both idempotent).
 */
async function summaryAfterCommit(
  songId: string,
  late?: (song: JamSongSummary) => void,
): Promise<JamSongSummary> {
  const waits = [150, 400];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requireSummary(songId);
    } catch (error) {
      const wait = waits[attempt];
      if (error instanceof HttpError || wait === undefined) {
        // The change is committed and the caller is about to get an error: the
        // room is told as soon as the song can be read, so no viewer stays stale
        // because the caller never retried.
        if (!(error instanceof HttpError) && late) {
          announceLate(songId, late);
        }
        throw error;
      }
      await new Promise((done) => setTimeout(done, wait));
    }
  }
}

/** How often, and how many times, a summary that could not be read after a commit is tried in the background. */
const LATE_RETRY_MS = 1000;
const LATE_RETRIES = 60;

function announceLate(songId: string, announce: (song: JamSongSummary) => void): void {
  void (async () => {
    for (let attempt = 0; attempt < LATE_RETRIES; attempt += 1) {
      await new Promise((done) => setTimeout(done, LATE_RETRY_MS));
      try {
        announce(await requireSummary(songId));
        return;
      } catch (error) {
        if (error instanceof HttpError) {
          return; // the song is gone: nothing to tell
        }
      }
    }
  })();
}

/** A cover tied to this caller already (a retried claim): nothing to do twice. */
async function coverAlreadySet(songId: string, uploadId: string, userId: string): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM jam_song_covers c JOIN jam_uploads u ON u.id = c.upload_id
      WHERE c.song_id = $1 AND c.upload_id = $2 AND u.uploader_id = $3`,
    [songId, uploadId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Make an upload of kind `cover` the song's picture. A retry of a claim that
 * already made it answers the same song (the route announces it again: frames
 * are idempotent, and the first call may have failed after the commit).
 *
 * Order, like adding a track: the upload row is found and HEAD-and-sniff
 * verified off any transaction, then one transaction locks the song, claims the
 * upload (an `UPDATE ... WHERE claimed_at IS NULL` that must touch its row, so
 * two racing claims cannot both win) and points the cover row at it. The
 * object the cover stopped being is deleted after the commit.
 */
export async function setJamCover(input: {
  song: JamSongRow;
  userId: string;
  uploadId: string;
  /** Called with the summary if it could only be read after this call gave up (see `summaryAfterCommit`). */
  late?: (song: JamSongSummary) => void;
}): Promise<{ song: JamSongSummary }> {
  const { song, userId, uploadId, late } = input;
  const unchanged = async () => ({ song: await summaryAfterCommit(song.id, late) });
  if (await coverAlreadySet(song.id, uploadId, userId)) {
    return unchanged();
  }
  const upload = await findOwnUpload(uploadId, song, userId, "cover");
  if (!upload) {
    if (await coverAlreadySet(song.id, uploadId, userId)) {
      return unchanged();
    }
    throw new HttpError(404, JAM_ERRORS.uploadUnknown);
  }
  if ((await verifyUpload(upload)) === null) {
    throw new HttpError(422, JAM_ERRORS.uploadNotVerified);
  }

  const client = await getPool().connect();
  let previous: { id: string; storage_key: string } | undefined;
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT 1 FROM jam_songs WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [song.id],
    );
    if ((locked.rowCount ?? 0) === 0) {
      throw new HttpError(404, JAM_NOT_FOUND);
    }
    const claimed = await client.query(
      `UPDATE jam_uploads SET claimed_at = NOW()
        WHERE id = $1 AND claimed_at IS NULL AND swept_at IS NULL AND uploader_id = $2`,
      [upload.id, userId],
    );
    if ((claimed.rowCount ?? 0) !== 1) {
      throw new HttpError(404, JAM_ERRORS.uploadUnknown);
    }
    const before = await client.query<{ id: string; storage_key: string }>(
      `SELECT u.id, u.storage_key FROM jam_song_covers c JOIN jam_uploads u ON u.id = c.upload_id
        WHERE c.song_id = $1`,
      [song.id],
    );
    previous = before.rows[0];
    await client.query(
      `INSERT INTO jam_song_covers (song_id, upload_id) VALUES ($1, $2)
       ON CONFLICT (song_id) DO UPDATE SET upload_id = EXCLUDED.upload_id, updated_at = NOW()`,
      [song.id, upload.id],
    );
    await client.query(`UPDATE jam_songs SET updated_at = NOW() WHERE id = $1`, [song.id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    // Two claims of one upload raced and the other one won: that is the answer.
    if (error instanceof HttpError && error.message === JAM_ERRORS.uploadUnknown) {
      if (await coverAlreadySet(song.id, uploadId, userId)) {
        return unchanged();
      }
    }
    throw error;
  } finally {
    client.release();
  }
  discardCoverUpload(previous);
  return { song: await summaryAfterCommit(song.id, late) };
}

/** Take the picture off a song. A song that has none answers as it is. */
export async function removeJamCover(
  song: JamSongRow,
  late?: (song: JamSongSummary) => void,
): Promise<{ song: JamSongSummary }> {
  const client = await getPool().connect();
  let previous: { id: string; storage_key: string } | undefined;
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT 1 FROM jam_songs WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [song.id],
    );
    if ((locked.rowCount ?? 0) === 0) {
      throw new HttpError(404, JAM_NOT_FOUND);
    }
    const removed = await client.query<{ id: string; storage_key: string }>(
      `WITH gone AS (DELETE FROM jam_song_covers WHERE song_id = $1 RETURNING upload_id)
       SELECT u.id, u.storage_key FROM gone JOIN jam_uploads u ON u.id = gone.upload_id`,
      [song.id],
    );
    previous = removed.rows[0];
    if (previous) {
      await client.query(`UPDATE jam_songs SET updated_at = NOW() WHERE id = $1`, [song.id]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  discardCoverUpload(previous);
  return { song: await summaryAfterCommit(song.id, late) };
}

/**
 * Soft-delete a song and every live track in it, in one statement pair. The
 * objects are deleted by the sweep a day later (`sweepJamMedia`), which is
 * also the window in which a mistaken delete could be recovered by hand.
 * Returns false when the song was already gone.
 *
 * `onlyIfEmpty`: the studio of a song it made asks for the song to go when the
 * person leaves with nothing sent. The song row is locked and its tracks looked
 * at in the same transaction, so a claim that committed without its answer
 * reaching the page (and a take added by anybody else) is never deleted: 409
 * `jam_song_not_empty` and nothing changes.
 */
export async function deleteJamSong(
  songId: string,
  options: { onlyIfEmpty?: boolean } = {},
): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (options.onlyIfEmpty) {
      await client.query(`SELECT 1 FROM jam_songs WHERE id = $1 FOR UPDATE`, [songId]);
      const held = await client.query(
        `SELECT 1 FROM jam_tracks WHERE song_id = $1 AND deleted_at IS NULL LIMIT 1`,
        [songId],
      );
      if ((held.rowCount ?? 0) > 0) {
        throw new HttpError(409, JAM_ERRORS.songNotEmpty);
      }
    }
    const song = await client.query(
      `UPDATE jam_songs SET deleted_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL`,
      [songId],
    );
    if ((song.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `UPDATE jam_tracks SET deleted_at = NOW() WHERE song_id = $1 AND deleted_at IS NULL`,
      [songId],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------- permission

/**
 * Which instruments a person may add a track for in a song, given who they
 * are. The ONE place the `joinMode` rule is written: the add path enforces it
 * and the detail read reports it, so the button and the refusal cannot drift.
 * `canPost` is SEND_MESSAGES on the channel; the author's own right to add is
 * theirs even in a closed song (they still need to be able to post).
 */
export function addableInstruments(input: {
  song: Pick<JamSongRow, "join_mode" | "wanted_instruments" | "author_id">;
  userId: string;
  canPost: boolean;
}): JamInstrument[] {
  if (!input.canPost) {
    return [];
  }
  if (input.song.author_id !== null && input.song.author_id === input.userId) {
    return [...JAM_INSTRUMENTS];
  }
  switch (input.song.join_mode) {
    case "open":
      return [...JAM_INSTRUMENTS];
    case "wanted":
      return sortInstruments(input.song.wanted_instruments);
    default:
      return [];
  }
}

// ---------------------------------------------------------------- uploads

function storageKeyFor(serverId: string, songId: string, contentType: string): string {
  return `jam/${serverId}/${songId}/${randomUUID()}${EXTENSION_BY_CONTENT_TYPE[contentType] ?? ""}`;
}

/** The ceiling for a kind. */
export function jamMaxBytes(kind: JamUploadKind): number {
  switch (kind) {
    case "audio":
      return JAM_AUDIO_MAX_BYTES;
    case "video":
      return JAM_VIDEO_MAX_BYTES;
    default:
      return JAM_COVER_MAX_BYTES;
  }
}

/**
 * Reserve a row and hand back somewhere to put the bytes. The key is generated
 * here and never accepted from the client (a client-chosen key is a
 * client-chosen overwrite), the size and type are signed into the URL, and the
 * ledger row keeps the upload findable until a track claims it or the sweep
 * collects it.
 */
export async function mintJamUpload(input: {
  song: JamSongRow;
  uploaderId: string;
  request: CreateJamUploadRequest;
}): Promise<JamUploadTicket> {
  const { song, uploaderId, request } = input;
  if (!isStorageConfigured()) {
    throw new HttpError(503, JAM_ERRORS.storageOff);
  }
  if (request.byteSize > jamMaxBytes(request.kind)) {
    throw new HttpError(413, JAM_ERRORS.uploadTooLarge);
  }
  if (!(await sharedRateLimit(UPLOAD_BUCKET, uploaderId))) {
    throw new HttpError(429, JAM_ERRORS.rateLimited);
  }
  const key = storageKeyFor(song.server_id, song.id, request.contentType);
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO jam_uploads
       (song_id, channel_id, server_id, uploader_id, kind, storage_key, content_type, byte_size)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      song.id,
      song.channel_id,
      song.server_id,
      uploaderId,
      request.kind,
      key,
      request.contentType,
      request.byteSize,
    ],
  );
  return {
    uploadId: result.rows[0]!.id,
    uploadUrl: presignPut(key, request.contentType, request.byteSize, UPLOAD_URL_TTL_SECONDS),
    expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
  };
}

interface UploadRow {
  id: string;
  kind: JamUploadKind;
  storage_key: string;
  content_type: string;
  byte_size: string;
  claimed_at: Date | null;
}

/** The caller's unclaimed upload of one kind for this song, or null. */
async function findOwnUpload(
  uploadId: string,
  song: JamSongRow,
  uploaderId: string,
  kind: JamUploadKind,
): Promise<UploadRow | null> {
  const result = await getPool().query<UploadRow>(
    `SELECT id, kind, storage_key, content_type, byte_size, claimed_at
       FROM jam_uploads
      WHERE id = $1 AND song_id = $2 AND uploader_id = $3 AND kind = $4
        AND claimed_at IS NULL AND swept_at IS NULL`,
    [uploadId, song.id, uploaderId, kind],
  );
  return result.rows[0] ?? null;
}

/**
 * What the object store says is there: the length, once it passed the checks,
 * or null. A HEAD that fails, a missing object, a body over the ceiling or a
 * stored type that is not the signed one all read as "not verified" (the
 * signed `Content-Length` bounds the first, this catches a store that ignores
 * it). Runs OUTSIDE any transaction: a bucket that blackholes packets must not
 * park a pooled connection for the HEAD's ten-second timeout.
 */
async function verifyUpload(row: UploadRow): Promise<number | null> {
  if (!isStorageConfigured()) {
    return null;
  }
  let head;
  try {
    head = await headObject(row.storage_key);
  } catch (error) {
    console.error(
      `[jam] HEAD failed for ${row.storage_key}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
  if (!head || head.contentLength <= 0 || head.contentLength > jamMaxBytes(row.kind)) {
    return null;
  }
  if (head.contentType !== row.content_type) {
    return null;
  }
  // A HEAD only reports what the uploader CLAIMED. A cover is shown in other
  // people's pages, so its first bytes must also be the picture type that was
  // signed (audio and video are not looked into, like everywhere in the
  // product, `docs/CONTENT_SAFETY.md`).
  if (row.kind === "cover") {
    try {
      const prefix = await getObjectPrefix(row.storage_key, COVER_SNIFF_BYTES);
      const sniffed = prefix ? sniffImage(prefix) : null;
      if (!sniffed || sniffed.type !== row.content_type) {
        return null;
      }
    } catch (error) {
      console.error(
        `[jam] could not read ${row.storage_key}:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }
  return head.contentLength;
}

// ----------------------------------------------------------------- tracks

export interface AddTrackInput {
  song: JamSongRow;
  userId: string;
  /** SEND_MESSAGES on the channel, decided by the caller. */
  canPost: boolean;
  request: AddJamTrackRequest;
}

/**
 * Add a track. Returns `created: false` with the existing track when the
 * audio upload was already claimed by THIS caller's earlier call (a retry).
 *
 * Order, and why:
 *  1. A retry probe: a live track already holding this audio upload.
 *  2. The caller's two upload rows are found and HEAD-verified, off any
 *     transaction.
 *  3. One transaction: the song row is locked, the `joinMode` rule and the
 *     two limits are checked against the locked state, `in_mix` is decided
 *     (first live take of the instrument), the uploads are claimed (an
 *     `UPDATE ... WHERE claimed_at IS NULL` that must touch every row it was
 *     given, or two racing claims cannot both win) and the track inserted.
 */
/** Internal: this request's claim was already made by an earlier request. */
class ClaimAlreadyMade extends Error {}

export async function addJamTrack(
  input: AddTrackInput,
): Promise<{ track: JamTrack; song: JamSongSummary; created: boolean }> {
  const { song, userId, request } = input;

  // The answer for a claim that already made its track: the same track, 200.
  // Asked at every point a retry can find out it is one (below), because the
  // first claim can commit at any moment between two of them.
  const alreadyClaimed = async () => {
    const id = await findClaimedTrack(request.audioUploadId, userId, song.id);
    const existing = id ? await getJamTrack(id) : null;
    return existing
      ? { track: existing, song: await requireSummary(song.id), created: false as const }
      : null;
  };

  const retry = await alreadyClaimed();
  if (retry) {
    return retry;
  }

  // Refused before any HEAD when the caller plainly may not add this
  // instrument, so a closed song costs the bucket nothing.
  assertMayAdd(song, userId, input.canPost, request.instrument);

  const audio = await findOwnUpload(request.audioUploadId, song, userId, "audio");
  const video = request.videoUploadId
    ? await findOwnUpload(request.videoUploadId, song, userId, "video")
    : null;
  if (!audio || (request.videoUploadId && !video)) {
    // Not found because the FIRST claim of this very upload committed between
    // the probe above and this lookup (the lookup only sees unclaimed rows):
    // that is a retry, and its answer is the track, not a 404.
    const raced = await alreadyClaimed();
    if (raced) {
      return raced;
    }
    throw new HttpError(404, JAM_ERRORS.uploadUnknown);
  }
  const [audioBytes, videoBytes] = await Promise.all([
    verifyUpload(audio),
    video ? verifyUpload(video) : Promise.resolve(0),
  ]);
  if (audioBytes === null || videoBytes === null) {
    throw new HttpError(422, JAM_ERRORS.uploadNotVerified);
  }

  const client = await getPool().connect();
  let trackId: string;
  try {
    await client.query("BEGIN");
    const locked = await client.query<JamSongRow>(
      `SELECT ${SONG_COLUMNS} FROM jam_songs s
        WHERE s.id = $1 AND s.deleted_at IS NULL FOR UPDATE`,
      [song.id],
    );
    const current = locked.rows[0];
    if (!current) {
      throw new HttpError(404, JAM_NOT_FOUND);
    }
    // One query for the duplicate probe and the counts, so the lock is held for
    // one round trip, not two. A retry that waited on the song lock behind the
    // claim it duplicates finds that track here: it is answered with it BEFORE
    // the join mode and the limits are looked at, which describe a track that
    // is not there yet (the song may have been closed, or this very track may
    // have been the person's last allowed one, and neither refuses a request
    // that has nothing left to add).
    const counts = await client.query<{
      total: number;
      mine: number;
      same: number;
      duplicate: number;
    }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE author_id = $2)::int AS mine,
              COUNT(*) FILTER (WHERE instrument = $3)::int AS same,
              COUNT(*) FILTER (WHERE audio_upload_id = $4 AND author_id = $2)::int AS duplicate
         FROM jam_tracks WHERE song_id = $1 AND deleted_at IS NULL`,
      [song.id, userId, request.instrument, request.audioUploadId],
    );
    if (counts.rows[0]!.duplicate > 0) {
      throw new ClaimAlreadyMade();
    }
    // The state the insert lands in, not the state the request was routed on:
    // the author may have closed the song while the files uploaded.
    assertMayAdd(current, userId, input.canPost, request.instrument);

    const count = counts.rows[0]!;
    if (count.total >= JAM_MAX_TRACKS_PER_SONG) {
      throw new HttpError(409, JAM_ERRORS.songFull);
    }
    if (count.mine >= JAM_MAX_TRACKS_PER_AUTHOR) {
      throw new HttpError(409, JAM_ERRORS.authorTrackLimit);
    }

    const claimIds = video ? [audio.id, video.id] : [audio.id];
    const claimed = await client.query(
      `UPDATE jam_uploads SET claimed_at = NOW()
        WHERE id = ANY($1::uuid[]) AND claimed_at IS NULL AND swept_at IS NULL
          AND uploader_id = $2`,
      [claimIds, userId],
    );
    if ((claimed.rowCount ?? 0) !== claimIds.length) {
      throw new HttpError(404, JAM_ERRORS.uploadUnknown);
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO jam_tracks
         (song_id, author_id, instrument, label,
          audio_key, audio_content_type, audio_bytes, audio_upload_id,
          video_key, video_content_type, video_bytes,
          offset_ms, trim_start_ms, trim_end_ms, duration_ms, gain, peaks, in_mix)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18)
       RETURNING id`,
      [
        song.id,
        userId,
        request.instrument,
        request.label ?? null,
        audio.storage_key,
        audio.content_type,
        audioBytes,
        audio.id,
        video?.storage_key ?? null,
        video?.content_type ?? null,
        video ? videoBytes : null,
        request.offsetMs,
        request.trimStartMs,
        request.trimEndMs,
        Math.round(request.durationMs),
        request.gain,
        JSON.stringify(request.peaks),
        // The first live take of an instrument is in the mix; later takes wait.
        count.same === 0,
      ],
    );
    trackId = inserted.rows[0]!.id;
    // The MP4 copy for iOS and Safari: a row and a NOTIFY, in this transaction,
    // so a track is never committed without its job (and a rollback has none).
    if (video) {
      await enqueueJamVideoTranscode(client, trackId);
    }
    await client.query(`UPDATE jam_songs SET updated_at = NOW() WHERE id = $1`, [song.id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    // Two requests for one claim raced: the second saw the first's track after
    // waiting on the song lock, hit the unique index, or found the upload
    // already claimed. Either way the first's track is the answer.
    const lostTheRace =
      error instanceof ClaimAlreadyMade ||
      (error as { code?: string }).code === "23505" ||
      (error instanceof HttpError && error.message === JAM_ERRORS.uploadUnknown);
    if (lostTheRace) {
      const raced = await alreadyClaimed();
      if (raced) {
        return raced;
      }
      // The first claim's track was deleted in the meantime: nothing to answer
      // with, and the upload is spent. Never an internal error.
      if (error instanceof ClaimAlreadyMade || (error as { code?: string }).code === "23505") {
        throw new HttpError(404, JAM_ERRORS.uploadUnknown);
      }
    }
    throw error;
  } finally {
    client.release();
  }
  // The track committed. A concurrent delete of the song may already have
  // soft-deleted it by the time it is read back: that is a 404 for this
  // request (the song is gone), never a crash on a null.
  const track = await getJamTrack(trackId);
  if (!track) {
    throw new HttpError(404, JAM_NOT_FOUND);
  }
  return { track, song: await requireSummary(song.id), created: true };
}

/** The `joinMode` rule, as a throw. See `addableInstruments` for the read form. */
function assertMayAdd(
  song: Pick<JamSongRow, "join_mode" | "wanted_instruments" | "author_id">,
  userId: string,
  canPost: boolean,
  instrument: JamInstrument,
): void {
  if (addableInstruments({ song, userId, canPost }).includes(instrument)) {
    return;
  }
  throw refusalFor(song, canPost);
}

/** For a route that does not know the instrument yet (asking for an upload). */
export function assertMayAddAny(
  song: Pick<JamSongRow, "join_mode" | "wanted_instruments" | "author_id">,
  userId: string,
  canPost: boolean,
): void {
  if (addableInstruments({ song, userId, canPost }).length > 0) {
    return;
  }
  throw refusalFor(song, canPost);
}

function refusalFor(song: Pick<JamSongRow, "join_mode">, canPost: boolean): HttpError {
  if (!canPost) {
    return new HttpError(403, "You cannot post in this channel");
  }
  return new HttpError(
    403,
    song.join_mode === "closed" ? JAM_ERRORS.closed : JAM_ERRORS.instrumentNotWanted,
  );
}

async function findClaimedTrack(
  audioUploadId: string,
  userId: string,
  songId: string,
): Promise<string | null> {
  const result = await getPool().query<{ id: string }>(
    `SELECT id FROM jam_tracks
      WHERE audio_upload_id = $1 AND author_id = $2 AND song_id = $3 AND deleted_at IS NULL`,
    [audioUploadId, userId, songId],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Edit a track. Which field may be sent by whom is decided by the route; this
 * validates the trims against the STORED duration (a patch sending one of the
 * two trims is checked against the other as stored) and writes. The song is
 * bumped only when the change can alter the list row (`inMix`, offset, trims).
 */
export async function updateJamTrack(
  track: JamTrackRow,
  patch: UpdateJamTrackRequest,
): Promise<{ track: JamTrack; song: JamSongSummary }> {
  const trimStart = patch.trimStartMs ?? track.trim_start_ms;
  const trimEnd = patch.trimEndMs ?? track.trim_end_ms;
  if (trimStart + trimEnd >= track.duration_ms) {
    throw new HttpError(422, JAM_ERRORS.trimInvalid);
  }
  const result = await getPool().query(
    `UPDATE jam_tracks
        SET label = $2, offset_ms = $3, trim_start_ms = $4, trim_end_ms = $5,
            gain = $6, in_mix = $7
      WHERE id = $1 AND deleted_at IS NULL`,
    [
      track.id,
      patch.label !== undefined ? patch.label : track.label,
      patch.offsetMs ?? track.offset_ms,
      trimStart,
      trimEnd,
      patch.gain ?? track.gain,
      patch.inMix ?? track.in_mix,
    ],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new HttpError(404, JAM_NOT_FOUND);
  }
  await getPool().query(`UPDATE jam_songs SET updated_at = NOW() WHERE id = $1`, [track.song_id]);
  const fresh = await getJamTrack(track.id);
  if (!fresh) {
    throw new HttpError(404, JAM_NOT_FOUND);
  }
  return { track: fresh, song: await requireSummary(track.song_id) };
}

/**
 * Soft-delete a track; its objects go with the sweep a day later.
 *
 * `dropEmptySong`: when this was the song's LAST live track the song goes with
 * it (the caller says so for the song's author and a moderator). An empty song
 * is not something a person meant to keep, and one left behind is a tile that
 * plays nothing. The song row is locked first, in the order `deleteJamSong` and
 * `addJamTrack` lock it, so a track added at this moment either lands before
 * (the song is not empty) or finds the song gone.
 *
 * Returns null when the track was already gone.
 */
export async function deleteJamTrack(
  track: JamTrackRow,
  options: { dropEmptySong?: boolean } = {},
): Promise<{ song: JamSongSummary | null; songDeleted: boolean } | null> {
  const client = await getPool().connect();
  let songDeleted = false;
  try {
    await client.query("BEGIN");
    await client.query(`SELECT 1 FROM jam_songs WHERE id = $1 FOR UPDATE`, [track.song_id]);
    const result = await client.query(
      `UPDATE jam_tracks SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
      [track.id],
    );
    if ((result.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    if (options.dropEmptySong) {
      const left = await client.query(
        `SELECT 1 FROM jam_tracks WHERE song_id = $1 AND deleted_at IS NULL LIMIT 1`,
        [track.song_id],
      );
      if ((left.rowCount ?? 0) === 0) {
        const gone = await client.query(
          `UPDATE jam_songs SET deleted_at = NOW(), updated_at = NOW()
            WHERE id = $1 AND deleted_at IS NULL`,
          [track.song_id],
        );
        songDeleted = (gone.rowCount ?? 0) > 0;
      }
    }
    if (!songDeleted) {
      await client.query(`UPDATE jam_songs SET updated_at = NOW() WHERE id = $1`, [track.song_id]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return { song: songDeleted ? null : await getJamSongSummary(track.song_id), songDeleted };
}

// ------------------------------------------------------------------ votes

/**
 * Vote or take a vote back. Idempotent both ways: voting twice is one vote,
 * unvoting with none is a no-op. Returns the track's count after and whether
 * the count moved (so the route frames only a real change).
 */
export async function setJamVote(
  trackId: string,
  userId: string,
  voted: boolean,
): Promise<{ voteCount: number; changed: boolean }> {
  // One transaction with the track row locked, so the write and the count are
  // one step and two votes on a track are ordered: the count returned is the
  // count after exactly this change, and a failed count rolls the vote back
  // instead of leaving a change nobody was told about.
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT 1 FROM jam_tracks WHERE id = $1 FOR UPDATE`, [trackId]);
    const write = voted
      ? await client.query(
          `INSERT INTO jam_track_votes (track_id, user_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [trackId, userId],
        )
      : await client.query(
          `DELETE FROM jam_track_votes WHERE track_id = $1 AND user_id = $2`,
          [trackId, userId],
        );
    const count = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM jam_track_votes WHERE track_id = $1`,
      [trackId],
    );
    await client.query("COMMIT");
    return { voteCount: count.rows[0]!.count, changed: (write.rowCount ?? 0) > 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------ sweeps

/**
 * The jam's cold path, every minute from `jobs.ts` and safe on two
 * processes (every statement claims its rows):
 *
 *  - an upload nobody claimed within an hour: the object, then the ledger row;
 *  - a deleted track (or a track of a deleted song) a day after: its objects,
 *    then `media_purged_at`.
 *
 * An object delete that fails leaves its row for the next pass, so a bucket
 * outage costs time and never a leaked key. Returns how many it finished.
 */
export async function sweepJamMedia(): Promise<number> {
  if (!isStorageConfigured()) {
    return 0;
  }
  let done = 0;

  // Mark first, delete after: the mark (`swept_at`) and a claim (`claimed_at`)
  // are two writes to the same row, each refused once the other is there, so a
  // track can never be committed against an object this pass is removing. A
  // row marked on an earlier pass whose object delete failed is picked up
  // again (the mark is kept, not renewed).
  const orphans = await getPool().query<{ id: string; storage_key: string }>(
    `UPDATE jam_uploads SET swept_at = COALESCE(swept_at, NOW())
      WHERE id IN (
        SELECT id FROM jam_uploads
         WHERE claimed_at IS NULL AND created_at < NOW() - INTERVAL '${ORPHAN_GRACE}'
         ORDER BY created_at LIMIT ${SWEEP_BATCH}
           FOR UPDATE SKIP LOCKED)
        AND claimed_at IS NULL
      RETURNING id, storage_key`,
  );
  for (const row of orphans.rows) {
    try {
      await deleteObject(row.storage_key);
    } catch (error) {
      console.error(
        `[jam] could not delete ${row.storage_key}:`,
        error instanceof Error ? error.message : error,
      );
      continue;
    }
    await getPool().query(`DELETE FROM jam_uploads WHERE id = $1 AND claimed_at IS NULL`, [row.id]);
    done += 1;
  }

  const purge = await getPool().query<{
    id: string;
    audio_key: string;
    video_key: string | null;
    video_mp4_key: string | null;
  }>(
    `SELECT id, audio_key, video_key, video_mp4_key FROM jam_tracks
      WHERE deleted_at IS NOT NULL AND media_purged_at IS NULL
        AND deleted_at < NOW() - INTERVAL '${PURGE_GRACE}'
      ORDER BY deleted_at LIMIT ${SWEEP_BATCH}`,
  );
  for (const row of purge.rows) {
    try {
      await deleteObject(row.audio_key);
      if (row.video_key) {
        await deleteObject(row.video_key);
      }
      // The worker's MP4 copy, named on the row since before it was PUT.
      if (row.video_mp4_key) {
        await deleteObject(row.video_mp4_key);
      }
    } catch (error) {
      console.error(
        `[jam] could not purge track ${row.id}:`,
        error instanceof Error ? error.message : error,
      );
      continue;
    }
    await getPool().query(`UPDATE jam_tracks SET media_purged_at = NOW() WHERE id = $1`, [row.id]);
    done += 1;
  }

  // Covers: the picture a song stopped showing (replaced, or removed while the
  // immediate delete failed), then the picture of a deleted song after the
  // same day's grace a deleted track's media gets. Object first, ledger row
  // after, so a failed delete leaves the row for the next pass; the row is
  // removed only while no song names it.
  const strayCovers = await getPool().query<{ id: string; storage_key: string }>(
    `SELECT u.id, u.storage_key FROM jam_uploads u
      WHERE u.kind = 'cover' AND u.claimed_at IS NOT NULL
        AND u.claimed_at < NOW() - INTERVAL '${ORPHAN_GRACE}'
        AND NOT EXISTS (SELECT 1 FROM jam_song_covers c WHERE c.upload_id = u.id)
      ORDER BY u.claimed_at LIMIT ${SWEEP_BATCH}`,
  );
  const goneCovers = await getPool().query<{ id: string; storage_key: string }>(
    `SELECT u.id, u.storage_key
       FROM jam_song_covers c
       JOIN jam_songs s ON s.id = c.song_id
       JOIN jam_uploads u ON u.id = c.upload_id
      WHERE s.deleted_at IS NOT NULL AND s.deleted_at < NOW() - INTERVAL '${PURGE_GRACE}'
      ORDER BY s.deleted_at LIMIT ${SWEEP_BATCH}`,
  );
  for (const row of [...strayCovers.rows, ...goneCovers.rows]) {
    try {
      await deleteObject(row.storage_key);
    } catch (error) {
      console.error(
        `[jam] could not delete cover ${row.storage_key}:`,
        error instanceof Error ? error.message : error,
      );
      continue;
    }
    // A deleted song's cover row goes with its ledger row (ON DELETE CASCADE).
    await getPool().query(`DELETE FROM jam_uploads WHERE id = $1 AND kind = 'cover'`, [row.id]);
    done += 1;
  }
  return done;
}

/**
 * Songs nobody put a track in for a day, deleted. Rows only (a song with no
 * track owns no object; an upload nobody claimed is the pass above's), and safe
 * on two processes: the rows are claimed with `FOR UPDATE SKIP LOCKED`, the
 * same lock `addJamTrack` takes, so a track added at this moment is either
 * committed first (the song is no longer empty and `updated_at` is fresh, which
 * the claim re-checks) or finds the song deleted and is answered 404. Runs
 * whatever the flag and the storage say, like the media sweep.
 */
export async function sweepEmptyJamSongs(): Promise<number> {
  const result = await getPool().query(
    `UPDATE jam_songs SET deleted_at = NOW()
      WHERE id IN (
        SELECT s.id FROM jam_songs s
         WHERE s.deleted_at IS NULL
           AND s.updated_at < NOW() - INTERVAL '${EMPTY_SONG_GRACE}'
           AND NOT EXISTS (SELECT 1 FROM jam_tracks t WHERE t.song_id = s.id AND t.deleted_at IS NULL)
         ORDER BY s.updated_at LIMIT ${SWEEP_BATCH}
           FOR UPDATE SKIP LOCKED)
        AND deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM jam_tracks t WHERE t.song_id = jam_songs.id AND t.deleted_at IS NULL)`,
  );
  return result.rowCount ?? 0;
}

/** Content types, exported for the doc and the tests. */
export const JAM_ALLOWED_TYPES = {
  audio: JAM_AUDIO_CONTENT_TYPES,
  video: JAM_VIDEO_CONTENT_TYPES,
  cover: JAM_COVER_CONTENT_TYPES,
} as const;
