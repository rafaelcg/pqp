import type { NoteTranscriptStatus } from "@pqp/shared";
import { getPool } from "../db.js";
import { speechDailySeconds } from "./speech-jobs.js";
import { voiceNoteRefusals, type VoiceNoteRefusalReason } from "./voice-notes.js";

/**
 * `voiceNotes` on `GET /api/admin/metrics`: whether voice notes work, and how
 * much they are used.
 *
 * ALMOST ALL OF IT IS READ FROM THE DATABASE, on purpose. The work happens in
 * two processes (the API mints and sends, `pqp-worker` transcribes and
 * transcodes) on more than one machine, and an in-memory counter on any of
 * them would show a fraction of the picture and reset on every deploy. The
 * rows are the one place all of them write. The exception is `refusals`,
 * which counts requests the API turned away before anything was written, so
 * there is no row to read; those are per-instance since boot and summed by
 * the exporter like `calls`.
 *
 * COST. Every query is bounded by a time window with an index behind it
 * (`idx_message_attachment_voice_created`, `idx_voice_note_listens_listened`,
 * `idx_speech_jobs_finished`) or by the partial index of live jobs
 * (`idx_speech_jobs_due`), so none of them reads history. They run one after
 * another inside the 30 second cache, not in parallel with the rest of the
 * snapshot's fan-out.
 */

/** Per conversation kind. `dm` and `group` are conversations; `server` is a server channel. */
export interface VoiceNoteScopeCounts {
  dm: number;
  group: number;
  server: number;
}

export type VoiceNoteJobKindKey = "transcription" | "transcode";

/** The live part of one queue, from the partial index of unfinished jobs. */
export interface VoiceNoteQueueStats {
  /** Waiting for a worker, due or not (a retry in backoff is queued too). */
  queued: number;
  /** Claimed by a worker right now. */
  running: number;
  /** Of `queued`, the ones a failed attempt put back (attempts > 0). */
  retrying: number;
  /**
   * How long the oldest DUE job has been waiting, in seconds: now minus its
   * `run_after`, so a retry in backoff does not count until its backoff ends.
   * 0 when nothing is due. THE STUCK-WORKER NUMBER: a healthy worker claims
   * within its poll interval, so this climbing past a few minutes means the
   * worker is down, wedged or out of connections.
   */
  oldestQueuedSeconds: number;
  /**
   * `running` jobs whose lease already expired: a worker took them and died
   * (or is stalled past `SPEECH_JOB_LEASE_SECONDS`). They are reclaimed on the
   * next claim, so a value that stays above zero means nothing is claiming.
   */
  expiredLeases: number;
}

/** What settled in the last 24 hours, by `finished_at`. */
export interface VoiceNoteJobOutcomes {
  /** `done` with nothing in `last_error`: the work was actually done. */
  ok24h: number;
  /**
   * `done` WITH a `last_error`: settled on purpose without doing the work
   * (`gone` message deleted, `already` copy exists, `sender-declined`,
   * `over-budget`, `no-provider`). Not failures; kept out of the success rate
   * so a deleted message cannot make the worker look better or worse.
   */
  skipped24h: number;
  /** `failed`: attempts spent, or the object was missing. */
  failed24h: number;
  /**
   * ok / (ok + failed) over those 24 hours, 0..1; null when neither happened.
   * Skipped jobs are in neither side.
   */
  successRate24h: number | null;
  /**
   * Seconds from the job being queued to it settling OK, p50 and p95. It
   * includes the wait in the queue, which is the point: it is what the
   * listener experiences (a transcode: send until the AAC copy exists; a
   * transcription: send or request until the text exists). Null with no ok job.
   */
  p50Seconds: number | null;
  p95Seconds: number | null;
}

