import type { PoolClient } from "pg";
import { getPool } from "../db.js";
import { INSTANCE_ID } from "../lib/bus.js";

/**
 * The `speech_jobs` queue (schema.sql has the table and why it is shaped the
 * way it is). This file is only the queue: enqueue, claim with a lease,
 * finish, retry, and the shared daily budget. What a job DOES is in
 * `speech-worker.ts`; what gets enqueued and when is in
 * `voice-transcription.ts`.
 *
 * The rules:
 *
 *   * ENQUEUE IS A ROW AND A NOTIFY, NOTHING ELSE, so it can run inside the
 *     transaction that creates the message. `pg_notify` is transactional: it
 *     is delivered at COMMIT and never for a rollback, and it is not a
 *     network call from this process.
 *   * CLAIM IS `FOR UPDATE SKIP LOCKED` PLUS A LEASE. Any number of workers
 *     poll; each row goes to one. A worker that dies leaves `running` with a
 *     lease in the past, and the next claim takes it. `attempts` counts claims,
 *     so a job that kills its worker every time still runs out.
 *   * FINISHING IS FENCED by `leased_by`: a worker whose lease expired and was
 *     taken over cannot settle the job the new owner is running.
 */

export type SpeechJobKind =
  | "voice_note"
  | "voice_transcode"
  | "party_question"
  /** Automatic subtitles of an uploaded Baú video; keyed by `post_id`, not an attachment. */
  | "community_home_captions";

/** Postgres LISTEN channel the enqueue NOTIFYs and the poller listens on. */
export const SPEECH_JOBS_CHANNEL = "pqp_speech_job_due";

/**
 * A claim not settled in this long belongs to a dead worker. Longer than a
 * provider call with its retries (Workers AI gives up at 30 s) plus a download
 * and a transcode of a five minute note, by a wide margin, because a lease
 * that expires under a live worker means paying the provider twice.
 */
export const SPEECH_JOB_LEASE_SECONDS = 180;
/**
 * A Baú video is up to 100 MiB and its sound up to
 * `COMMUNITY_HOME_CAPTIONS_MAX_SECONDS`: a download, one ffmpeg pass and one
 * provider call per 30 s window, in sequence. The job aborts itself well
 * before this (`community-home-captions-worker.ts`), so the lease only ever
 * runs out under a worker that died.
 */
export const CAPTIONS_JOB_LEASE_SECONDS = 1_800;
/** Claims per job before it is given up on. */
export const SPEECH_JOB_MAX_ATTEMPTS = 3;
const RETRY_BASE_SECONDS = 30;

export interface SpeechJob {
  id: string;
  kind: SpeechJobKind;
  attachment_id: string | null;
  /** Set for `community_home_captions` only. */
  post_id: string | null;
  attempts: number;
  language_hint: string | null;
  leased_by: string;
}

type Queryable = Pick<PoolClient, "query">;

/**
 * Queue a job. Idempotent per (kind, attachment) and per (kind, post): a second enqueue of the same
 * note is a no-op and answers false, which is how an eager enqueue and a lazy
 * request racing each other end up as one job.
 */
