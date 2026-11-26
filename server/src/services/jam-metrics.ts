import { getPool } from "../db.js";

/**
 * `jam` on `GET /api/admin/metrics`: does Jam work. Activation, first take,
 * publish and return, private and public together unless a field says
 * otherwise. Computed from the tables jam already writes (`jam_songs`,
 * `jam_tracks`, `jam_track_votes`, `channels`, `jam_public_songs`,
 * `jam_public_tracks`): no table, no write and no per-request counter of its
 * own, so it is the same on every replica and survives every deploy.
 *
 * Every count is of LIVE rows: a soft-deleted song or take (`deleted_at`) is
 * not counted, and deleting a song soft-deletes its takes. The one place a
 * deleted row is read on purpose is `firstTakers7d`, said in its comment.
 *
 * There are no targets here. There is no baseline to set them against: read a
 * week of this block, then decide (`tools/admin-dashboard/README.md`, "Jam
 * numbers").
 */

export interface JamMetrics {
  /** Channels of type `jam`. Channels are hard-deleted, so every row is live. */
  jamChannels: number;
  /** Distinct servers holding at least one jam channel. */
  serversWithJam: number;
  songs: {
    /** Live songs created in the last 24 hours, in a jam channel or standalone. */
    created24h: number;
    /** Live songs created in the last 7 days. */
    created7d: number;
    /** Every live song. */
    live: number;
  };
  takes: {
    /** Live takes (tracks) posted in the last 24 hours, whoever posted them. */
    posted24h: number;
    /** Live takes posted in the last 7 days. */
    posted7d: number;
    /** Every live take. */
    live: number;
    /** Of `posted7d`, the ones that carry a camera video. */
    withVideo7d: number;
  };
  recorders: {
    /** Distinct accounts with a live take posted in the last 7 days. */
    distinct7d: number;
    /** Distinct accounts with a live take posted in the last 30 days. */
    distinct30d: number;
  };
  /**
   * Accounts with a live take in the last 7 days and NO take of any kind
   * before that window: their first take ever fell inside it. Deleted takes
   * count when deciding "first ever": a person who recorded and deleted a take
   * 10 days ago has already tried it, so their next take is a return, not a
   * first. A deleted take INSIDE the window does not disqualify: their first
   * ever is still in the last 7 days. Always at most `recorders.distinct7d`
   * (same statement, same snapshot).
   */
  firstTakers7d: number;
  /**
   * Accounts with a live take in the last 7 days AND a live take in the 7 days
   * before that (days 8 to 14 ago). The return the launch is judged on.
   */
  returningRecorders7d: number;
  /** Public jams (`jam_public`). All zero while nothing is published. */
  public: {
    /**
     * Songs whose FIRST publish was in the last 7 days and that are still
     * public: not unpublished, not removed by an operator, not deleted. Held
     * for review or hidden by reports still count (a new account's first
     * publish waits in review and is the activation we want to see).
     */
    firstPublished7d: number;
    /**
     * Live takes from somebody other than the starter, received through public
     * access in the last 7 days (`jam_public_tracks.outside`), minus the ones an
     * operator removed from the public version.
     */
    outsideTakes7d: number;
    /**
     * Of `outsideTakes7d`, the ones in the mix now: the starter put them in, or
     * auto-accept did. A starter who takes one back out lowers this, which is
     * the honest reading of "admitted" (the schema keeps no separate event).
     */
    outsideTakesAdmitted7d: number;
  };
  /** Votes cast in the last 7 days on takes that are still live (`jam_track_votes.created_at`). */
  votes7d: number;
}