export interface VoiceNoteMetrics {
  usage: {
    /**
     * Voice notes that were MINTED (a row exists) in the window, sent or not.
     * The gap between this and `sent*` is notes recorded and thrown away,
     * uploads that failed, and notes whose message was later deleted. Windows
     * here and below are on mint time, which is seconds before the send.
     */
    minted24h: number;
    minted7d: number;
    /** Minted AND attached to a message (the message still exists). */
    sent24h: number;
    sent7d: number;
    /** `sent` split by where it went: dm, group conversation, server channel. */
    byScope24h: VoiceNoteScopeCounts;
    byScope7d: VoiceNoteScopeCounts;
    /**
     * `sent` by the container the recorder produced, parameters stripped:
     * `audio/mp4` (Safari and the native apps), `audio/webm` (Chromium and
     * Firefox), `audio/ogg`. Bounded to the three the mint accepts.
     */
    byContentType24h: Record<string, number>;
    byContentType7d: Record<string, number>;
    /** Distinct people who sent at least one note. */
    senders24h: number;
    senders7d: number;
    durationSeconds: {
      /** Of `sent` notes: the container's length where the worker read it, else the sender's claim. */
      total24h: number;
      total7d: number;
      median24h: number | null;
      median7d: number | null;
    };
    /** First plays recorded in the last 24 hours (a note played again by the same person is not a second one; the author's own play is never recorded). */
    listens24h: number;
    /** Distinct people behind those. */
    listeners24h: number;
    /** `sent7d` notes with at least one listen by somebody other than the author. */
    listenedNotes7d: number;
    /** listenedNotes7d / sent7d, 0..1; null when nothing was sent. Recent notes have had little time to be heard. */
    listenedShare7d: number | null;
  };
  health: {
    /** Unfinished jobs, right now. */
    queue: Record<VoiceNoteJobKindKey, VoiceNoteQueueStats>;
    /** Jobs that settled in the last 24 hours. */
    jobs: Record<VoiceNoteJobKindKey, VoiceNoteJobOutcomes>;
    /**
     * Where the `sent24h` notes stand now, by `transcript_status`. `none` is a
     * note nobody asked a transcript for (server channels, flag off, sender
     * declined). `pending` older than the job's p95 is a stuck one;
     * `unavailable` is no provider or the day's budget spent.
     */
    transcripts24h: Record<NoteTranscriptStatus, number>;
    /** Provider audio seconds, UTC day, shared by every worker. */
    budget: {
      /** `VOICE_STT_DAILY_SECONDS` as THIS process reads it; the worker enforces its own. */
      dailySeconds: number;
      usedSeconds: number;
      /** Provider calls billed today. */
      calls: number;
      /**
       * Jobs turned away today because the next note would not fit. Above zero
       * means the budget ran out and transcripts are `unavailable` until the
       * UTC day rolls over.
       */
      refused: number;
      /** usedSeconds / dailySeconds, 0..1+; null when the budget is 0 (nothing allowed). */
      usedShare: number | null;
      exhausted: boolean;
    };
  };
  /** Requests turned away before anything was stored. Per instance, since boot; the exporter sums them. */
  refusals: Record<VoiceNoteRefusalReason, number>;
}

const KINDS: Record<string, VoiceNoteJobKindKey> = {
  voice_note: "transcription",
  voice_transcode: "transcode",
};

function emptyQueue(): VoiceNoteQueueStats {
  return { queued: 0, running: 0, retrying: 0, oldestQueuedSeconds: 0, expiredLeases: 0 };
}

function emptyOutcomes(): VoiceNoteJobOutcomes {
  return {
    ok24h: 0,
    skipped24h: 0,
    failed24h: 0,
    successRate24h: null,
    p50Seconds: null,
    p95Seconds: null,
  };
}

