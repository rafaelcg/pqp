import {
  formatUserTag,
  JAM_INSTRUMENTS,
  JAM_MAX_TRACKS_PER_AUTHOR,
  JAM_MAX_TRACKS_PER_SONG,
  JAM_PUBLIC_ERRORS,
  JAM_PUBLIC_PAGE_SIZE,
  type AdminBlockJamPublisherRequest,
  type AdminJamPublicQueue,
  type AdminJamPublicSong,
  type AdminJamPublicTrack,
  type AdminRemoveJamPartRequest,
  type AdminReviewJamRequest,
  type AdminUnpublishJamRequest,
  type CreatePublicJamRequest,
  type JamInstrument,
  type JamPublication,
  type JamPublicationPart,
  type JamPublicationStatus,
  type JamPublicConsent,
  type JamPublicConsentRequest,
  type JamPublicInboxItem,
  type JamPublicLikeResponse,
  type JamPublicMeConfig,
  type JamPublicReportResponse,
  type JamPublicSongForViewer,
  type JamPublicVideoScan,
  type JamPublicReview,
  type JamSongSummary,
  type PublicJamListQuery,
  type PublicJamListResponse,
  type PublicJamPart,
  type PublicJamSong,
  type PublicJamSongDetail,
  type PublicJamTrack,
  type ReportPublicJamRequest,
} from "@pqp/shared";
import type { PoolClient } from "pg";
import { getPool } from "../db.js";
import { sharedRateLimit } from "../lib/cluster-rate-limit.js";
import { HttpError } from "../lib/http.js";
import { jamPublicEnabled, jamPublicLimits } from "../lib/jam-public-config.js";
import { isStorageConfigured } from "../lib/s3.js";
import { isCommunitiesEnabled } from "./communities.js";
import { isContentScanConfigured } from "./content-scan.js";
import {
  addableInstruments,
  createJamSong,
  deleteJamSong,
  getJamSongRow,
  getJamSongSummary,
  getJamTrack,
  JAM_NOT_FOUND,
  reducePeaks,
  type JamSongRow,
} from "./jam.js";
import { jamPublicMediaExpiresAt, jamPublicMediaUrl } from "./jam-public-media.js";
import { notifyJamPublic } from "./jam-public-notify.js";
import {
  LISTED_SONG_SQL,
  PUBLIC_COVER_KEY_SQL,
  PUBLIC_SONG_SQL,
  publicTrackSql,
  publicVideoSql,
} from "./jam-public-sql.js";
import { assertUnderFloodCap, ReportFloodError } from "./reports.js";

/**
 * PUBLIC JAMS: the service. The contract and every rule are in
 * `packages/shared/src/jam-public.ts`; the operator's page is
 * `docs/JAM_PUBLIC.md`. What "public" means is written once, as SQL, in
 * `jam-public-sql.ts`; this file only ever applies it.
 *
 * The rules from CLAUDE.md that shaped it:
 *  - Nothing between BEGIN and COMMIT touches the network (no scan, no HEAD
 *    here at all: scanning is the worker's, `jam-public-scan.ts`).
 *  - Nothing is cached per process: every public read asks Postgres, so an
 *    unpublish on one API container is out of the next read on the other
 *    (production runs two). The only per-process state is the counters below
 *    and the play counter's dedupe memo, whose correctness lives in a primary
 *    key (`jam-public-plays.ts`).
 *  - Fail closed: a track with no `jam_public_tracks` row, a person with no
 *    consent, a cover with no passing verdict, a video whose verdict names
 *    another object: not public.
 */

type Db = Pick<PoolClient, "query">;

// ------------------------------------------------------------- counters

const counters = {
  published: 0,
  standaloneCreated: 0,
  unpublished: 0,
  takenDown: 0,
  autoHidden: 0,
  reportsFiled: 0,
  likes: 0,
  takesRecorded: 0,
  takesQueuedForReview: 0,
  /** Outside takes auto-accept put in the mix (this process). */
  takesAutoAdmitted: 0,
  songsQueuedForReview: 0,
  rateLimited: { songs: 0, takes: 0, likes: 0, reports: 0 },
  /** Refusals of the public routes' address buckets (`jam-public-routes.ts`). */
  addressRefused: { config: 0, list: 0, song: 0, play: 0 },
};

export function noteJamPublicAddressRefusal(kind: keyof typeof counters.addressRefused): void {
  counters.addressRefused[kind] += 1;
}

export function jamPublicCounters(): typeof counters {
  return {
    ...counters,
    rateLimited: { ...counters.rateLimited },
    addressRefused: { ...counters.addressRefused },
  };
}

export function resetJamPublicCountersForTests(): void {
  for (const key of Object.keys(counters) as Array<keyof typeof counters>) {
    if (key === "rateLimited") {
      counters.rateLimited = { songs: 0, takes: 0, likes: 0, reports: 0 };
    } else if (key === "addressRefused") {
      counters.addressRefused = { config: 0, list: 0, song: 0, play: 0 };
    } else {
      (counters as Record<string, unknown>)[key] = 0;
    }
  }
}

function refuseRate(kind: keyof typeof counters.rateLimited): HttpError {
  counters.rateLimited[kind] += 1;
  return new HttpError(429, JAM_PUBLIC_ERRORS.rateLimited);
}

// ------------------------------------------------------------ the gates

/** 403 `jam_public_off` unless the flag is on. */
export function requireJamPublicOn(): void {
  if (!jamPublicEnabled()) {
    throw new HttpError(403, JAM_PUBLIC_ERRORS.off);
  }
}

interface Standing {
  /** Blocked by an operator, account being deleted, or banned from the origin server. */
  blocked: boolean;
  /** Younger than `JAM_PUBLIC_MIN_ACCOUNT_AGE_HOURS`. */
  young: boolean;
  /** Has had a public jam approved by an operator. */
  approved: boolean;
}

async function standingOf(
  userId: string,
  originServerId: string | null,
  db: Db = getPool(),
): Promise<Standing> {
  const result = await db.query<{
    young: boolean;
    deleting: boolean;
    blocked: boolean;
    banned: boolean;
    approved: boolean;
  }>(
    `SELECT u.created_at > NOW() - make_interval(hours => $3) AS young,
            u.deletion_started_at IS NOT NULL AS deleting,
            EXISTS (SELECT 1 FROM jam_public_blocks b WHERE b.user_id = u.id) AS blocked,
            ($2::uuid IS NOT NULL AND EXISTS (
               SELECT 1 FROM server_bans sb WHERE sb.server_id = $2::uuid AND sb.user_id = u.id)) AS banned,
            EXISTS (SELECT 1 FROM jam_public_songs p
                     WHERE p.published_by = u.id AND p.review_state = 'approved') AS approved
       FROM users u WHERE u.id = $1`,
    [userId, originServerId, jamPublicLimits.minAccountAgeHours()],
  );
  const row = result.rows[0];
  if (!row) {
    return { blocked: true, young: true, approved: false };
  }
  return {
    blocked: row.blocked || row.deleting || row.banned,
    young: row.young,
    approved: row.approved,
  };
}

/** `GET /api/jam-public/config`. */
export async function jamPublicConfigFor(userId: string): Promise<JamPublicMeConfig> {
  const enabled = jamPublicEnabled();
  const standing = await standingOf(userId, null);
  return {
    enabled,
    publishing: standing.blocked ? "blocked" : standing.young ? "review" : "open",
    uploads: isStorageConfigured(),
  };
}

/**
 * May this person record a part that can go public on this song (a block, an
 * account being deleted, a ban from the song's server all say no)?
 */
export async function mayRecordPublicly(userId: string, song: Pick<JamSongRow, "server_id">): Promise<boolean> {
  return !(await standingOf(userId, song.server_id)).blocked;
}

// --------------------------------------------------------- publication rows

interface PublicationRow {
  song_id: string;
  published_at: Date;
  first_published_at: Date;
  published_by: string | null;
  show_origin: boolean;
  auto_accept_since: Date | null;
  review_state: JamPublicReview;
  reviewed_at: Date | null;
  hidden_at: Date | null;
  unpublished_at: Date | null;
  unpublish_reason: string | null;
  removed_at: Date | null;
  removed_reason: string | null;
  plays_count: string;
  likes_count: number;
}

async function getPublicationRow(songId: string, db: Db = getPool()): Promise<PublicationRow | null> {
  const result = await db.query<PublicationRow>(
    `SELECT * FROM jam_public_songs WHERE song_id = $1`,
    [songId],
  );
  return result.rows[0] ?? null;
}

/** The one place a status is derived from the columns. Order matters: worst first. */
export function publicationStatus(
  row: Pick<PublicationRow, "removed_at" | "unpublished_at" | "review_state" | "hidden_at">,
): JamPublicationStatus {
  if (row.removed_at) return "removed";
  if (row.unpublished_at) return "unpublished";
  if (row.review_state === "pending") return "review";
  if (row.hidden_at) return "hidden";
  return "live";
}

/** Published and not taken down by anybody: a song new parts become public on. */
function isOpenPublication(row: PublicationRow | null): row is PublicationRow {
  return row !== null && row.removed_at === null && row.unpublished_at === null;
}

async function audit(
  db: Db,
  entry: {
    action: string;
    songId?: string | null;
    trackId?: string | null;
    userId?: string | null;
    actor: JamPublicActor;
    reason?: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO jam_public_audit (action, song_id, track_id, user_id, actor_id, actor_kind, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.action,
      entry.songId ?? null,
      entry.trackId ?? null,
      entry.userId ?? null,
      "userId" in entry.actor ? entry.actor.userId : null,
      entry.actor.kind,
      entry.reason ?? null,
    ],
  );
}

/** Who did it, for the audit. `dashboard` is the machine token (no account). */
export type JamPublicActor =
  | { kind: "starter"; userId: string }
  | { kind: "moderator"; userId: string }
  | { kind: "operator"; userId: string }
  | { kind: "dashboard" }
  | { kind: "system" };

async function withTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const value = await run(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------- publish

/** 429 when this person already made `JAM_PUBLIC_SONGS_PER_DAY` songs public in 24 hours. */
async function assertUnderSongLimit(userId: string): Promise<void> {
  const result = await getPool().query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM jam_public_songs
      WHERE published_by = $1 AND first_published_at > NOW() - INTERVAL '24 hours'`,
    [userId],
  );
  if ((result.rows[0]?.count ?? 0) >= jamPublicLimits.songsPerDay()) {
    throw refuseRate("songs");
  }
}

/** 429 when this person already recorded `JAM_PUBLIC_TAKES_PER_DAY` takes on public songs in 24 hours. */
export async function assertUnderTakeLimit(userId: string): Promise<void> {
  const result = await getPool().query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM jam_public_tracks
      WHERE author_id = $1 AND origin = 'recorded' AND created_at > NOW() - INTERVAL '24 hours'`,
    [userId],
  );
  if ((result.rows[0]?.count ?? 0) >= jamPublicLimits.takesPerDay()) {
    throw refuseRate("takes");
  }
}

