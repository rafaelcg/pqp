/**
 * THE ONE PLACE "PUBLIC" IS WRITTEN DOWN, as SQL (packages/shared/src/jam-public.ts,
 * "WHAT IS IN THE PUBLIC VERSION"). Every public read, the access check that
 * lets a non-member record on a public song, the private publication view and
 * the metrics use these fragments and nothing else, so the list, the song, the
 * studio and the counters cannot disagree about what is public.
 *
 * No imports: `services/jam.ts` reads the track rule for its public view, and
 * `services/jam-public.ts` imports `jam.ts`.
 *
 * Everything is evaluated per read. Nothing here is cached in the API, so an
 * unpublish, a withdrawn consent, a removed part, a block or a deleted account
 * is out of the very next answer on every machine.
 */

/**
 * The song-level rule. Needs `p` (jam_public_songs), `s` (jam_songs) and `su`
 * (users, the starter, INNER joined on `s.author_id`, so a song whose starter
 * is gone never matches).
 */
export const PUBLIC_SONG_SQL = `(
  p.unpublished_at IS NULL
  AND p.removed_at IS NULL
  AND p.hidden_at IS NULL
  AND p.review_state IN ('none', 'approved')
  AND s.deleted_at IS NULL
  AND su.deletion_started_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM jam_public_blocks jb WHERE jb.user_id = s.author_id)
  AND (s.server_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM server_bans sb WHERE sb.server_id = s.server_id AND sb.user_id = s.author_id))
)`;

/** A track of a song, `t` being `jam_tracks`, is in the public version. */
export function publicTrackSql(t = "t"): string {
  return `(
  ${t}.deleted_at IS NULL
  AND ${t}.in_mix
  AND EXISTS (
    SELECT 1 FROM jam_public_tracks jpt
     WHERE jpt.track_id = ${t}.id AND jpt.removed_at IS NULL
       AND jpt.review_state IN ('none', 'approved'))
  AND EXISTS (
    SELECT 1 FROM jam_public_consents jpc
     WHERE jpc.song_id = ${t}.song_id AND jpc.user_id = ${t}.author_id
       AND jpc.choice IN ('yes', 'audio_only'))
  AND NOT EXISTS (
    SELECT 1 FROM users jtu WHERE jtu.id = ${t}.author_id AND jtu.deletion_started_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM jam_public_blocks jtb WHERE jtb.user_id = ${t}.author_id)
)`;
}

/**
 * A public track's VIDEO is public too: its author said `yes` (not
 * `audio_only`) and the frame scan passed on THIS object. Use only beside
 * `publicTrackSql`.
 */
export function publicVideoSql(t = "t"): string {
  return `(
  ${t}.video_key IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM jam_public_tracks jpv
     WHERE jpv.track_id = ${t}.id AND jpv.video_scan_status = 'passed'
       AND jpv.video_scan_key = ${t}.video_key)
  AND EXISTS (
    SELECT 1 FROM jam_public_consents jpvc
     WHERE jpvc.song_id = ${t}.song_id AND jpvc.user_id = ${t}.author_id AND jpvc.choice = 'yes')
)`;
}

/**
 * The cover object of song `s`, when it passed the image scanner, else NULL.
 * A scalar subquery, so it never multiplies rows.
 */
export const PUBLIC_COVER_KEY_SQL = `(
  SELECT cu.storage_key
    FROM jam_song_covers csc
    JOIN jam_uploads cu ON cu.id = csc.upload_id
    JOIN jam_public_cover_scans ccs ON ccs.upload_id = cu.id AND ccs.status = 'passed'
   WHERE csc.song_id = s.id
)`;

/** A song (`s`, with `p` and `su` joined) is listed: the song rule and at least one public part. */
export const LISTED_SONG_SQL = `(
  ${PUBLIC_SONG_SQL}
  AND EXISTS (SELECT 1 FROM jam_tracks lt WHERE lt.song_id = s.id AND ${publicTrackSql("lt")})
)`;