function num(value: string | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function numOrNull(value: string | number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function round(value: number | null, digits = 1): number | null {
  if (value === null) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function share(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null;
}

export async function voiceNoteMetrics(): Promise<VoiceNoteMetrics> {
  const pool = getPool();

  // One pass over the notes minted in the last 7 days, the window every usage
  // figure shares. `d1` marks the last 24 hours inside it.
  const notes = await pool.query<Record<string, string | null>>(
    `WITH n AS (
       SELECT a.message_id IS NOT NULL AS sent,
              v.created_at >= now() - interval '24 hours' AS d1,
              a.uploader_id,
              c.kind,
              COALESCE(v.verified_duration_ms, v.duration_ms) AS ms,
              v.transcript_status,
              EXISTS (
                SELECT 1 FROM voice_note_listens l WHERE l.attachment_id = v.attachment_id
              ) AS listened
         FROM message_attachment_voice v
         JOIN message_attachments a ON a.id = v.attachment_id
         JOIN channels c ON c.id = a.channel_id
        WHERE v.created_at >= now() - interval '7 days'
     )
     SELECT COUNT(*) FILTER (WHERE d1)::text AS minted24h,
            COUNT(*)::text AS minted7d,
            COUNT(*) FILTER (WHERE sent AND d1)::text AS sent24h,
            COUNT(*) FILTER (WHERE sent)::text AS sent7d,
            COUNT(*) FILTER (WHERE sent AND d1 AND kind = 'dm')::text AS dm24h,
            COUNT(*) FILTER (WHERE sent AND d1 AND kind = 'group')::text AS group24h,
            COUNT(*) FILTER (WHERE sent AND d1 AND kind = 'server')::text AS server24h,
            COUNT(*) FILTER (WHERE sent AND kind = 'dm')::text AS dm7d,
            COUNT(*) FILTER (WHERE sent AND kind = 'group')::text AS group7d,
            COUNT(*) FILTER (WHERE sent AND kind = 'server')::text AS server7d,
            COUNT(DISTINCT uploader_id) FILTER (WHERE sent AND d1)::text AS senders24h,
            COUNT(DISTINCT uploader_id) FILTER (WHERE sent)::text AS senders7d,
            (COALESCE(SUM(ms) FILTER (WHERE sent AND d1), 0) / 1000.0)::text AS total24h,
            (COALESCE(SUM(ms) FILTER (WHERE sent), 0) / 1000.0)::text AS total7d,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) FILTER (WHERE sent AND d1) / 1000.0)::text AS median24h,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) FILTER (WHERE sent) / 1000.0)::text AS median7d,
            COUNT(*) FILTER (WHERE sent AND listened)::text AS listened7d,
            COUNT(*) FILTER (WHERE sent AND d1 AND transcript_status = 'none')::text AS t_none,
            COUNT(*) FILTER (WHERE sent AND d1 AND transcript_status = 'pending')::text AS t_pending,
            COUNT(*) FILTER (WHERE sent AND d1 AND transcript_status = 'done')::text AS t_done,
            COUNT(*) FILTER (WHERE sent AND d1 AND transcript_status = 'no_speech')::text AS t_no_speech,
            COUNT(*) FILTER (WHERE sent AND d1 AND transcript_status = 'failed')::text AS t_failed,
            COUNT(*) FILTER (WHERE sent AND d1 AND transcript_status = 'unavailable')::text AS t_unavailable
       FROM n`,
  );

  const types = await pool.query<{ content_type: string; n24h: string; n7d: string }>(
    `SELECT split_part(a.content_type, ';', 1) AS content_type,
            COUNT(*) FILTER (WHERE v.created_at >= now() - interval '24 hours')::text AS n24h,
            COUNT(*)::text AS n7d
       FROM message_attachment_voice v
       JOIN message_attachments a ON a.id = v.attachment_id
      WHERE v.created_at >= now() - interval '7 days'
        AND a.message_id IS NOT NULL
      GROUP BY 1`,
  );

  const listens = await pool.query<{ listens: string; listeners: string }>(
    `SELECT COUNT(*)::text AS listens, COUNT(DISTINCT user_id)::text AS listeners
       FROM voice_note_listens
      WHERE listened_at >= now() - interval '24 hours'`,
  );

  const live = await pool.query<{
    kind: string;
    queued: string;
    running: string;
    retrying: string;
    oldest_due_seconds: string | null;
    expired_leases: string;
  }>(
    `SELECT kind,
            COUNT(*) FILTER (WHERE status = 'queued')::text AS queued,
            COUNT(*) FILTER (WHERE status = 'running')::text AS running,
            COUNT(*) FILTER (WHERE status = 'queued' AND attempts > 0)::text AS retrying,
            EXTRACT(EPOCH FROM now() - MIN(run_after) FILTER (
              WHERE status = 'queued' AND run_after <= now()
            ))::text AS oldest_due_seconds,
            COUNT(*) FILTER (WHERE status = 'running' AND lease_expires_at < now())::text AS expired_leases
       FROM speech_jobs
      WHERE status IN ('queued', 'running')
        AND kind IN ('voice_note', 'voice_transcode')
      GROUP BY kind`,
  );

  const settled = await pool.query<{
    kind: string;
    ok: string;
    skipped: string;
    failed: string;
    p50: string | null;
    p95: string | null;
  }>(
    `SELECT kind,
            COUNT(*) FILTER (WHERE status = 'done' AND last_error IS NULL)::text AS ok,
            COUNT(*) FILTER (WHERE status = 'done' AND last_error IS NOT NULL)::text AS skipped,
            COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
            percentile_cont(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM finished_at - created_at)
            ) FILTER (WHERE status = 'done' AND last_error IS NULL)::text AS p50,
            percentile_cont(0.95) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM finished_at - created_at)
            ) FILTER (WHERE status = 'done' AND last_error IS NULL)::text AS p95
       FROM speech_jobs
      WHERE status IN ('done', 'failed')
        AND finished_at >= now() - interval '24 hours'
        AND kind IN ('voice_note', 'voice_transcode')
      GROUP BY kind`,
  );

  const budget = await pool.query<{ seconds: number; calls: number; refused: number }>(
    `SELECT seconds, calls, refused
       FROM speech_usage_daily
      WHERE day = (now() AT TIME ZONE 'UTC')::date`,
  );

  const row = notes.rows[0] ?? {};
  const sent7d = num(row.sent7d);
  const listenedNotes7d = num(row.listened7d);

  const byContentType24h: Record<string, number> = {};
  const byContentType7d: Record<string, number> = {};
  for (const t of types.rows) {
    if (num(t.n24h) > 0) byContentType24h[t.content_type] = num(t.n24h);
    byContentType7d[t.content_type] = num(t.n7d);
  }

  const queue: Record<VoiceNoteJobKindKey, VoiceNoteQueueStats> = {
    transcription: emptyQueue(),
    transcode: emptyQueue(),
  };
  for (const r of live.rows) {
    const key = KINDS[r.kind];
    if (!key) continue;
    queue[key] = {
      queued: num(r.queued),
      running: num(r.running),
      retrying: num(r.retrying),
      oldestQueuedSeconds: Math.max(0, Math.round(num(r.oldest_due_seconds))),
      expiredLeases: num(r.expired_leases),
    };
  }

  const jobs: Record<VoiceNoteJobKindKey, VoiceNoteJobOutcomes> = {
    transcription: emptyOutcomes(),
    transcode: emptyOutcomes(),
  };
  for (const r of settled.rows) {
    const key = KINDS[r.kind];
    if (!key) continue;
    const ok = num(r.ok);
    const failed = num(r.failed);
    jobs[key] = {
      ok24h: ok,
      skipped24h: num(r.skipped),
      failed24h: failed,
      successRate24h: share(ok, ok + failed),
      p50Seconds: round(numOrNull(r.p50)),
      p95Seconds: round(numOrNull(r.p95)),
    };
  }

  const dailySeconds = speechDailySeconds();
  const usedSeconds = budget.rows[0]?.seconds ?? 0;
  const refused = budget.rows[0]?.refused ?? 0;

  return {
    usage: {
      minted24h: num(row.minted24h),
      minted7d: num(row.minted7d),
      sent24h: num(row.sent24h),
      sent7d,
      byScope24h: { dm: num(row.dm24h), group: num(row.group24h), server: num(row.server24h) },
      byScope7d: { dm: num(row.dm7d), group: num(row.group7d), server: num(row.server7d) },
      byContentType24h,
      byContentType7d,
      senders24h: num(row.senders24h),
      senders7d: num(row.senders7d),
      durationSeconds: {
        total24h: Math.round(num(row.total24h)),
        total7d: Math.round(num(row.total7d)),
        median24h: round(numOrNull(row.median24h)),
        median7d: round(numOrNull(row.median7d)),
      },
      listens24h: num(listens.rows[0]?.listens),
      listeners24h: num(listens.rows[0]?.listeners),
      listenedNotes7d,
      listenedShare7d: share(listenedNotes7d, sent7d),
    },
    health: {
      queue,
      jobs,
      transcripts24h: {
        none: num(row.t_none),
        pending: num(row.t_pending),
        done: num(row.t_done),
        no_speech: num(row.t_no_speech),
        failed: num(row.t_failed),
        unavailable: num(row.t_unavailable),
      },
      budget: {
        dailySeconds,
        usedSeconds,
        calls: budget.rows[0]?.calls ?? 0,
        refused,
        usedShare: dailySeconds > 0 ? Math.round((usedSeconds / dailySeconds) * 1000) / 1000 : null,
        exhausted: refused > 0,
      },
    },
    refusals: voiceNoteRefusals(),
  };
}