/** The status a new video's scan row starts in. */
function initialVideoStatus(): JamPublicVideoScan {
  return isContentScanConfigured() ? "pending" : "unscanned";
}

/**
 * Publish, or republish, a song. The caller decided the caller is the starter
 * and the flag is on. Writes the publication row, the starter's own `yes`, a
 * `jam_public_tracks` row for every live track (their authors' consent is
 * still asked), and queues the cover for the scanner, in one transaction; then
 * asks everybody else with a part in it.
 */
async function publishInternal(input: {
  song: JamSongRow;
  userId: string;
  showOrigin?: boolean;
  checkLimit: boolean;
}): Promise<void> {
  const { song, userId } = input;
  const standing = await standingOf(userId, song.server_id);
  if (standing.blocked) {
    throw new HttpError(403, JAM_PUBLIC_ERRORS.blocked);
  }
  const existing = await getPublicationRow(song.id);
  if (existing?.removed_at) {
    throw new HttpError(409, JAM_PUBLIC_ERRORS.removed);
  }
  if (!existing && input.checkLimit) {
    await assertUnderSongLimit(userId);
  }
  // A new account's FIRST public jam waits for an operator. A republish keeps
  // whatever review the song already had.
  const review: JamPublicReview = existing
    ? existing.review_state
    : standing.young && !standing.approved
      ? "pending"
      : "none";
  const videoStatus = initialVideoStatus();
  const coverStatus = isContentScanConfigured() ? "pending" : "unscanned";

  await withTransaction(async (client) => {
    const locked = await client.query(
      `SELECT 1 FROM jam_songs WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [song.id],
    );
    if ((locked.rowCount ?? 0) === 0) {
      throw new HttpError(404, JAM_NOT_FOUND);
    }
    const upserted = await client.query(
      `INSERT INTO jam_public_songs (song_id, published_by, show_origin, review_state)
       VALUES ($1, $2, COALESCE($3, TRUE), $4)
       ON CONFLICT (song_id) DO UPDATE
         SET unpublished_at = NULL,
             unpublish_reason = NULL,
             published_at = CASE WHEN jam_public_songs.unpublished_at IS NULL
                                  THEN jam_public_songs.published_at ELSE NOW() END,
             show_origin = COALESCE($3, jam_public_songs.show_origin)
         WHERE jam_public_songs.removed_at IS NULL`,
      [song.id, userId, input.showOrigin ?? null, review],
    );
    if ((upserted.rowCount ?? 0) === 0) {
      // Removed by an operator between the read above and this write.
      throw new HttpError(409, JAM_PUBLIC_ERRORS.removed);
    }
    await client.query(
      `INSERT INTO jam_public_consents (song_id, user_id, choice) VALUES ($1, $2, 'yes')
       ON CONFLICT (song_id, user_id) DO NOTHING`,
      [song.id, userId],
    );
    await client.query(
      `INSERT INTO jam_public_tracks
         (track_id, song_id, author_id, origin, video_scan_status, video_scan_key)
       SELECT t.id, t.song_id, t.author_id, 'published',
              CASE WHEN t.video_key IS NULL THEN 'none' ELSE $2 END, t.video_key
         FROM jam_tracks t
        WHERE t.song_id = $1 AND t.deleted_at IS NULL
       ON CONFLICT (track_id) DO NOTHING`,
      [song.id, videoStatus],
    );
    await client.query(
      `INSERT INTO jam_public_cover_scans (upload_id, song_id, status)
       SELECT sc.upload_id, sc.song_id, $2 FROM jam_song_covers sc WHERE sc.song_id = $1
       ON CONFLICT (upload_id) DO NOTHING`,
      [song.id, coverStatus],
    );
    await audit(client, {
      action: existing ? "republish" : "publish",
      songId: song.id,
      userId,
      actor: { kind: "starter", userId },
    });
  });

  if (!existing) {
    counters.published += 1;
    if (review === "pending") {
      counters.songsQueuedForReview += 1;
    }
  }
  // Everybody with a part and no answer is asked. A notice is a nudge; the
  // durable list is `GET /api/jam-public/consents`.
  const unanswered = await getPool().query<{ author_id: string }>(
    `SELECT DISTINCT t.author_id FROM jam_tracks t
      WHERE t.song_id = $1 AND t.deleted_at IS NULL AND t.author_id <> $2
        AND NOT EXISTS (SELECT 1 FROM jam_public_consents c
                         WHERE c.song_id = t.song_id AND c.user_id = t.author_id)`,
    [song.id, userId],
  );
  for (const row of unanswered.rows) {
    notifyJamPublic(row.author_id, { kind: "consent", songId: song.id, title: song.title });
  }
}

/** `PUT /api/jam-songs/:songId/public`. The route checked the starter and the flag. */
export async function publishJamSong(input: {
  song: JamSongRow;
  userId: string;
  showOrigin?: boolean;
}): Promise<JamPublication> {
  await publishInternal({ ...input, checkLimit: true });
  return requirePublication(input.song.id);
}

/**
 * `POST /api/jam-public/songs`: a standalone public jam. A nonce retry answers
 * the song it made (and finishes its publication if the first call died in
 * between) and spends nothing.
 */
export async function createPublicJam(input: {
  userId: string;
  request: CreatePublicJamRequest;
}): Promise<{ song: JamSongSummary; publication: JamPublication; created: boolean }> {
  const { userId, request } = input;
  const standing = await standingOf(userId, null);
  if (standing.blocked) {
    throw new HttpError(403, JAM_PUBLIC_ERRORS.blocked);
  }
  // Refused BEFORE the song exists, so a refusal leaves nothing behind. A
  // retry of a create that already made its song is not a new publish.
  if (!request.nonce || !(await standaloneForNonce(userId, request.nonce))) {
    await assertUnderSongLimit(userId);
  }
  const result = await createJamSong({ channelId: null, serverId: null, authorId: userId, request });
  const row = await getJamSongRow(result.song.id);
  if (!row) {
    throw new HttpError(404, JAM_NOT_FOUND);
  }
  if (!(await getPublicationRow(row.id))) {
    await publishInternal({ song: row, userId, checkLimit: false });
  }
  if (result.created) {
    counters.standaloneCreated += 1;
  }
  return {
    song: result.song,
    publication: await requirePublication(row.id),
    created: result.created,
  };
}

async function standaloneForNonce(userId: string, nonce: string): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM jam_songs
      WHERE channel_id IS NULL AND author_id = $1 AND client_nonce = $2 AND deleted_at IS NULL`,
    [userId, nonce],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Unpublish: the starter, or a moderator of the origin channel (the route
 * decided which). Allowed with the flag off. A moderator's reason is shown to
 * the starter and the starter is told.
 */
export async function unpublishJamSong(input: {
  song: JamSongRow;
  actor: JamPublicActor;
  reason?: string | null;
}): Promise<JamPublication | null> {
  const { song, actor } = input;
  const reason = input.reason?.trim() || null;
  const changed = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE jam_public_songs SET unpublished_at = NOW(), unpublish_reason = $2
        WHERE song_id = $1 AND unpublished_at IS NULL`,
      [song.id, reason],
    );
    if ((result.rowCount ?? 0) > 0) {
      await audit(client, { action: "unpublish", songId: song.id, actor, reason });
      return true;
    }
    return false;
  });
  if (changed) {
    counters.unpublished += 1;
    if (actor.kind === "moderator" && song.author_id && song.author_id !== actor.userId) {
      notifyJamPublic(song.author_id, {
        kind: "unpublished",
        songId: song.id,
        title: song.title,
        reason,
      });
    }
  }
  return getPublication(song.id);
}

/**
 * `PATCH /api/jam-songs/:songId/public`: show or hide the origin server, turn
 * auto-accept of outside takes on or off. The route checked the starter and
 * the flag. Each field is optional and a field that does not change anything
 * writes nothing (turning auto-accept on while it is on keeps the moment it
 * went on, which is what decides which takes it covers).
 */
export async function updateJamPublicSettings(input: {
  song: JamSongRow;
  userId: string;
  showOrigin?: boolean;
  autoAcceptOutside?: boolean;
}): Promise<JamPublication> {
  const { song, userId } = input;
  await withTransaction(async (client) => {
    const current = await client.query<{ auto_accept_since: Date | null }>(
      `SELECT auto_accept_since FROM jam_public_songs WHERE song_id = $1 FOR UPDATE`,
      [song.id],
    );
    if ((current.rowCount ?? 0) === 0) {
      throw new HttpError(404, JAM_NOT_FOUND);
    }
    const wasOn = current.rows[0]!.auto_accept_since !== null;
    const flips = input.autoAcceptOutside !== undefined && input.autoAcceptOutside !== wasOn;
    await client.query(
      `UPDATE jam_public_songs
          SET show_origin = COALESCE($2::boolean, show_origin),
              auto_accept_since = CASE WHEN $3::boolean THEN NOW()
                                       WHEN $4::boolean THEN NULL
                                       ELSE auto_accept_since END
        WHERE song_id = $1`,
      [song.id, input.showOrigin ?? null, flips && input.autoAcceptOutside === true, flips && input.autoAcceptOutside === false],
    );
    if (flips) {
      await audit(client, {
        action: input.autoAcceptOutside ? "auto-accept-on" : "auto-accept-off",
        songId: song.id,
        userId,
        actor: { kind: "starter", userId },
      });
    }
  });
  return requirePublication(song.id);
}

// ---------------------------------------------------------------- consent

/**
 * A person's answer for every part they have in a song. `no` is a removal and
 * works with the flag off; `yes` and `audio_only` need it on. Only somebody
 * with a live part in the song (or its starter) may answer.
 */
export async function setJamPublicConsent(input: {
  song: JamSongRow;
  userId: string;
  choice: JamPublicConsent;
}): Promise<JamPublication | null> {
  const { song, userId, choice } = input;
  if (choice !== "no") {
    requireJamPublicOn();
  }
  const part = await getPool().query(
    `SELECT 1 FROM jam_tracks WHERE song_id = $1 AND author_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [song.id, userId],
  );
  if ((part.rowCount ?? 0) === 0 && song.author_id !== userId) {
    throw new HttpError(403, JAM_PUBLIC_ERRORS.noPart);
  }
  await upsertConsent(getPool(), song.id, userId, choice);
  if (choice !== "no") {
    // A take held only by its author's missing yes can go in now.
    await admitAutoAcceptedTakes({ songId: song.id });
  }
  return getPublication(song.id);
}

async function upsertConsent(db: Db, songId: string, userId: string, choice: JamPublicConsent): Promise<void> {
  await db.query(
    `INSERT INTO jam_public_consents (song_id, user_id, choice) VALUES ($1, $2, $3)
     ON CONFLICT (song_id, user_id) DO UPDATE SET choice = EXCLUDED.choice, decided_at = NOW()`,
    [songId, userId, choice],
  );
}

// ---------------------------------------------------------- a new take

/**
 * After a track was added to a song: if the song is published, the track gets
 * its public row (review for a new account, the video queued for the scanner),
 * the recorder's `publicConsent` is stored, and an outside take is announced
 * to the starter. A failure here leaves the track private (no row, fail
 * closed), never public: the add already answered, so it is logged, not thrown.
 */
export async function noteJamTrackAdded(input: {
  song: JamSongRow;
  trackId: string;
  userId: string;
  outside: boolean;
  publicConsent?: "yes" | "audio_only";
}): Promise<void> {
  const { song, trackId, userId } = input;
  try {
    const publication = await getPublicationRow(song.id);
    if (!isOpenPublication(publication)) {
      return;
    }
    const standing = await standingOf(userId, song.server_id);
    const review: JamPublicReview = standing.young ? "pending" : "none";
    const inserted = await withTransaction(async (client) => {
      // The daily take limit, enforced where the take becomes public: one
      // person's takes are counted under a lock of their own, so two adds at
      // once cannot both be the last allowed one. The route's earlier check is
      // the friendly 429; a take that gets past it in a race is recorded as
      // removed from the public version (it stays in its song), never public.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `jam-public-take:${userId}`,
      ]);
      const today = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM jam_public_tracks
          WHERE author_id = $1 AND origin = 'recorded' AND created_at > NOW() - INTERVAL '24 hours'
            AND removed_at IS NULL`,
        [userId],
      );
      const overLimit = (today.rows[0]?.count ?? 0) >= jamPublicLimits.takesPerDay();
      const result = await client.query(
        `INSERT INTO jam_public_tracks
           (track_id, song_id, author_id, origin, outside, review_state, video_scan_status, video_scan_key,
            removed_at, removed_reason)
         SELECT t.id, t.song_id, t.author_id, 'recorded', $2, $3,
                CASE WHEN t.video_key IS NULL THEN 'none' ELSE $4 END, t.video_key,
                CASE WHEN $5::boolean THEN NOW() END,
                CASE WHEN $5::boolean THEN 'daily take limit' END
           FROM jam_tracks t WHERE t.id = $1
         ON CONFLICT (track_id) DO NOTHING`,
        [trackId, input.outside, review, initialVideoStatus(), overLimit],
      );
      if (input.publicConsent) {
        await upsertConsent(client, song.id, userId, input.publicConsent);
      }
      if (overLimit && (result.rowCount ?? 0) > 0) {
        counters.rateLimited.takes += 1;
      }
      return (result.rowCount ?? 0) > 0;
    });
    // A retry that found the row already written counts and tells nothing again.
    if (!inserted) {
      return;
    }
    counters.takesRecorded += 1;
    if (review === "pending") {
      counters.takesQueuedForReview += 1;
    }
    if (input.outside && song.author_id && song.author_id !== userId) {
      // With auto-accept on, a take nothing holds is in the mix by the time
      // this returns and the starter is told THAT (the admission's own
      // notice); a held one is a request like any other until the hold clears.
      // The row read above says whether the switch is on: off, nothing is scanned.
      const admitted = publication.auto_accept_since
        ? await admitAutoAcceptedTakes({ songId: song.id })
        : [];
      if (!admitted.includes(trackId)) {
        notifyJamPublic(song.author_id, {
          kind: "take",
          songId: song.id,
          title: song.title,
          trackId,
        });
      }
    }
  } catch (error) {
    console.error(
      `[jam-public] could not record the public state of track ${trackId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

// ----------------------------------------------------------- auto-accept

/**
 * What the server does to the channel's open clients after it puts a take in
 * the mix. Registered by `api/jam-routes.ts` (the frame is a chat-socket
 * concern, and this service does not import the socket layer). On a process
 * with no socket layer (the worker) nothing is registered and nobody is told
 * live: the starter's next read has the change, and so do the channel's.
 */
/** Admission frames in flight at once. */
export const ANNOUNCE_CONCURRENCY = 4;
type AdmissionAnnouncer = (channelId: string, songId: string, trackId: string) => Promise<void>;
let admissionAnnouncer: AdmissionAnnouncer | null = null;

/** Tell every admitted take, at most `ANNOUNCE_CONCURRENCY` at a time. Never throws. */
export async function announceInPool(
  items: ReadonlyArray<{ channelId: string; songId: string; trackId: string }>,
  announce: AdmissionAnnouncer,
  concurrency: number = ANNOUNCE_CONCURRENCY,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await announce(item.channelId, item.songId, item.trackId).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}
export function setJamTakeAdmissionAnnouncer(fn: AdmissionAnnouncer | null): void {
  admissionAnnouncer = fn;
}

/**
 * AUTO-ACCEPT (packages/shared/src/jam-public.ts, AUTO-ACCEPT). Puts into the
 * mix every outside take whose song has the switch on and that nothing of the
 * platform still holds, and returns their track ids. Idempotent and safe on two
 * processes at once: ONE statement claims the rows (`FOR UPDATE SKIP LOCKED`,
 * `auto_admitted_at` set in the same statement that sets `in_mix`), so a take is
 * admitted once, by one process, and never again after the starter or an
 * operator changed their mind about it.
 *
 * The checks are the reads' own (`publicTrackSql` without "in the mix",
 * `PUBLIC_SONG_SQL`) plus the two that only matter before a take is admitted:
 * its video, when it has one, passed the frame scan, and the song's current
 * picture was not flagged or rejected. Whatever holds a take (a new account's
 * review, the scanner, an operator's removal, the daily take limit, a hidden or
 * unpublished song) leaves it waiting for the starter, and this runs again when
 * the hold clears: after an operator's approval, after a passing scan, and from
 * the minute sweep (the backstop for everything else, a consent turned back to
 * yes, a block lifted, a restart in the middle of any of it).
 *
 * Never throws: the caller already answered. With the flag off nothing is
 * admitted (nothing is public).
 */
export async function admitAutoAcceptedTakes(scope: { songId?: string } = {}): Promise<string[]> {
  if (!jamPublicEnabled()) {
    return [];
  }
  try {
    const result = await getPool().query<{
      track_id: string;
      song_id: string;
      channel_id: string | null;
      author_id: string | null;
      title: string;
    }>(
      `WITH due AS (
         SELECT pt.track_id
           FROM jam_public_tracks pt
           JOIN jam_tracks t ON t.id = pt.track_id
           JOIN jam_public_songs p ON p.song_id = pt.song_id
           JOIN jam_songs s ON s.id = pt.song_id
           JOIN users su ON su.id = s.author_id
          WHERE ($1::uuid IS NULL OR pt.song_id = $1::uuid)
            AND p.auto_accept_since IS NOT NULL
            AND t.created_at >= p.auto_accept_since
            AND pt.outside
            AND pt.auto_admitted_at IS NULL
            AND pt.removed_at IS NULL
            AND pt.review_state IN ('none', 'approved')
            AND pt.video_scan_status IN ('none', 'passed')
            AND NOT t.in_mix
            AND ${PUBLIC_SONG_SQL}
            AND ${publicTrackSql("t", false)}
            AND NOT EXISTS (
              SELECT 1 FROM jam_song_covers sc
                JOIN jam_public_cover_scans cs ON cs.upload_id = sc.upload_id
               WHERE sc.song_id = s.id AND cs.status IN ('flagged', 'rejected'))
          ORDER BY t.created_at, t.id
          LIMIT 200
          FOR UPDATE OF pt SKIP LOCKED
          FOR SHARE OF p
       ),
       claimed AS (
         UPDATE jam_public_tracks pt SET auto_admitted_at = NOW()
           FROM due
          WHERE pt.track_id = due.track_id AND pt.auto_admitted_at IS NULL
          RETURNING pt.track_id, pt.song_id
       ),
       mixed AS (
         UPDATE jam_tracks t SET in_mix = TRUE
           FROM claimed
          WHERE t.id = claimed.track_id AND t.deleted_at IS NULL AND NOT t.in_mix
          RETURNING t.id AS track_id, t.song_id
       ),
       bumped AS (
         UPDATE jam_songs SET updated_at = NOW()
          WHERE id IN (SELECT song_id FROM mixed)
          RETURNING id
       ),
       logged AS (
         INSERT INTO jam_public_audit (action, song_id, track_id, actor_kind)
         SELECT 'auto-admit', m.song_id, m.track_id, 'system' FROM mixed m
         RETURNING id
       )
       SELECT m.track_id, m.song_id, s.channel_id, s.author_id, s.title
         FROM mixed m JOIN jam_songs s ON s.id = m.song_id`,
      [scope.songId ?? null],
    );
    for (const row of result.rows) {
      counters.takesAutoAdmitted += 1;
      if (row.author_id) {
        notifyJamPublic(row.author_id, {
          kind: "take",
          songId: row.song_id,
          title: row.title,
          trackId: row.track_id,
          admitted: true,
        });
      }
    }
    const announce = admissionAnnouncer;
    if (announce) {
      // Every admitted take is told, through a small pool: a sweep can admit
      // up to 200 takes and each frame is two reads, so never all at once and
      // never dropped. Best effort (the reads are the truth).
      const channelRows = result.rows.filter((row) => row.channel_id !== null);
      void announceInPool(
        channelRows.map((row) => ({ channelId: row.channel_id!, songId: row.song_id, trackId: row.track_id })),
        announce,
      );
    }
    return result.rows.map((row) => row.track_id);
  } catch (error) {
    console.error(
      "[jam-public] auto-accept failed:",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/**
 * The starter is putting a track in or out of the mix by hand. That is their
 * answer for this take, so auto-accept never acts on it afterwards (without
 * this a take the starter took out of the mix would be put back by the next
 * sweep). It runs on the SAME transaction as the mix change
 * (`updateJamTrack`'s `alsoInTransaction`): both commit or neither does, so a
 * transient failure can never leave a take the starter decided about eligible
 * for auto-admission. It takes the take's row lock first, so an admission in
 * flight either finished before (the starter's change then wins, it is later)
 * or skips the take.
 */
export async function noteStarterMixDecision(trackId: string, db: Db = getPool()): Promise<void> {
  await db.query(
    `UPDATE jam_public_tracks SET auto_admitted_at = COALESCE(auto_admitted_at, NOW())
      WHERE track_id = $1 AND outside AND auto_admitted_at IS NULL`,
    [trackId],
  );
}

/**
 * After a cover was set: a published song's new picture is queued for the
 * scanner (it is not public until it passes). Logged, never thrown, like the
 * take above: the cover write already answered.
 */
export async function noteJamCoverChanged(songId: string): Promise<void> {
  try {
    if (!(await isJamSongPublished(songId))) {
      return;
    }
    await getPool().query(
      `INSERT INTO jam_public_cover_scans (upload_id, song_id, status)
       SELECT sc.upload_id, sc.song_id, $2 FROM jam_song_covers sc WHERE sc.song_id = $1
       ON CONFLICT (upload_id) DO NOTHING`,
      [songId, isContentScanConfigured() ? "pending" : "unscanned"],
    );
  } catch (error) {
    console.error(
      `[jam-public] could not queue the cover of ${songId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** Whether a song has an open publication (published, not unpublished, not removed). */
export async function isJamSongPublished(songId: string): Promise<boolean> {
  return isOpenPublication(await getPublicationRow(songId));
}

// ------------------------------------------------------------ access

/** The song is in the public list right now (flag aside). */
export async function isJamSongListed(songId: string, db: Db = getPool()): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM jam_public_songs p
       JOIN jam_songs s ON s.id = p.song_id
       JOIN users su ON su.id = s.author_id
      WHERE p.song_id = $1 AND ${LISTED_SONG_SQL}`,
    [songId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Whether a caller who is NOT a member of the song's channel may reach it
 * through the private song routes ("public access", jam-public.ts):
 *
 *  - a standalone song: its starter always (their own song, flag or not);
 *    anybody else while the flag is on and it is listed, or while they have a
 *    live part in it;
 *  - a channel song: only while the flag is on and it is listed. A non-member
 *    whose take is in a song that stopped being listed loses access to the
 *    channel's song (it is the channel's), and keeps the right to delete their
 *    own track (`jam-routes.ts`).
 */
export async function hasJamPublicAccess(
  song: Pick<JamSongRow, "id" | "channel_id" | "author_id">,
  userId: string,
): Promise<boolean> {
  if (song.channel_id === null) {
    if (song.author_id !== null && song.author_id === userId) {
      return true;
    }
    if (!jamPublicEnabled()) {
      return false;
    }
    if (await isJamSongListed(song.id)) {
      return true;
    }
    const mine = await getPool().query(
      `SELECT 1 FROM jam_tracks WHERE song_id = $1 AND author_id = $2 AND deleted_at IS NULL LIMIT 1`,
      [song.id, userId],
    );
    return (mine.rowCount ?? 0) > 0;
  }
  return jamPublicEnabled() && (await isJamSongListed(song.id));
}

// ------------------------------------------------------------ public reads

interface PublicSongRow {
  id: string;
  title: string;
  artist: string | null;
  join_mode: string;
  wanted_instruments: string[];
  created_at: Date;
  updated_at: Date;
  published_at: Date;
  published_cursor: string;
  plays_count: string;
  likes_count: number;
  auto_accept_outside: boolean;
  starter_name: string;
  starter_handle: string | null;
  starter_avatar: string | null;
  origin_name: string | null;
  origin_icon: string | null;
  origin_slug: string | null;
  cover_key: string | null;
  parts: Array<{
    instrument: string;
    name: string;
    handle: string | null;
    avatarUrl: string | null;
    hasVideo: boolean;
  }> | null;
  part_count: number;
  mix_start: number | null;
  mix_end: number | null;
  preview_peaks: number[] | null;
  live_instruments: string[] | null;
}

/**
 * The public summary of songs. Every person is named by the account (never a
 * server nickname), the starter is INNER joined (a song whose starter is gone
 * is never public), the origin only when the starter shows it, the cover only
 * when it passed the scanner. `$1` is whether communities are on (the origin's
 * `slug`). The caller appends the WHERE clause, which must include
 * `${PUBLIC_SONG_SQL}` and `agg.part_count > 0`.
 */
const PUBLIC_SONG_SELECT = `
  SELECT s.id, s.title, s.artist, s.join_mode, s.wanted_instruments,
         s.created_at, s.updated_at,
         p.published_at, p.plays_count::text AS plays_count, p.likes_count,
         (p.auto_accept_since IS NOT NULL) AS auto_accept_outside,
         to_char(p.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS published_cursor,
         su.display_name AS starter_name, su.handle AS starter_handle, su.avatar_url AS starter_avatar,
         sv.name AS origin_name, sv.icon_url AS origin_icon,
         CASE WHEN $1::boolean AND sv.is_community AND NOT sv.is_community_suspended
              THEN sv.community_slug END AS origin_slug,
         ${PUBLIC_COVER_KEY_SQL} AS cover_key,
         agg.parts, agg.part_count, agg.mix_start, agg.mix_end,
         prev.preview_peaks, live.instruments AS live_instruments
    FROM jam_public_songs p
    JOIN jam_songs s ON s.id = p.song_id
    JOIN users su ON su.id = s.author_id
    LEFT JOIN servers sv ON sv.id = s.server_id AND p.show_origin
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS part_count,
             jsonb_agg(jsonb_build_object(
               'instrument', t.instrument,
               'name', u.display_name,
               'handle', u.handle,
               'avatarUrl', u.avatar_url,
               'hasVideo', ${publicVideoSql("t")}
             ) ORDER BY t.created_at, t.id) AS parts,
             MIN(t.offset_ms + t.trim_start_ms) AS mix_start,
             MAX(t.offset_ms + t.duration_ms - t.trim_end_ms) AS mix_end
        FROM jam_tracks t
        JOIN users u ON u.id = t.author_id
       WHERE t.song_id = s.id AND ${publicTrackSql("t")}
    ) agg ON TRUE
    LEFT JOIN LATERAL (
      SELECT t.peaks AS preview_peaks
        FROM jam_tracks t
       WHERE t.song_id = s.id AND ${publicTrackSql("t")} AND jsonb_array_length(t.peaks) > 0
       ORDER BY (SELECT COALESCE(SUM(v::float8), 0) FROM jsonb_array_elements_text(t.peaks) v) DESC,
                t.created_at, t.id
       LIMIT 1
    ) prev ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(array_agg(DISTINCT t.instrument), '{}') AS instruments
        FROM jam_tracks t
       WHERE t.song_id = s.id AND t.deleted_at IS NULL
    ) live ON TRUE`;

function instrumentOf(value: string): JamInstrument {
  return (JAM_INSTRUMENTS as readonly string[]).includes(value) ? (value as JamInstrument) : "other";
}

function sortedInstruments(list: readonly string[]): JamInstrument[] {
  const rank = (one: string) => {
    const index = (JAM_INSTRUMENTS as readonly string[]).indexOf(one);
    return index === -1 ? JAM_INSTRUMENTS.length : index;
  };
  return [...new Set(list)].sort((a, b) => rank(a) - rank(b)).map(instrumentOf);
}

function mapPublicSong(row: PublicSongRow, nowMs: number): PublicJamSong {
  const present = new Set(row.live_instruments ?? []);
  const parts: PublicJamPart[] = (row.parts ?? []).map((part) => ({
    instrument: instrumentOf(part.instrument),
    person: { name: part.name, handle: part.handle, avatarUrl: part.avatarUrl },
    hasVideo: part.hasVideo === true,
  }));
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    coverUrl: row.cover_key ? jamPublicMediaUrl(row.cover_key, nowMs) || null : null,
    durationMs:
      row.mix_start === null || row.mix_end === null ? null : Math.max(0, row.mix_end - row.mix_start),
    previewPeaks: row.preview_peaks ? reducePeaks(row.preview_peaks) : [],
    parts,
    needs:
      row.join_mode === "wanted"
        ? sortedInstruments(row.wanted_instruments.filter((one) => !present.has(one)))
        : [],
    plays: Number(row.plays_count),
    autoAcceptOutside: row.auto_accept_outside === true,
    likes: row.likes_count,
    startedBy: { name: row.starter_name, handle: row.starter_handle, avatarUrl: row.starter_avatar },
    origin: row.origin_name
      ? { name: row.origin_name, iconUrl: row.origin_icon, slug: row.origin_slug }
      : null,
    publishedAt: row.published_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

interface ListCursor {
  at: string;
  id: string;
  l?: number;
}

function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(raw: string | undefined, sort: "new" | "top"): ListCursor | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as ListCursor;
    const ok =
      typeof parsed.at === "string" &&
      !Number.isNaN(Date.parse(parsed.at)) &&
      typeof parsed.id === "string" &&
      /^[0-9a-f-]{36}$/i.test(parsed.id) &&
      (sort === "new" || (typeof parsed.l === "number" && Number.isInteger(parsed.l)));
    return ok ? parsed : null;
  } catch {
    return null;
  }
}

/** `GET /api/public/jams`. A cursor that does not parse reads as page one. */
export async function listPublicJams(query: PublicJamListQuery): Promise<PublicJamListResponse> {
  const sort = query.sort ?? "new";
  const limit = query.limit ?? JAM_PUBLIC_PAGE_SIZE;
  const params: unknown[] = [isCommunitiesEnabled()];
  const where = [PUBLIC_SONG_SQL, "agg.part_count > 0"];
  if (query.needs) {
    params.push(query.needs);
    where.push(
      `s.join_mode = 'wanted' AND $${params.length}::text = ANY(s.wanted_instruments)
       AND NOT EXISTS (SELECT 1 FROM jam_tracks nt
                        WHERE nt.song_id = s.id AND nt.deleted_at IS NULL
                          AND nt.instrument = $${params.length}::text)`,
    );
  }
  const cursor = decodeCursor(query.cursor, sort);
  if (cursor) {
    if (sort === "top") {
      params.push(cursor.l, cursor.at, cursor.id);
      where.push(
        `(p.likes_count, p.published_at, s.id) < ($${params.length - 2}::int, $${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    } else {
      params.push(cursor.at, cursor.id);
      where.push(`(p.published_at, s.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
  }
  const order =
    sort === "top"
      ? "p.likes_count DESC, p.published_at DESC, s.id DESC"
      : "p.published_at DESC, s.id DESC";
  params.push(limit + 1);
  const result = await getPool().query<PublicSongRow>(
    `${PUBLIC_SONG_SELECT}
      WHERE ${where.join(" AND ")}
      ORDER BY ${order}
      LIMIT $${params.length}`,
    params,
  );
  const nowMs = Date.now();
  const page = result.rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    songs: page.map((row) => mapPublicSong(row, nowMs)),
    nextCursor:
      result.rows.length > limit && last
        ? encodeCursor(
            sort === "top"
              ? { l: last.likes_count, at: last.published_cursor, id: last.id }
              : { at: last.published_cursor, id: last.id },
          )
        : null,
  };
}

interface PublicTrackRow {
  id: string;
  instrument: string;
  label: string | null;
  offset_ms: number;
  trim_start_ms: number;
  trim_end_ms: number;
  duration_ms: number;
  gain: number;
  peaks: number[];
  audio_key: string;
  audio_content_type: string;
  video_key: string | null;
  video_content_type: string | null;
  video_bytes: string | null;
  video_mp4_key: string | null;
  video_mp4_content_type: string | null;
  video_mp4_bytes: string | null;
  video_public: boolean;
  name: string;
  handle: string | null;
  avatar_url: string | null;
}

/**
 * The files a public video exists as, best first, the private read's order
 * (`videoSourcesOf` in `jam.ts`): the worker's MP4 copy once its type is set
 * (the job's last write), then the recorded file. The copy is made from the
 * very bytes the frame scan judged (`video_scan_key` is the recording), so a
 * passed verdict covers both. A URL nothing could sign is left out.
 */
function publicVideoSources(
  track: Pick<
    PublicTrackRow,
    "video_key" | "video_content_type" | "video_bytes" | "video_mp4_key" | "video_mp4_content_type" | "video_mp4_bytes"
  >,
  nowMs: number,
): Array<{ url: string; contentType: string; bytes: number }> {
  const sources: Array<{ url: string; contentType: string; bytes: number }> = [];
  if (track.video_mp4_key && track.video_mp4_content_type) {
    sources.push({
      url: jamPublicMediaUrl(track.video_mp4_key, nowMs),
      contentType: track.video_mp4_content_type,
      bytes: track.video_mp4_bytes === null ? 0 : Number(track.video_mp4_bytes),
    });
  }
  if (track.video_key) {
    sources.push({
      url: jamPublicMediaUrl(track.video_key, nowMs),
      contentType: track.video_content_type ?? "video/webm",
      bytes: track.video_bytes === null ? 0 : Number(track.video_bytes),
    });
  }
  return sources.filter((source) => source.url !== "");
}

/** `GET /api/public/jams/:songId`, or null for anything that is not listed. */
export async function getPublicJam(songId: string): Promise<PublicJamSongDetail | null> {
  const songs = await getPool().query<PublicSongRow>(
    `${PUBLIC_SONG_SELECT} WHERE s.id = $2 AND ${PUBLIC_SONG_SQL} AND agg.part_count > 0`,
    [isCommunitiesEnabled(), songId],
  );
  const row = songs.rows[0];
  if (!row) {
    return null;
  }
  const tracks = await getPool().query<PublicTrackRow>(
    `SELECT t.id, t.instrument, t.label, t.offset_ms, t.trim_start_ms, t.trim_end_ms,
            t.duration_ms, t.gain, t.peaks, t.audio_key, t.audio_content_type,
            t.video_key, t.video_content_type, t.video_bytes::text AS video_bytes,
            t.video_mp4_key, t.video_mp4_content_type, t.video_mp4_bytes::text AS video_mp4_bytes,
            ${publicVideoSql("t")} AS video_public,
            u.display_name AS name, u.handle, u.avatar_url
       FROM jam_tracks t
       JOIN users u ON u.id = t.author_id
      WHERE t.song_id = $1 AND ${publicTrackSql("t")}
      ORDER BY t.created_at, t.id`,
    [songId],
  );
  const nowMs = Date.now();
  return {
    song: mapPublicSong(row, nowMs),
    tracks: tracks.rows.map((track): PublicJamTrack => {
      const videoSources = track.video_public ? publicVideoSources(track, nowMs) : [];
      const best = videoSources[0] ?? null;
      return {
      id: track.id,
      instrument: instrumentOf(track.instrument),
      label: track.label,
      person: { name: track.name, handle: track.handle, avatarUrl: track.avatar_url },
      offsetMs: track.offset_ms,
      trimStartMs: track.trim_start_ms,
      trimEndMs: track.trim_end_ms,
      durationMs: track.duration_ms,
      gain: track.gain,
      peaks: track.peaks,
      audioUrl: jamPublicMediaUrl(track.audio_key, nowMs),
      audioContentType: track.audio_content_type,
      videoUrl: best ? best.url : null,
      videoContentType: best ? best.contentType : null,
      videoSources,
      };
    }),
    mediaExpiresAt: jamPublicMediaExpiresAt(nowMs).toISOString(),
  };
}

/** `GET /api/jam-public/songs/:songId`: the public read, plus what the caller may do. */
export async function getPublicJamForViewer(
  songId: string,
  userId: string,
): Promise<JamPublicSongForViewer | null> {
  const detail = await getPublicJam(songId);
  const song = detail ? await getJamSongRow(songId) : null;
  if (!detail || !song) {
    return null;
  }
  const [liked, counts, recordable] = await Promise.all([
    getPool().query(`SELECT 1 FROM jam_public_likes WHERE song_id = $1 AND user_id = $2`, [songId, userId]),
    getPool().query<{ total: number; mine: number }>(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE author_id = $2)::int AS mine
         FROM jam_tracks WHERE song_id = $1 AND deleted_at IS NULL`,
      [songId, userId],
    ),
    mayRecordPublicly(userId, song),
  ]);
  const count = counts.rows[0] ?? { total: 0, mine: 0 };
  const open =
    jamPublicEnabled() &&
    isStorageConfigured() &&
    recordable &&
    count.total < JAM_MAX_TRACKS_PER_SONG &&
    count.mine < JAM_MAX_TRACKS_PER_AUTHOR;
  return {
    ...detail,
    viewer: {
      liked: (liked.rowCount ?? 0) > 0,
      isStarter: song.author_id === userId,
      addableInstruments: addableInstruments({ song, userId, canPost: open }),
    },
  };
}

// ------------------------------------------------------- private view

interface PartRow {
  id: string;
  author_id: string;
  author_name: string | null;
  instrument: string;
  in_mix: boolean;
  choice: JamPublicConsent | null;
  review_state: JamPublicReview | null;
  removed_at: Date | null;
  video_scan_status: JamPublicVideoScan | null;
  video_key: string | null;
  outside: boolean | null;
  is_public: boolean;
  is_public_video: boolean;
}

/** Where a song stands publicly, for its starter and its participants; null if never published. */
export async function getPublication(songId: string): Promise<JamPublication | null> {
  const head = await getPool().query<
    PublicationRow & { channel_id: string | null; listed: boolean; cover_status: string | null; has_cover: boolean }
  >(
    `SELECT p.*, s.channel_id,
            EXISTS (SELECT 1 FROM users su WHERE su.id = s.author_id AND ${LISTED_SONG_SQL}) AS listed,
            sc.upload_id IS NOT NULL AS has_cover,
            cs.status AS cover_status
       FROM jam_public_songs p
       JOIN jam_songs s ON s.id = p.song_id
       LEFT JOIN jam_song_covers sc ON sc.song_id = s.id
       LEFT JOIN jam_public_cover_scans cs ON cs.upload_id = sc.upload_id
      WHERE p.song_id = $1 AND s.deleted_at IS NULL`,
    [songId],
  );
  const row = head.rows[0];
  if (!row) {
    return null;
  }
  const parts = await getPool().query<PartRow>(
    `SELECT t.id, t.author_id, u.display_name AS author_name, t.instrument, t.in_mix,
            pc.choice, pt.review_state, pt.removed_at, pt.video_scan_status, t.video_key, pt.outside,
            ${publicTrackSql("t")} AS is_public,
            (${publicTrackSql("t")} AND ${publicVideoSql("t")}) AS is_public_video
       FROM jam_tracks t
       JOIN users u ON u.id = t.author_id
       LEFT JOIN jam_public_consents pc ON pc.song_id = t.song_id AND pc.user_id = t.author_id
       LEFT JOIN jam_public_tracks pt ON pt.track_id = t.id
      WHERE t.song_id = $1 AND t.deleted_at IS NULL
      ORDER BY t.created_at, t.id`,
    [songId],
  );
  const status = publicationStatus(row);
  const on = jamPublicEnabled();
  return {
    songId,
    status,
    listed: on && status === "live" && row.listed,
    publishedAt: row.published_at.toISOString(),
    hasOrigin: row.channel_id !== null,
    showOrigin: row.show_origin,
    plays: Number(row.plays_count),
    likes: row.likes_count,
    removedReason: row.removed_reason ?? row.unpublish_reason ?? null,
    cover: !row.has_cover
      ? "none"
      : row.cover_status === "passed"
        ? "shown"
        : row.cover_status === null || row.cover_status === "pending"
          ? "pending"
          : "hidden",
    parts: parts.rows.map((part): JamPublicationPart => ({
      trackId: part.id,
      authorId: part.author_id,
      authorName: part.author_name,
      instrument: instrumentOf(part.instrument),
      inMix: part.in_mix,
      consent: part.choice ?? "pending",
      review: part.review_state ?? "none",
      removed: part.removed_at !== null,
      video: part.video_scan_status ?? (part.video_key ? "pending" : "none"),
      public: on && part.is_public,
      publicVideo: on && part.is_public_video,
    })),
    pendingTakes: parts.rows.filter((part) => part.outside === true && !part.in_mix).length,
    autoAcceptOutside: row.auto_accept_since !== null,
  };
}

async function requirePublication(songId: string): Promise<JamPublication> {
  const publication = await getPublication(songId);
  if (!publication) {
    throw new HttpError(404, JAM_NOT_FOUND);
  }
  return publication;
}

/** Songs where this person has a part, the song is published, and they have not answered. */
export async function pendingJamConsentsFor(userId: string): Promise<JamPublicConsentRequest[]> {
  const result = await getPool().query<{
    id: string;
    title: string;
    artist: string | null;
    published_at: Date;
    starter_name: string | null;
    starter_avatar: string | null;
    server_name: string | null;
    parts: number;
  }>(
    `SELECT s.id, s.title, s.artist, p.published_at,
            su.display_name AS starter_name, su.avatar_url AS starter_avatar,
            sv.name AS server_name, COUNT(t.id)::int AS parts
       FROM jam_tracks t
       JOIN jam_songs s ON s.id = t.song_id
       JOIN jam_public_songs p ON p.song_id = s.id
       LEFT JOIN users su ON su.id = s.author_id
       LEFT JOIN servers sv ON sv.id = s.server_id
      WHERE t.author_id = $1 AND t.deleted_at IS NULL AND s.deleted_at IS NULL
        AND p.unpublished_at IS NULL AND p.removed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM jam_public_consents c WHERE c.song_id = s.id AND c.user_id = $1)
      GROUP BY s.id, s.title, s.artist, p.published_at, su.display_name, su.avatar_url, sv.name
      ORDER BY p.published_at DESC
      LIMIT 100`,
    [userId],
  );
  return result.rows.map((row) => ({
    songId: row.id,
    title: row.title,
    artist: row.artist,
    startedBy: { name: row.starter_name, avatarUrl: row.starter_avatar },
    serverName: row.server_name,
    publishedAt: row.published_at.toISOString(),
    parts: row.parts,
  }));
}

/** The starter's inbox: outside takes on their published songs, still out of the mix. */
export async function jamPublicInboxFor(userId: string): Promise<JamPublicInboxItem[]> {
  const result = await getPool().query<{ id: string; song_id: string; title: string }>(
    `SELECT t.id, s.id AS song_id, s.title
       FROM jam_tracks t
       JOIN jam_public_tracks pt ON pt.track_id = t.id
       JOIN jam_songs s ON s.id = t.song_id
       JOIN jam_public_songs p ON p.song_id = s.id
      WHERE s.author_id = $1 AND pt.outside AND NOT t.in_mix
        AND t.deleted_at IS NULL AND s.deleted_at IS NULL AND p.removed_at IS NULL
      ORDER BY t.created_at DESC
      LIMIT 100`,
    [userId],
  );
  const items = await Promise.all(
    result.rows.map(async (row) => {
      const track = await getJamTrack(row.id);
      return track ? { songId: row.song_id, songTitle: row.title, track } : null;
    }),
  );
  return items.filter((item): item is JamPublicInboxItem => item !== null);
}

/** The caller's published songs, newest first. */
export async function myPublicJams(
  userId: string,
): Promise<Array<{ song: JamSongSummary; publication: JamPublication }>> {
  const result = await getPool().query<{ song_id: string }>(
    `SELECT p.song_id FROM jam_public_songs p JOIN jam_songs s ON s.id = p.song_id
      WHERE s.author_id = $1 AND s.deleted_at IS NULL
      ORDER BY p.published_at DESC
      LIMIT 100`,
    [userId],
  );
  const items = await Promise.all(
    result.rows.map(async ({ song_id }) => {
      const [song, publication] = await Promise.all([getJamSongSummary(song_id), getPublication(song_id)]);
      return song && publication ? { song, publication } : null;
    }),
  );
  return items.filter(
    (item): item is { song: JamSongSummary; publication: JamPublication } => item !== null,
  );
}

// --------------------------------------------------------------- likes

const LIKE_BUCKET = () => ({
  bucket: "jam-public-like",
  capacity: jamPublicLimits.likesPerMinute(),
  refillPerSecond: jamPublicLimits.likesPerMinute() / 60,
});

/**
 * Like (one per account) or take it back. Liking needs the flag and a listed
 * song; taking a like back works on anything the person liked. The count is
 * recomputed in the transaction that changed it, under the publication's row
 * lock, so two likes on two machines are ordered.
 */
export async function setJamPublicLike(
  songId: string,
  userId: string,
  liked: boolean,
): Promise<JamPublicLikeResponse> {
  if (liked) {
    requireJamPublicOn();
    if (!(await isJamSongListed(songId))) {
      throw new HttpError(404, JAM_NOT_FOUND);
    }
  }
  if (!(await sharedRateLimit(LIKE_BUCKET(), userId))) {
    throw refuseRate("likes");
  }
  const likes = await withTransaction(async (client) => {
    const locked = await client.query(
      `SELECT 1 FROM jam_public_songs WHERE song_id = $1 FOR UPDATE`,
      [songId],
    );
    if ((locked.rowCount ?? 0) === 0) {
      throw new HttpError(404, JAM_NOT_FOUND);
    }
    const write = liked
      ? await client.query(
          `INSERT INTO jam_public_likes (song_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [songId, userId],
        )
      : await client.query(`DELETE FROM jam_public_likes WHERE song_id = $1 AND user_id = $2`, [
          songId,
          userId,
        ]);
    const count = await client.query<{ likes: number }>(
      `UPDATE jam_public_songs
          SET likes_count = (SELECT COUNT(*)::int FROM jam_public_likes WHERE song_id = $1)
        WHERE song_id = $1
        RETURNING likes_count AS likes`,
      [songId],
    );
    if (liked && (write.rowCount ?? 0) > 0) {
      counters.likes += 1;
    }
    return count.rows[0]?.likes ?? 0;
  });
  return { songId, liked, likes };
}

// -------------------------------------------------------------- reports

/**
 * A person reports a public song, or one part of it. Goes to the INSTANCE
 * queue (a `reports` row: `subject_type` user, the part's author or the
 * starter as the person, `context_kind` none, no server) and to
 * `jam_public_reports`, which the auto-hide counts.
 */
export async function reportPublicJam(input: {
  reporterId: string;
  request: ReportPublicJamRequest;
}): Promise<JamPublicReportResponse> {
  const { reporterId, request } = input;
  requireJamPublicOn();
  const target = await getPool().query<{
    title: string;
    starter_id: string;
    reported_id: string;
    reviewed_at: Date | null;
  }>(
    `SELECT s.title, s.author_id AS starter_id,
            COALESCE(rt.author_id, s.author_id) AS reported_id, p.reviewed_at
       FROM jam_public_songs p
       JOIN jam_songs s ON s.id = p.song_id
       JOIN users su ON su.id = s.author_id
       LEFT JOIN jam_tracks rt ON rt.id = $2::uuid AND rt.song_id = s.id AND ${publicTrackSql("rt")}
      WHERE p.song_id = $1 AND ${LISTED_SONG_SQL}
        AND ($2::uuid IS NULL OR rt.id IS NOT NULL)`,
    [request.songId, request.trackId ?? null],
  );
  const song = target.rows[0];
  if (!song) {
    throw new HttpError(404, JAM_NOT_FOUND);
  }

  const windowHours = jamPublicLimits.reportWindowHours();
  const duplicate = await getPool().query(
    `SELECT 1 FROM jam_public_reports
      WHERE song_id = $1 AND reporter_id = $2
        AND track_id IS NOT DISTINCT FROM $3::uuid
        AND created_at > GREATEST(NOW() - make_interval(hours => $4),
                                  COALESCE($5::timestamptz, '-infinity'::timestamptz))`,
    [request.songId, reporterId, request.trackId ?? null, windowHours, song.reviewed_at],
  );
  if ((duplicate.rowCount ?? 0) > 0) {
    return { duplicate: true };
  }

  const today = await getPool().query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM jam_public_reports
      WHERE reporter_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
    [reporterId],
  );
  if ((today.rows[0]?.count ?? 0) >= jamPublicLimits.reportsPerDay()) {
    throw refuseRate("reports");
  }
  try {
    await assertUnderFloodCap(reporterId);
  } catch (error) {
    if (error instanceof ReportFloodError) {
      throw refuseRate("reports");
    }
    throw error;
  }

  const reportId = await fileInstanceReport({
    reporterId,
    reportedUserId: song.reported_id,
    title: song.title,
    songId: request.songId,
    trackId: request.trackId ?? null,
    reason: request.reason,
    details: request.details ?? null,
  });
  await getPool().query(
    `INSERT INTO jam_public_reports (song_id, track_id, reporter_id, reason, details, report_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [request.songId, request.trackId ?? null, reporterId, request.reason, request.details ?? null, reportId],
  );
  counters.reportsFiled += 1;
  await maybeAutoHide(request.songId, song.reviewed_at);
  return { duplicate: false };
}

/**
 * The instance queue's copy: an ordinary user report about the part's author
 * (or the starter), with the song named in the place label and the details.
 * Signed in only: a NULL reporter means "a scanner said so" in that table,
 * and an anonymous person must not be able to file as one. When this reporter
 * already has an open report about that person in the instance queue (its
 * unique index), that one stands and this links to it.
 */
async function fileInstanceReport(input: {
  reporterId: string;
  reportedUserId: string;
  title: string;
  songId: string;
  trackId: string | null;
  reason: string;
  details: string | null;
}): Promise<string | null> {
  const user = await getPool().query<{
    display_name: string;
    username: string | null;
    discriminator: string | null;
  }>(`SELECT display_name, username, discriminator FROM users WHERE id = $1`, [input.reportedUserId]);
  const row = user.rows[0];
  if (!row) {
    return null;
  }
  const tag = formatUserTag(row.username, row.discriminator);
  const label = tag ? `${row.display_name} ${tag}` : row.display_name;
  const details =
    `Jam pública ${input.songId}` +
    (input.trackId ? `, parte ${input.trackId}` : "") +
    (input.details ? `: ${input.details}` : "");
  try {
    const inserted = await getPool().query<{ id: string }>(
      `INSERT INTO reports (
         reporter_id, subject_type, context_kind, reported_user_id,
         server_id, channel_id, subject_label, channel_label, reason, details
       ) VALUES ($1, 'user', 'none', $2, NULL, NULL, $3, $4, $5, $6)
       RETURNING id::text AS id`,
      [input.reporterId, input.reportedUserId, label, `Jam pública · ${input.title}`, input.reason, details],
    );
    return inserted.rows[0]?.id ?? null;
  } catch (error) {
    if ((error as { code?: string }).code !== "23505") {
      throw error;
    }
    const existing = await getPool().query<{ id: string }>(
      `SELECT id::text AS id FROM reports
        WHERE status = 'open' AND reporter_id = $1 AND reported_user_id = $2
          AND subject_type = 'user' AND server_id IS NULL
        ORDER BY id DESC LIMIT 1`,
      [input.reporterId, input.reportedUserId],
    );
    return existing.rows[0]?.id ?? null;
  }
}

/**
 * Hide a song once `JAM_PUBLIC_REPORTS_TO_HIDE` distinct people reported it
 * inside the window (and since the last operator decision, so an approval is
 * not undone by the reports it already weighed).
 */
async function maybeAutoHide(songId: string, reviewedAt: Date | null): Promise<void> {
  const distinct = await getPool().query<{ count: number }>(
    `SELECT COUNT(DISTINCT reporter_id)::int AS count FROM jam_public_reports
      WHERE song_id = $1 AND reporter_id IS NOT NULL
        AND created_at > GREATEST(NOW() - make_interval(hours => $2),
                                  COALESCE($3::timestamptz, '-infinity'::timestamptz))`,
    [songId, jamPublicLimits.reportWindowHours(), reviewedAt],
  );
  if ((distinct.rows[0]?.count ?? 0) < jamPublicLimits.reportsToHide()) {
    return;
  }
  const hidden = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE jam_public_songs SET hidden_at = NOW() WHERE song_id = $1 AND hidden_at IS NULL`,
      [songId],
    );
    if ((result.rowCount ?? 0) > 0) {
      await audit(client, { action: "auto-hide", songId, actor: { kind: "system" } });
      return true;
    }
    return false;
  });
  if (hidden) {
    counters.autoHidden += 1;
    console.warn(`[jam-public] song ${songId} hidden by reports, waiting for an operator`);
  }
}

// ------------------------------------------------------------- operator

interface AdminSongRow {
  song_id: string;
  title: string;
  artist: string | null;
  published_at: Date;
  review_state: JamPublicReview;
  hidden_at: Date | null;
  unpublished_at: Date | null;
  removed_at: Date | null;
  removed_reason: string | null;
  unpublish_reason: string | null;
  plays_count: string;
  likes_count: number;
  starter_id: string | null;
  starter_name: string | null;
  starter_handle: string | null;
  starter_blocked: boolean;
  server_id: string | null;
  server_name: string | null;
  reports: number;
  copyright_reports: number;
  public_parts: number;
  listed: boolean;
}

const ADMIN_SONG_SELECT = `
  SELECT p.song_id, s.title, s.artist, p.published_at, p.review_state, p.hidden_at,
         p.unpublished_at, p.removed_at, p.removed_reason, p.unpublish_reason,
         p.plays_count::text AS plays_count, p.likes_count,
         s.author_id AS starter_id, au.display_name AS starter_name, au.handle AS starter_handle,
         EXISTS (SELECT 1 FROM jam_public_blocks b WHERE b.user_id = s.author_id) AS starter_blocked,
         s.server_id, sv.name AS server_name,
         rc.reports, rc.copyright_reports,
         (SELECT COUNT(*)::int FROM jam_tracks pt WHERE pt.song_id = s.id AND ${publicTrackSql("pt")}) AS public_parts,
         EXISTS (SELECT 1 FROM users su WHERE su.id = s.author_id AND ${LISTED_SONG_SQL}) AS listed
    FROM jam_public_songs p
    JOIN jam_songs s ON s.id = p.song_id
    LEFT JOIN users au ON au.id = s.author_id
    LEFT JOIN servers sv ON sv.id = s.server_id
    -- One pass over the song's reports for both numbers (a filtered distinct for the copyright subset).
    CROSS JOIN LATERAL (
      SELECT COUNT(DISTINCT r.reporter_id)::int AS reports,
             (COUNT(DISTINCT r.reporter_id) FILTER (WHERE r.reason = 'copyright'))::int AS copyright_reports
        FROM jam_public_reports r
       WHERE r.song_id = p.song_id
         AND r.created_at > GREATEST(NOW() - make_interval(hours => $1),
                                     COALESCE(p.reviewed_at, '-infinity'::timestamptz))
    ) rc`;

function mapAdminSong(row: AdminSongRow): AdminJamPublicSong {
  const status = publicationStatus(row);
  return {
    songId: row.song_id,
    title: row.title,
    artist: row.artist,
    status,
    listed: jamPublicEnabled() && status === "live" && row.listed,
    publishedAt: row.published_at.toISOString(),
    starter:
      row.starter_id && row.starter_name !== null
        ? {
            id: row.starter_id,
            name: row.starter_name,
            handle: row.starter_handle,
            blocked: row.starter_blocked,
          }
        : null,
    origin: row.server_id && row.server_name !== null ? { serverId: row.server_id, name: row.server_name } : null,
    plays: Number(row.plays_count),
    likes: row.likes_count,
    reports: row.reports,
    copyrightReports: row.copyright_reports,
    publicParts: row.public_parts,
    hiddenAt: row.hidden_at ? row.hidden_at.toISOString() : null,
    removedReason: row.removed_reason ?? row.unpublish_reason ?? null,
  };
}

/** `GET /api/admin/jam-public/songs`: newest first, 50 a page, by status. */
export async function adminListPublicJams(query: {
  status?: JamPublicationStatus | "all";
  cursor?: string;
}): Promise<{ songs: AdminJamPublicSong[]; nextCursor: string | null }> {
  const params: unknown[] = [jamPublicLimits.reportWindowHours()];
  const where = ["s.deleted_at IS NULL"];
  switch (query.status ?? "all") {
    case "removed":
      where.push("p.removed_at IS NOT NULL");
      break;
    case "unpublished":
      where.push("p.removed_at IS NULL AND p.unpublished_at IS NOT NULL");
      break;
    case "review":
      where.push("p.removed_at IS NULL AND p.unpublished_at IS NULL AND p.review_state = 'pending'");
      break;
    case "hidden":
      where.push(
        "p.removed_at IS NULL AND p.unpublished_at IS NULL AND p.review_state <> 'pending' AND p.hidden_at IS NOT NULL",
      );
      break;
    case "live":
      where.push(
        "p.removed_at IS NULL AND p.unpublished_at IS NULL AND p.review_state <> 'pending' AND p.hidden_at IS NULL",
      );
      break;
    default:
      break;
  }
  const cursor = decodeCursor(query.cursor, "new");
  if (cursor) {
    params.push(cursor.at, cursor.id);
    where.push(`(p.published_at, p.song_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  const result = await getPool().query<AdminSongRow & { published_cursor: string }>(
    `${ADMIN_SONG_SELECT.replace(
      "SELECT p.song_id,",
      `SELECT to_char(p.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS published_cursor, p.song_id,`,
    )}
      WHERE ${where.join(" AND ")}
      ORDER BY p.published_at DESC, p.song_id DESC
      LIMIT 51`,
    params,
  );
  const page = result.rows.slice(0, 50);
  const last = page[page.length - 1];
  return {
    songs: page.map(mapAdminSong),
    nextCursor:
      result.rows.length > 50 && last ? encodeCursor({ at: last.published_cursor, id: last.song_id }) : null,
  };
}

interface AdminTrackRow {
  track_id: string;
  song_id: string;
  title: string;
  author_id: string;
  author_name: string;
  author_handle: string | null;
  instrument: string;
  review_state: JamPublicReview;
  video_scan_status: JamPublicVideoScan;
  created_at: Date;
}

const ADMIN_TRACK_SELECT = `
  SELECT pt.track_id, pt.song_id, s.title, pt.author_id, u.display_name AS author_name,
         u.handle AS author_handle, t.instrument, pt.review_state, pt.video_scan_status, pt.created_at
    FROM jam_public_tracks pt
    JOIN jam_tracks t ON t.id = pt.track_id
    JOIN jam_songs s ON s.id = pt.song_id
    JOIN users u ON u.id = pt.author_id`;

function mapAdminTrack(row: AdminTrackRow): AdminJamPublicTrack {
  return {
    trackId: row.track_id,
    songId: row.song_id,
    songTitle: row.title,
    author: { id: row.author_id, name: row.author_name, handle: row.author_handle },
    instrument: instrumentOf(row.instrument),
    review: row.review_state,
    video: row.video_scan_status,
    createdAt: row.created_at.toISOString(),
  };
}

/** `GET /api/admin/jam-public/queue`. */
export async function adminJamPublicQueue(): Promise<AdminJamPublicQueue> {
  const [songs, tracks, videos] = await Promise.all([
    getPool().query<AdminSongRow>(
      `${ADMIN_SONG_SELECT}
        WHERE s.deleted_at IS NULL AND p.removed_at IS NULL AND p.unpublished_at IS NULL
          AND (p.review_state = 'pending' OR p.hidden_at IS NOT NULL)
        ORDER BY p.published_at
        LIMIT 200`,
      [jamPublicLimits.reportWindowHours()],
    ),
    getPool().query<AdminTrackRow>(
      `${ADMIN_TRACK_SELECT}
        WHERE pt.review_state = 'pending' AND t.deleted_at IS NULL AND s.deleted_at IS NULL
        ORDER BY pt.created_at
        LIMIT 200`,
    ),
    getPool().query<AdminTrackRow>(
      `${ADMIN_TRACK_SELECT}
        WHERE pt.video_scan_status IN ('flagged', 'rejected')
        ORDER BY pt.video_scanned_at DESC NULLS LAST
        LIMIT 100`,
    ),
  ]);
  return {
    songs: songs.rows.map(mapAdminSong),
    tracks: tracks.rows.map(mapAdminTrack),
    videos: videos.rows.map(mapAdminTrack),
  };
}

async function songTitleAndStarter(songId: string): Promise<{ title: string; author_id: string | null } | null> {
  const result = await getPool().query<{ title: string; author_id: string | null }>(
    `SELECT title, author_id FROM jam_songs WHERE id = $1`,
    [songId],
  );
  return result.rows[0] ?? null;
}

/** `PUT /api/admin/jam-public/unpublish`: an operator takes a song down. Only an operator restores it. */
export async function adminUnpublishJam(
  body: AdminUnpublishJamRequest,
  actor: JamPublicActor,
): Promise<{ publication: JamPublication | null }> {
  const song = await songTitleAndStarter(body.songId);
  const changed = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE jam_public_songs SET removed_at = NOW(), removed_reason = $2, reviewed_at = NOW()
        WHERE song_id = $1 AND removed_at IS NULL`,
      [body.songId, body.reason],
    );
    if ((result.rowCount ?? 0) === 0) {
      const exists = await client.query(`SELECT 1 FROM jam_public_songs WHERE song_id = $1`, [body.songId]);
      if ((exists.rowCount ?? 0) === 0) {
        throw new HttpError(404, JAM_NOT_FOUND);
      }
      return false;
    }
    await audit(client, { action: "remove", songId: body.songId, actor, reason: body.reason });
    return true;
  });
  if (changed) {
    counters.takenDown += 1;
    if (song?.author_id) {
      notifyJamPublic(song.author_id, {
        kind: "removed",
        songId: body.songId,
        title: song.title,
        reason: body.reason,
      });
    }
  }
  return { publication: await getPublication(body.songId) };
}

/** `PUT /api/admin/jam-public/review`. */
export async function adminReviewJam(
  body: AdminReviewJamRequest,
  actor: JamPublicActor,
): Promise<{ ok: true }> {
  if (body.kind === "song") {
    const song = await songTitleAndStarter(body.id);
    await withTransaction(async (client) => {
      const result =
        body.decision === "approve"
          ? await client.query(
              `UPDATE jam_public_songs
                  SET review_state = CASE WHEN review_state = 'pending' THEN 'approved' ELSE review_state END,
                      hidden_at = NULL, removed_at = NULL, removed_reason = NULL, reviewed_at = NOW()
                WHERE song_id = $1`,
              [body.id],
            )
          : await client.query(
              `UPDATE jam_public_songs
                  SET review_state = CASE WHEN review_state = 'pending' THEN 'rejected' ELSE review_state END,
                      removed_at = COALESCE(removed_at, NOW()),
                      removed_reason = COALESCE($2, removed_reason, 'Recusada na revisão'),
                      reviewed_at = NOW()
                WHERE song_id = $1`,
              [body.id, body.reason ?? null],
            );
      if ((result.rowCount ?? 0) === 0) {
        throw new HttpError(404, JAM_NOT_FOUND);
      }
      if (body.decision === "approve" && song?.author_id) {
        // The starter's own takes on a song an operator just looked at are
        // looked at too.
        await client.query(
          `UPDATE jam_public_tracks SET review_state = 'approved', reviewed_at = NOW()
            WHERE song_id = $1 AND author_id = $2 AND review_state = 'pending'`,
          [body.id, song.author_id],
        );
      }
      await audit(client, {
        action: `review-song-${body.decision}`,
        songId: body.id,
        actor,
        reason: body.reason ?? null,
      });
    });
    if (song?.author_id) {
      notifyJamPublic(song.author_id, {
        kind: body.decision === "approve" ? "approved" : "rejected",
        songId: body.id,
        title: song.title,
        reason: body.reason ?? null,
      });
    }
    if (body.decision === "approve") {
      // Takes that only waited for the song's own review go in now.
      await admitAutoAcceptedTakes({ songId: body.id });
    }
    return { ok: true };
  }
  const track = await getPool().query<{ song_id: string; author_id: string; title: string }>(
    `SELECT pt.song_id, pt.author_id, s.title FROM jam_public_tracks pt
       JOIN jam_songs s ON s.id = pt.song_id WHERE pt.track_id = $1`,
    [body.id],
  );
  const row = track.rows[0];
  if (!row) {
    throw new HttpError(404, JAM_NOT_FOUND);
  }
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE jam_public_tracks SET review_state = $2, reviewed_at = NOW() WHERE track_id = $1`,
      [body.id, body.decision === "approve" ? "approved" : "rejected"],
    );
    await audit(client, {
      action: `review-track-${body.decision}`,
      songId: row.song_id,
      trackId: body.id,
      userId: row.author_id,
      actor,
      reason: body.reason ?? null,
    });
  });
  notifyJamPublic(row.author_id, {
    kind: body.decision === "approve" ? "approved" : "rejected",
    songId: row.song_id,
    title: row.title,
    trackId: body.id,
    reason: body.reason ?? null,
  });
  if (body.decision === "approve") {
    // The hold that was this operator's decision just cleared.
    await admitAutoAcceptedTakes({ songId: row.song_id });
  }
  return { ok: true };
}

/** `PUT /api/admin/jam-public/remove-part`: out of the public version; the track stays in its song. */
export async function adminRemoveJamPart(
  body: AdminRemoveJamPartRequest,
  actor: JamPublicActor,
): Promise<{ ok: true }> {
  const track = await getPool().query<{ song_id: string; author_id: string; title: string }>(
    `SELECT t.song_id, t.author_id, s.title FROM jam_tracks t JOIN jam_songs s ON s.id = t.song_id
      WHERE t.id = $1`,
    [body.trackId],
  );
  const row = track.rows[0];
  if (!row) {
    throw new HttpError(404, JAM_NOT_FOUND);
  }
  await withTransaction(async (client) => {
    // A track with no public row yet gets one already removed, so a later
    // publish cannot bring it back.
    await client.query(
      `INSERT INTO jam_public_tracks (track_id, song_id, author_id, origin, removed_at, removed_reason)
       VALUES ($1, $2, $3, 'published', NOW(), $4)
       ON CONFLICT (track_id) DO UPDATE SET removed_at = COALESCE(jam_public_tracks.removed_at, NOW()),
                                            removed_reason = $4`,
      [body.trackId, row.song_id, row.author_id, body.reason],
    );
    await audit(client, {
      action: "remove-part",
      songId: row.song_id,
      trackId: body.trackId,
      userId: row.author_id,
      actor,
      reason: body.reason,
    });
  });
  notifyJamPublic(row.author_id, {
    kind: "part-removed",
    songId: row.song_id,
    title: row.title,
    trackId: body.trackId,
    reason: body.reason,
  });
  return { ok: true };
}

/** `PUT /api/admin/jam-public/block`: their songs and parts leave every public read at once. */
export async function adminBlockJamPublisher(
  body: AdminBlockJamPublisherRequest,
  actor: JamPublicActor,
): Promise<{ blocked: boolean }> {
  await withTransaction(async (client) => {
    const exists = await client.query(`SELECT 1 FROM users WHERE id = $1`, [body.userId]);
    if ((exists.rowCount ?? 0) === 0) {
      throw new HttpError(404, JAM_NOT_FOUND);
    }
    if (body.blocked) {
      await client.query(
        `INSERT INTO jam_public_blocks (user_id, reason, blocked_by) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET reason = EXCLUDED.reason, blocked_at = NOW()`,
        [body.userId, body.reason ?? null, "userId" in actor ? actor.userId : null],
      );
    } else {
      await client.query(`DELETE FROM jam_public_blocks WHERE user_id = $1`, [body.userId]);
    }
    await audit(client, {
      action: body.blocked ? "block" : "unblock",
      userId: body.userId,
      actor,
      reason: body.reason ?? null,
    });
  });
  return { blocked: body.blocked };
}

// --------------------------------------------------------------- sweep

/**
 * The cold path, every minute from `jobs.ts`, safe on two processes:
 *  - a standalone song whose starter's account is gone is deleted (its other
 *    people's tracks with it; their objects go with the media sweep a day
 *    later). A channel song outlives its author, as it always did.
 *  - play marks older than three hours are deleted (the dedupe only needs the
 *    current hour).
 *  - outside takes that auto-accept can now admit are admitted (`admitAutoAcceptedTakes`).
 */
export async function sweepJamPublic(): Promise<{ orphans: number; playMarks: number; admitted: number }> {
  const orphans = await getPool().query<{ id: string }>(
    `SELECT id FROM jam_songs
      WHERE channel_id IS NULL AND author_id IS NULL AND deleted_at IS NULL
      ORDER BY created_at LIMIT 100`,
  );
  let deleted = 0;
  for (const row of orphans.rows) {
    if (await deleteJamSong(row.id)) {
      deleted += 1;
    }
  }
  const marks = await getPool().query(
    `DELETE FROM jam_public_play_marks
      WHERE hour_bucket < floor(EXTRACT(EPOCH FROM NOW()) / 3600)::int - 3`,
  );
  // The backstop of auto-accept: whatever held an outside take cleared without
  // a hook of its own (a block lifted, a scan that finished on another
  // process, a restart in the middle of an admission).
  const admitted = (await admitAutoAcceptedTakes()).length;
  return { orphans: deleted, playMarks: marks.rowCount ?? 0, admitted };
}

// -------------------------------------------------------------- metrics

export interface JamPublicTableMetrics {
  enabled: boolean;
  /** Songs whose publication is open and not waiting or hidden (listed or about to be). */
  published: number;
  pendingReview: { songs: number; tracks: number };
  hiddenByReports: number;
  removed: number;
  plays: number;
  likes: number;
  scans: {
    covers: Record<string, number>;
    videos: Record<string, number>;
    quarantined: number;
  };
}

/** The table half of the dashboard's `jamPublic` block. A handful of COUNTs on small tables. */
export async function jamPublicTableMetrics(): Promise<JamPublicTableMetrics> {
  const [songs, tracks, covers, videos, quarantine] = await Promise.all([
    getPool().query<{
      published: number;
      review: number;
      hidden: number;
      removed: number;
      plays: string;
      likes: string;
    }>(
      `SELECT COUNT(*) FILTER (WHERE removed_at IS NULL AND unpublished_at IS NULL
                                 AND review_state <> 'pending' AND hidden_at IS NULL)::int AS published,
              COUNT(*) FILTER (WHERE removed_at IS NULL AND unpublished_at IS NULL
                                 AND review_state = 'pending')::int AS review,
              COUNT(*) FILTER (WHERE removed_at IS NULL AND unpublished_at IS NULL
                                 AND hidden_at IS NOT NULL)::int AS hidden,
              COUNT(*) FILTER (WHERE removed_at IS NOT NULL)::int AS removed,
              COALESCE(SUM(plays_count), 0)::text AS plays,
              COALESCE(SUM(likes_count), 0)::text AS likes
         FROM jam_public_songs`,
    ),
    getPool().query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM jam_public_tracks WHERE review_state = 'pending'`,
    ),
    getPool().query<{ status: string; count: number }>(
      `SELECT status, COUNT(*)::int AS count FROM jam_public_cover_scans GROUP BY status`,
    ),
    getPool().query<{ status: string; count: number }>(
      `SELECT video_scan_status AS status, COUNT(*)::int AS count FROM jam_public_tracks
        WHERE video_scan_status <> 'none' GROUP BY video_scan_status`,
    ),
    getPool().query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM jam_public_quarantine`),
  ]);
  const head = songs.rows[0];
  const byStatus = (rows: Array<{ status: string; count: number }>) =>
    Object.fromEntries(rows.map((row) => [row.status, row.count]));
  return {
    enabled: jamPublicEnabled(),
    published: head?.published ?? 0,
    pendingReview: { songs: head?.review ?? 0, tracks: tracks.rows[0]?.count ?? 0 },
    hiddenByReports: head?.hidden ?? 0,
    removed: head?.removed ?? 0,
    plays: Number(head?.plays ?? 0),
    likes: Number(head?.likes ?? 0),
    scans: {
      covers: byStatus(covers.rows),
      videos: byStatus(videos.rows),
      quarantined: quarantine.rows[0]?.count ?? 0,
    },
  };
}
