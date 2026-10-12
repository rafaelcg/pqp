import { getPool } from "../db.js";

/**
 * Stories on `GET /api/admin/metrics` (`stories`): this process's counters
 * plus a deployment-wide read of the tables, cached for 30 s. The questions
 * it answers are the ones the design judges the feature by: is posting
 * spreading or concentrated (the Fleets failure), is watching worth it, do
 * replies start conversations, and is the 24 h promise kept (sweep lag,
 * live bytes, delete failures).
 */

const stats = {
  published: 0,
  views: 0,
  reactions: 0,
  replies: 0,
  imagesScanned: 0,
  framesScanned: 0,
  scanRejected: 0,
  scanErrored: 0,
  scanFlagged: 0,
  videosProcessed: 0,
  videosRefused: 0,
  videoFailures: 0,
  removedByStaff: 0,
  removedEverywhere: 0,
  mediaDeleted: 0,
  mediaDeleteFailures: 0,
  rowsDeleted: 0,
  orphansDeleted: 0,
  framesSent: 0,
};

export type StoryCounter = keyof typeof stats;

export function bumpStoryStat(key: StoryCounter, by = 1): void {
  stats[key] += by;
}

export function resetStoryStatsForTests(): void {
  for (const key of Object.keys(stats) as StoryCounter[]) {
    stats[key] = 0;
  }
  cached = null;
}

export interface StoriesMetrics {
  /** Since this process started. The sweep and the video job run on the worker when there is one. */
  process: typeof stats;
  /** Deployment wide, from the database. Null when the read failed. */
  db: {
    posters24h: number;
    posters7d: number;
    stories24h: { total: number; image: number; video: number; text: number; call: number };
    audiences24h: { server: number; friends: number };
    /** Share of the last 7 days' stories posted by the 10 most active authors, 0..1. */
    posterConcentration7d: number | null;
    viewersPerStory24h: { p50: number; p90: number };
    openers24h: number;
    reactions24h: number;
    replies24h: number;
    /** Replies in the last 7 days, and how many got an answer within 24 h. */
    replyConversations7d: { replies: number; answered: number };
    /** Authors who posted 7 to 14 days ago, and how many of them posted again since. */
    posterRepeat7d: { base: number; repeated: number };
    live: number;
    processing: number;
    liveBytes: number;
    reports24h: number;
    openReports: number;
    removals24h: number;
    scanRejects24h: number;
    held: number;
    heldBytes: number;
    /** Seconds since the oldest story whose bytes should be gone already expired. */
    sweepLagSeconds: number;
  } | null;
}

let cached: { at: number; value: StoriesMetrics["db"] } | null = null;