async function inSequence<T extends Array<() => Promise<unknown>>>(
  thunks: [...T],
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const out: unknown[] = [];
  for (const thunk of thunks) out.push(await thunk());
  return out as { [K in keyof T]: Awaited<ReturnType<T[K]>> };
}

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export async function jamMetrics(): Promise<JamMetrics> {
  const pool = getPool();
  // One after another, not Promise.all: the payload is cached and these are
  // cold-path reads, so they take one pooled connection at a time rather than
  // eight at once next to the rest of the dashboard's queries.
  const [channels, songs, takesLive, takesRecent, publicSongs, outside, votes] =
    await inSequence([
      () => pool.query<{ channels: string; servers: string }>(
        `SELECT COUNT(*)::text AS channels, COUNT(DISTINCT server_id)::text AS servers
           FROM channels
          WHERE type = 'jam'`,
      ),
      () => pool.query<{ created24h: string; created7d: string; live: string }>(
        `SELECT COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')::text AS created24h,
                COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::text AS created7d,
                COUNT(*)::text AS live
           FROM jam_songs
          WHERE deleted_at IS NULL`,
      ),
      () => pool.query<{ live: string }>(
        `SELECT COUNT(*)::text AS live FROM jam_tracks WHERE deleted_at IS NULL`,
      ),
      // ONE statement for everything about recorders, so the numbers are from
      // one snapshot (`firstTakers7d <= distinct7d` cannot be broken by a take
      // committing between two reads). It groups the last 30 days of live takes
      // by author first, so what is held is one small row per person, not one
      // per take. "No take before" is an index probe per author
      // (`idx_jam_tracks_author`), only for people with a take this week, and
      // deliberately does not filter `deleted_at`.
      () => pool.query<{
        posted24h: string;
        posted7d: string;
        with_video7d: string;
        distinct7d: string;
        distinct30d: string;
        returning7d: string;
        first_takers7d: string;
      }>(
        `WITH per_author AS (
           SELECT author_id,
                  COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours') AS n24h,
                  COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days') AS n7d,
                  COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days'
                                     AND video_key IS NOT NULL) AS video7d,
                  COALESCE(BOOL_OR(created_at >= now() - interval '14 days'
                                   AND created_at < now() - interval '7 days'), FALSE) AS prev_week
             FROM jam_tracks
            WHERE deleted_at IS NULL AND created_at >= now() - interval '30 days'
            GROUP BY author_id
         )
         SELECT COALESCE(SUM(n24h), 0)::text AS posted24h,
                COALESCE(SUM(n7d), 0)::text AS posted7d,
                COALESCE(SUM(video7d), 0)::text AS with_video7d,
                COUNT(*) FILTER (WHERE n7d > 0)::text AS distinct7d,
                COUNT(*)::text AS distinct30d,
                COUNT(*) FILTER (WHERE n7d > 0 AND prev_week)::text AS returning7d,
                COUNT(*) FILTER (WHERE n7d > 0 AND NOT EXISTS (
                  SELECT 1 FROM jam_tracks p
                   WHERE p.author_id = per_author.author_id
                     AND p.created_at < now() - interval '7 days'
                ))::text AS first_takers7d
           FROM per_author`,
      ),
      () => pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM jam_public_songs ps
           JOIN jam_songs s ON s.id = ps.song_id
          WHERE ps.first_published_at >= now() - interval '7 days'
            AND ps.unpublished_at IS NULL AND ps.removed_at IS NULL
            AND s.deleted_at IS NULL`,
      ),
      () => pool.query<{ received: string; admitted: string }>(
        `SELECT COUNT(*)::text AS received,
                COUNT(*) FILTER (WHERE t.in_mix)::text AS admitted
           FROM jam_public_tracks pt
           JOIN jam_tracks t ON t.id = pt.track_id
          WHERE pt.outside AND pt.removed_at IS NULL AND t.deleted_at IS NULL
            AND pt.created_at >= now() - interval '7 days'`,
      ),
      () => pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM jam_track_votes v
           JOIN jam_tracks t ON t.id = v.track_id
          WHERE v.created_at >= now() - interval '7 days' AND t.deleted_at IS NULL`,
      ),
    ]);
  const c = channels.rows[0];
  const s = songs.rows[0];
  const r = takesRecent.rows[0];
  const o = outside.rows[0];
  return {
    jamChannels: num(c?.channels),
    serversWithJam: num(c?.servers),
    songs: { created24h: num(s?.created24h), created7d: num(s?.created7d), live: num(s?.live) },
    takes: {
      posted24h: num(r?.posted24h),
      posted7d: num(r?.posted7d),
      live: num(takesLive.rows[0]?.live),
      withVideo7d: num(r?.with_video7d),
    },
    recorders: { distinct7d: num(r?.distinct7d), distinct30d: num(r?.distinct30d) },
    firstTakers7d: num(r?.first_takers7d),
    returningRecorders7d: num(r?.returning7d),
    public: {
      firstPublished7d: num(publicSongs.rows[0]?.count),
      outsideTakes7d: num(o?.received),
      outsideTakesAdmitted7d: num(o?.admitted),
    },
    votes7d: num(votes.rows[0]?.count),
  };
}