export async function enqueueSpeechJob(
  db: Queryable,
  job: {
    kind: SpeechJobKind;
    /** Exactly one of these two: a voice note's attachment, or a Baú post. */
    attachmentId?: string;
    postId?: string;
    languageHint?: string | null;
    /**
     * Also put a SETTLED job back in the queue, if it settled at least this
     * many seconds ago. For a re-request after "unavailable" (no provider
     * then, or the day's budget spent); the cooldown is what stops a button
     * from becoming a loop. Omitted, a settled job stays settled.
     */
    requeueSettledAfterSeconds?: number;
  },
): Promise<boolean> {
  const byPost = job.postId !== undefined;
  if (byPost === (job.attachmentId !== undefined)) {
    throw new Error("enqueueSpeechJob needs exactly one of attachmentId and postId");
  }
  const column = byPost ? "post_id" : "attachment_id";
  const requeue = job.requeueSettledAfterSeconds;
  const inserted = await db.query(
    `INSERT INTO speech_jobs (kind, ${column}, language_hint)
     VALUES ($1, $2, $3)
     ON CONFLICT (kind, ${column}) WHERE ${column} IS NOT NULL
     ${
       requeue === undefined
         ? "DO NOTHING"
         : `DO UPDATE
       SET status = 'queued', attempts = 0, run_after = NOW(), leased_by = NULL,
           lease_expires_at = NULL, finished_at = NULL, last_error = NULL,
           language_hint = COALESCE(EXCLUDED.language_hint, speech_jobs.language_hint)
     WHERE speech_jobs.status IN ('done', 'failed')
       AND speech_jobs.finished_at <= NOW() - make_interval(secs => $4::double precision)`
     }
     RETURNING id`,
    requeue === undefined
      ? [job.kind, byPost ? job.postId : job.attachmentId, job.languageHint ?? null]
      : [job.kind, byPost ? job.postId : job.attachmentId, job.languageHint ?? null, requeue],
  );
  if ((inserted.rowCount ?? 0) === 0) {
    return false;
  }
  await db.query(`SELECT pg_notify($1, '')`, [SPEECH_JOBS_CHANNEL]);
  return true;
}

/**
 * Claim up to `limit` due jobs of the given kinds. Due means queued and past
 * `run_after`, or running with an expired lease (a dead worker's).
 */
export async function claimSpeechJobs(
  kinds: readonly SpeechJobKind[],
  limit: number,
  owner: string = INSTANCE_ID,
): Promise<SpeechJob[]> {
  if (kinds.length === 0 || limit <= 0) {
    return [];
  }
  // A job whose worker died on its LAST attempt is not reclaimed: it is
  // failed here, so a job that crashes its worker every time stops instead
  // of being taken up again every lease, forever. Its note, if it was waiting
  // for a transcript, is failed with it.
  await getPool().query(
    `WITH exhausted AS (
       UPDATE speech_jobs
          SET status = 'failed', finished_at = NOW(), lease_expires_at = NULL,
              last_error = COALESCE(last_error, 'lease expired on the last attempt')
        WHERE kind = ANY($1::text[])
          AND status = 'running' AND lease_expires_at < NOW()
          AND attempts >= $2
        RETURNING kind, attachment_id
     )
     UPDATE message_attachment_voice v
        SET transcript_status = 'failed'
       FROM exhausted e
      WHERE e.kind = 'voice_note' AND v.attachment_id = e.attachment_id
        AND v.transcript_status = 'pending'`,
    [kinds, SPEECH_JOB_MAX_ATTEMPTS],
  );
  const claimed = await getPool().query<SpeechJob>(
    `WITH due AS (
       SELECT id FROM speech_jobs
        WHERE kind = ANY($1::text[])
          AND ((status = 'queued' AND run_after <= NOW())
            OR (status = 'running' AND lease_expires_at < NOW()
                AND attempts < ${SPEECH_JOB_MAX_ATTEMPTS}))
        ORDER BY run_after, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE speech_jobs j
        SET status = 'running',
            leased_by = $3,
            lease_expires_at = NOW() + make_interval(secs => CASE
              WHEN j.kind = 'community_home_captions' THEN $5::double precision
              ELSE $4::double precision END),
            attempts = j.attempts + 1
       FROM due
      WHERE j.id = due.id
      RETURNING j.id::text AS id, j.kind, j.attachment_id, j.post_id, j.attempts,
                j.language_hint, j.leased_by`,
    [kinds, limit, owner, SPEECH_JOB_LEASE_SECONDS, CAPTIONS_JOB_LEASE_SECONDS],
  );
  return claimed.rows;
}