async function readDb(): Promise<StoriesMetrics["db"]> {
  const pool = getPool();
  const result = await pool.query<Record<string, string | null>>(
    `WITH recent AS (
       SELECT s.* FROM stories s WHERE s.published_at > now() - interval '24 hours'
     ),
     week AS (
       SELECT author_id, COUNT(*) AS n FROM stories
        WHERE published_at > now() - interval '7 days'
        GROUP BY author_id
     ),
     per_story AS (
       SELECT r.id, (SELECT COUNT(*) FROM story_views v WHERE v.story_id = r.id) AS viewers
         FROM recent r
     ),
     replies AS (
       SELECT m.id, m.channel_id, m.author_id, m.created_at FROM messages m
        WHERE m.story_id IS NOT NULL AND m.created_at > now() - interval '7 days'
     ),
     held AS (
       SELECT s.id, s.media_byte_size FROM stories s
        WHERE s.media_deleted_at IS NULL AND s.media_storage_key IS NOT NULL
          AND (s.hold_forever OR s.hold_until > now()
               OR EXISTS (SELECT 1 FROM reports r WHERE r.reported_story_id = s.id
                           AND (r.status = 'open' OR r.resolved_at > now() - interval '30 days')))
     )
     SELECT
       (SELECT COUNT(DISTINCT author_id) FROM recent)::text AS posters24h,
       (SELECT COUNT(*) FROM week)::text AS posters7d,
       (SELECT COUNT(*) FROM recent)::text AS stories24h,
       (SELECT COUNT(*) FROM recent WHERE kind = 'image')::text AS image24h,
       (SELECT COUNT(*) FROM recent WHERE kind = 'video')::text AS video24h,
       (SELECT COUNT(*) FROM recent WHERE kind = 'text')::text AS text24h,
       (SELECT COUNT(*) FROM recent WHERE sticker->>'type' = 'call')::text AS call24h,
       (SELECT COUNT(*) FROM story_audiences a JOIN recent r ON r.id = a.story_id
         WHERE a.server_id IS NOT NULL)::text AS server24h,
       (SELECT COUNT(*) FROM story_audiences a JOIN recent r ON r.id = a.story_id
         WHERE a.server_id IS NULL)::text AS friends24h,
       (SELECT CASE WHEN SUM(n) > 0 THEN
          (SELECT SUM(n) FROM (SELECT n FROM week ORDER BY n DESC LIMIT 10) top)::float / SUM(n)
        END FROM week)::text AS concentration,
       (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY viewers) FROM per_story)::text AS p50,
       (SELECT percentile_disc(0.9) WITHIN GROUP (ORDER BY viewers) FROM per_story)::text AS p90,
       (SELECT COUNT(DISTINCT viewer_id) FROM story_views
         WHERE viewed_at > now() - interval '24 hours')::text AS openers24h,
       (SELECT COUNT(*) FROM story_views
         WHERE reacted_at > now() - interval '24 hours')::text AS reactions24h,
       (SELECT COUNT(*) FROM story_views
         WHERE replied_at > now() - interval '24 hours')::text AS replies24h,
       (SELECT COUNT(*) FROM replies)::text AS replies7d,
       (SELECT COUNT(*) FROM replies rp WHERE EXISTS (
          SELECT 1 FROM messages a WHERE a.channel_id = rp.channel_id
             AND a.author_id <> rp.author_id
             AND a.created_at > rp.created_at
             AND a.created_at <= rp.created_at + interval '24 hours'))::text AS answered7d,
       (SELECT COUNT(DISTINCT author_id) FROM stories
         WHERE published_at > now() - interval '14 days'
           AND published_at <= now() - interval '7 days')::text AS repeat_base,
       (SELECT COUNT(DISTINCT b.author_id) FROM stories b
         WHERE b.published_at > now() - interval '14 days'
           AND b.published_at <= now() - interval '7 days'
           AND EXISTS (SELECT 1 FROM stories c WHERE c.author_id = b.author_id
                        AND c.published_at > now() - interval '7 days'))::text AS repeated,
       (SELECT COUNT(*) FROM stories WHERE status = 'live' AND expires_at > now())::text AS live,
       (SELECT COUNT(*) FROM stories WHERE status = 'processing')::text AS processing,
       (SELECT COALESCE(SUM(media_byte_size), 0) FROM stories
         WHERE media_deleted_at IS NULL AND media_storage_key IS NOT NULL)::text AS live_bytes,
       (SELECT COUNT(*) FROM reports WHERE subject_type = 'story'
         AND created_at > now() - interval '24 hours')::text AS reports24h,
       (SELECT COUNT(*) FROM reports WHERE subject_type = 'story' AND status = 'open')::text AS open_reports,
       (SELECT COUNT(*) FROM story_audiences
         WHERE removed_at > now() - interval '24 hours')::text AS removals24h,
       (SELECT COUNT(*) FROM stories WHERE scan_status = 'rejected'
         AND scanned_at > now() - interval '24 hours')::text AS rejects24h,
       (SELECT COUNT(*) FROM held)::text AS held,
       (SELECT COALESCE(SUM(media_byte_size), 0) FROM held)::text AS held_bytes,
       (SELECT EXTRACT(EPOCH FROM now() - MIN(COALESCE(s.deleted_at, s.expires_at)))
          FROM stories s
         WHERE s.media_deleted_at IS NULL AND s.media_storage_key IS NOT NULL
           AND (s.status IN ('expired', 'deleted') OR s.expires_at <= now())
           AND NOT EXISTS (SELECT 1 FROM held h WHERE h.id = s.id))::text AS lag`,
  );
  const row = result.rows[0] ?? {};
  const n = (key: string) => Number(row[key] ?? 0) || 0;
  return {
    posters24h: n("posters24h"),
    posters7d: n("posters7d"),
    stories24h: {
      total: n("stories24h"),
      image: n("image24h"),
      video: n("video24h"),
      text: n("text24h"),
      call: n("call24h"),
    },
    audiences24h: { server: n("server24h"), friends: n("friends24h") },
    posterConcentration7d: row.concentration == null ? null : Number(row.concentration),
    viewersPerStory24h: { p50: n("p50"), p90: n("p90") },
    openers24h: n("openers24h"),
    reactions24h: n("reactions24h"),
    replies24h: n("replies24h"),
    replyConversations7d: { replies: n("replies7d"), answered: n("answered7d") },
    posterRepeat7d: { base: n("repeat_base"), repeated: n("repeated") },
    live: n("live"),
    processing: n("processing"),
    liveBytes: n("live_bytes"),
    reports24h: n("reports24h"),
    openReports: n("open_reports"),
    removals24h: n("removals24h"),
    scanRejects24h: n("rejects24h"),
    held: n("held"),
    heldBytes: n("held_bytes"),
    sweepLagSeconds: Math.max(0, Math.round(n("lag"))),
  };
}

export async function storiesMetrics(): Promise<StoriesMetrics> {
  let db: StoriesMetrics["db"] = null;
  if (cached && Date.now() - cached.at < 30_000) {
    db = cached.value;
  } else {
    try {
      db = await readDb();
      cached = { at: Date.now(), value: db };
    } catch (error) {
      // The metrics page must not fail because this block could not be read.
      console.error(
        "[stories] metrics read failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { process: { ...stats }, db };
}
