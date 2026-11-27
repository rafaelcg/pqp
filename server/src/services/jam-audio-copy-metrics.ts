import { getPool } from "../db.js";
import { jamAudioCopyEnabled } from "./jam-audio-copy.js";

/**
 * `jamAudioCopy` on `GET /api/admin/metrics`: how far the Opus listening copy
 * of the jam stems has got, and what it saves. Read from the database on
 * purpose, like `jamVideo` and `voiceNotes`: the work runs on `pqp-worker`, a
 * different process from the API that answers this read, so an in-memory
 * counter on either would show a fraction of it and reset on every deploy.
 * The rows (`jam_tracks`, `speech_jobs` of kind `jam_audio_copy`) are the one
 * place every process writes.
 *
 * THE NUMBERS TO WATCH, in order:
 *   - `failed`: stems whose job gave up (three attempts, or a file that cannot
 *     be converted, or a copy whose length was not the original's). Each also
 *     logged `jamAudioCopy.failed` with its reason. The stem still plays, from
 *     its FLAC; it belongs at zero.
 *   - `queue.oldestQueuedSeconds`: climbing past a few minutes with `enabled`
 *     true means no worker with libopus is claiming (the API never does).
 *   - `waiting` falling: the backfill's progress. It moves a few stems a minute
 *     on purpose (`JAM_AUDIO_COPY_BACKFILL_PER_MINUTE`).
 *   - `bytes`: what a listener downloads now against before, over the stems
 *     that have a copy. `copy / original` is the saving.
 */

export interface JamAudioCopyMetrics {
  /** The runtime flag `jam_audio_copy`, as THIS process sees it. Off means nothing is queued, claimed or offered. */
  enabled: boolean;
  /** Live stems recorded as FLAC: the ones a copy is made for. */
  tracks: number;
  /** Of those, the ones with a confirmed copy. */
  withCopy: number;
  /** Settled with no copy on purpose (the copy would not be smaller). */
  skipped: number;
  /** No copy and the job gave up. Should be 0. */
  failed: number;
  /** No copy yet and the job is queued, running or not enqueued yet (the backfill's turn). */
  waiting: number;
  /** Over the stems that have a copy: the FLAC bytes and the copy's. */
  bytes: { original: number; copy: number };
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
    made: number;
    skipped: number;
    failed: number;
  };
}

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export async function jamAudioCopyMetrics(): Promise<JamAudioCopyMetrics> {
  const pool = getPool();
  const tracks = await pool.query<{
    tracks: string;
    with_copy: string;
    skipped: string;
    failed: string;
    original_bytes: string | null;
    copy_bytes: string | null;
  }>(
    `SELECT COUNT(*)::text AS tracks,
            COUNT(*) FILTER (WHERE t.audio_listen_content_type IS NOT NULL)::text AS with_copy,
            COUNT(*) FILTER (WHERE t.audio_listen_content_type IS NULL
                               AND j.status = 'done' AND j.last_error = 'not-smaller')::text AS skipped,
            COUNT(*) FILTER (WHERE t.audio_listen_content_type IS NULL AND j.status = 'failed')::text AS failed,
            SUM(t.audio_bytes) FILTER (WHERE t.audio_listen_content_type IS NOT NULL)::text AS original_bytes,
            SUM(t.audio_listen_bytes) FILTER (WHERE t.audio_listen_content_type IS NOT NULL)::text AS copy_bytes
       FROM jam_tracks t
       LEFT JOIN speech_jobs j ON j.kind = 'jam_audio_copy' AND j.track_id = t.id
      WHERE t.deleted_at IS NULL AND t.audio_content_type = 'audio/flac'`,
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
      WHERE status IN ('queued', 'running') AND kind = 'jam_audio_copy'`,
  );
  const settled = await pool.query<{ made: string; skipped: string; failed: string }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'done' AND last_error IS NULL)::text AS made,
            COUNT(*) FILTER (WHERE status = 'done' AND last_error IS NOT NULL)::text AS skipped,
            COUNT(*) FILTER (WHERE status = 'failed')::text AS failed
       FROM speech_jobs
      WHERE status IN ('done', 'failed') AND kind = 'jam_audio_copy'
        AND finished_at >= now() - interval '24 hours'`,
  );
  const t = tracks.rows[0];
  const l = live.rows[0];
  const s = settled.rows[0];
  const total = num(t?.tracks);
  const withCopy = num(t?.with_copy);
  const skipped = num(t?.skipped);
  const failed = num(t?.failed);
  return {
    enabled: jamAudioCopyEnabled(),
    tracks: total,
    withCopy,
    skipped,
    failed,
    waiting: Math.max(0, total - withCopy - skipped - failed),
    bytes: { original: num(t?.original_bytes), copy: num(t?.copy_bytes) },
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