/**
 * Settle a job this worker still holds. Returns false when it no longer does
 * (its lease ran out and somebody else took it): the caller must then write
 * nothing else, because the result is the new owner's to write.
 */
export async function finishSpeechJob(
  db: Queryable,
  job: SpeechJob,
  outcome: "done" | "failed",
  error?: string | null,
): Promise<boolean> {
  const settled = await db.query(
    `UPDATE speech_jobs
        SET status = $3, finished_at = NOW(), lease_expires_at = NULL,
            last_error = $4
      WHERE id = $1 AND leased_by = $2 AND status = 'running'
      RETURNING id`,
    [job.id, job.leased_by, outcome, error?.slice(0, 500) ?? null],
  );
  return (settled.rowCount ?? 0) > 0;
}

/**
 * Hand a failed attempt back to the queue with backoff, or give up once the
 * attempts are spent. Answers which, so the caller knows whether to write a
 * final `failed`.
 */
export async function retrySpeechJobLater(
  job: SpeechJob,
  error: string,
): Promise<"retrying" | "gave-up" | "lost"> {
  if (job.attempts >= SPEECH_JOB_MAX_ATTEMPTS) {
    return "gave-up";
  }
  const delay = RETRY_BASE_SECONDS * 2 ** (job.attempts - 1);
  const updated = await getPool().query(
    `UPDATE speech_jobs
        SET status = 'queued', run_after = NOW() + make_interval(secs => $3::double precision),
            leased_by = NULL, lease_expires_at = NULL, last_error = $4
      WHERE id = $1 AND leased_by = $2 AND status = 'running'
      RETURNING id`,
    [job.id, job.leased_by, delay, error.slice(0, 500)],
  );
  return (updated.rowCount ?? 0) > 0 ? "retrying" : "lost";
}

/** Drop a job outright (the flag went off before it ran). Fenced like the rest. */
export async function dropSpeechJob(db: Queryable, job: SpeechJob): Promise<boolean> {
  const dropped = await db.query(
    `DELETE FROM speech_jobs WHERE id = $1 AND leased_by = $2 AND status = 'running'`,
    [job.id, job.leased_by],
  );
  return (dropped.rowCount ?? 0) > 0;
}

// ------------------------------------------------------------------- budget

const DEFAULT_DAILY_SECONDS = 36_000;

/**
 * `VOICE_STT_DAILY_SECONDS`: audio seconds the deployment may send to the
 * provider per UTC day, all workers together. 0 is a real answer (nothing).
 * Ten hours by default: at Workers AI's price that is about USD 0.31 a day.
 */
export function speechDailySeconds(): number {
  const raw = process.env.VOICE_STT_DAILY_SECONDS?.trim();
  if (!raw) return DEFAULT_DAILY_SECONDS;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_DAILY_SECONDS;
}

/**
 * Reserve `seconds` of today's budget, atomically against every other worker.
 * True when it fit. Charged before the call and never refunded: an attempt
 * the provider billed is spent whether or not it produced text.
 */
export async function reserveSpeechSeconds(seconds: number, budget = speechDailySeconds()): Promise<boolean> {
  const reserved = await getPool().query(
    `INSERT INTO speech_usage_daily AS u (day, seconds, calls)
     SELECT (NOW() AT TIME ZONE 'UTC')::date, $1::int, 1
      WHERE $1::int <= $2::int
     ON CONFLICT (day) DO UPDATE
        SET seconds = u.seconds + EXCLUDED.seconds, calls = u.calls + 1
      WHERE u.seconds + EXCLUDED.seconds <= $2::int
     RETURNING seconds`,
    [seconds, budget],
  );
  if ((reserved.rowCount ?? 0) > 0) {
    return true;
  }
  await getPool().query(
    `INSERT INTO speech_usage_daily AS u (day, refused)
     VALUES ((NOW() AT TIME ZONE 'UTC')::date, 1)
     ON CONFLICT (day) DO UPDATE SET refused = u.refused + 1`,
  );
  return false;
}
