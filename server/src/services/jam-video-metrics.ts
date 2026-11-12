import { getPool } from "../db.js";

/**
 * `jamVideo` on `GET /api/admin/metrics`: do the camera videos of Jam takes
 * play on an iPhone. Read from the database on purpose, like `voiceNotes`:
 * the work runs on `pqp-worker`, a different process from the API that
 * answers this read, and an in-memory counter on either would show a fraction
 * of it and reset on every deploy. The rows (`jam_tracks`, `speech_jobs` of
 * kind `jam_video_transcode`) are the one place every process writes.
 *
 * THE NUMBER TO WATCH is `failed`: tracks whose video has no MP4 copy and
 * whose job gave up (three attempts), so an iPhone shows them with no picture.
 * It belongs at zero; each one also logged `jamVideo.transcode.failed` with
 * its reason. `oldestQueuedSeconds` climbing past a few minutes means no
 * worker with ffmpeg is claiming (the API process never does).
 */

export interface JamVideoMetrics {
  /** Live tracks that have a camera video. */
  videos: number;
  /** Of those, the ones with an MP4 copy: what an iPhone plays. */
  withCopy: number;
  /** Recorded as an MP4 phones already play (H.264 + AAC, `moov` first): no copy was needed. */
  alreadyPlayable: number;
  /** No copy and the job gave up: no picture on iOS and Safari. Should be 0. */
  failed: number;
  /** No copy yet and the job is queued, running or not enqueued yet (the backfill's turn). */
  waiting: number;
  queue: {
    queued: number;
    running: number;
    /** Of `queued`, the ones a failed attempt put back. */
    retrying: number;
    /** How long the oldest DUE job has waited, seconds; 0 when nothing is due. */
    oldestQueuedSeconds: number;
    /** `running` with an expired lease: a worker took it and died. */
    expiredLeases: number;
  };
  /** What settled in the last 24 hours, by `finished_at`. */
  jobs24h: {
    /** A copy was made (transcoded or remuxed). */
    made: number;
    /** Settled on purpose without one: already playable, or the track was gone. */
    skipped: number;
    failed: number;
  };
}

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export async function jamVideoMetrics(): Promise<JamVideoMetrics> {
  const pool = getPool();
  const tracks = await pool.query<{
    videos: string;
    with_copy: string;
    playable: string;
    failed: string;
  }>(
    `SELECT COUNT(*) FILTER (WHERE t.video_key IS NOT NULL)::text AS videos,
            COUNT(*) FILTER (WHERE t.video_mp4_content_type IS NOT NULL)::text AS with_copy,
            COUNT(*) FILTER (WHERE t.video_key IS NOT NULL AND t.video_mp4_content_type IS NULL
                               AND j.status = 'done' AND j.last_error = 'already-playable')::text AS playable,
            COUNT(*) FILTER (WHERE t.video_key IS NOT NULL AND t.video_mp4_content_type IS NULL
                               AND j.status = 'failed')::text AS failed
       FROM jam_tracks t
       LEFT JOIN speech_jobs j ON j.kind = 'jam_video_transcode' AND j.track_id = t.id
      WHERE t.deleted_at IS NULL`,
  );
  const live = await pool.query<{
    queued: string;
    running: string;
    retrying: string;
    oldest_due_seconds: string | null;
    expired_leases: string;
  }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'queued')::text AS queued,
            COUNT(*) FILTER (WHERE status = 'running')::text AS running,
            COUNT(*) FILTER (WHERE status = 'queued' AND attempts > 0)::text AS retrying,
            EXTRACT(EPOCH FROM now() - MIN(run_after) FILTER (
              WHERE status = 'queued' AND run_after <= now()
            ))::text AS oldest_due_seconds,
            COUNT(*) FILTER (WHERE status = 'running' AND lease_expires_at < now())::text AS expired_leases
       FROM speech_jobs
      WHERE status IN ('queued', 'running') AND kind = 'jam_video_transcode'`,
  );
  const settled = await pool.query<{ made: string; skipped: string; failed: string }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'done' AND last_error IS NULL)::text AS made,
            COUNT(*) FILTER (WHERE status = 'done' AND last_error IS NOT NULL)::text AS skipped,
            COUNT(*) FILTER (WHERE status = 'failed')::text AS failed
       FROM speech_jobs
      WHERE status IN ('done', 'failed') AND kind = 'jam_video_transcode'
        AND finished_at >= now() - interval '24 hours'`,
  );
  const t = tracks.rows[0];
  const l = live.rows[0];
  const s = settled.rows[0];
  const videos = num(t?.videos);
  const withCopy = num(t?.with_copy);
  const alreadyPlayable = num(t?.playable);
  const failed = num(t?.failed);
  return {
    videos,
    withCopy,
    alreadyPlayable,
    failed,
    waiting: Math.max(0, videos - withCopy - alreadyPlayable - failed),
    queue: {
      queued: num(l?.queued),
      running: num(l?.running),
      retrying: num(l?.retrying),
      oldestQueuedSeconds: Math.max(0, Math.round(num(l?.oldest_due_seconds))),
      expiredLeases: num(l?.expired_leases),
    },
    jobs24h: { made: num(s?.made), skipped: num(s?.skipped), failed: num(s?.failed) },
  };
}
