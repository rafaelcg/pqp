import {
  COMMUNITY_HOME_TRANSLATION_LANGS,
  type CommunityHomeCaptionTrack,
  type CommunityHomePostCaptions,
  type CommunityHomeTranslationLang,
} from "@pqp/shared";
import type { PoolClient } from "pg";
import { getPool } from "../db.js";
import { INSTANCE_ID } from "../lib/bus.js";
import { flagServerOverrides, isEnabled } from "../lib/flags.js";
import { logEvent } from "../lib/log.js";
import {
  applyTranslatedCueTexts,
  batchCueTexts,
  parseStoredCues,
  toWebVtt,
  type CaptionCue,
} from "../speech/captions.js";
import {
  communityHomeTranslationModel,
  communityHomeTranslator,
  isCommunityHomeTranslationOn,
  refundTranslationBudget,
  reserveTranslationBudget,
} from "./community-home-translation.js";
import { enqueueSpeechJob, SPEECH_JOBS_CHANNEL } from "./speech-jobs.js";

/**
 * Automatic subtitles for a video uploaded to the Baú.
 *
 *   publish / edit / the minute sweep
 *     -> a `speech_jobs` row (kind `community_home_captions`, keyed by post)
 *     -> the worker (`community-home-captions-worker.ts`): download, ffmpeg
 *        to 16 kHz mono, Whisper in 30 s windows, cues, one source track
 *     -> translations of the cue TEXT into the other UI languages, with the
 *        post translator and its daily budget (`translateCommunityHomeCaptions`)
 *     -> `GET .../home/posts/:postId/captions?lang=` renders WebVTT
 *
 * Two switches, both per server and both runtime flags:
 *
 *   * `community_home_video_captions` makes the source track, and is the
 *     kill switch for every read: off hides stored captions too.
 *   * `community_home_translation` (the post translation flag) additionally
 *     has to be on for a translated track to be made or served. The text goes
 *     to the same provider as the post's text, under the same consent.
 *
 * The rules from the voice notes and the post translations hold here too:
 * nothing between BEGIN and COMMIT touches the network, a claim is a row and
 * not a map, every path that does not produce subtitles says why.
 */

export const CAPTIONS_JOB_KIND = "community_home_captions" as const;

/** Tries per (post, language, source) before a translation gives up until the next transcription. */
export const CAPTION_TRANSLATION_MAX_ATTEMPTS = 4;
const CAPTION_CLAIM_LEASE_SECONDS = 240;
const CAPTION_BACKOFF_BASE_SECONDS = 120;
/** A settled job that said "no provider" or "over budget" is offered again after this. */
const CAPTIONS_REQUEUE_AFTER_SECONDS = 60 * 60;
const DEFAULT_MAX_SECONDS = 30 * 60;

// ------------------------------------------------------------------ switches

/** Subtitles are made and served for this server's videos. */
export function isCommunityHomeCaptionsOn(serverId: string): boolean {
  return isEnabled("community_home") && isEnabled("community_home_video_captions", { serverId });
}

/**
 * `COMMUNITY_HOME_CAPTIONS_MAX_SECONDS`: how much of a video's sound is
 * transcribed (default 30 minutes). Past it the rest has no subtitles; the
 * budget is charged for what is sent, never for what was cut.
 */
export function communityHomeCaptionsMaxSeconds(): number {
  const raw = process.env.COMMUNITY_HOME_CAPTIONS_MAX_SECONDS?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_SECONDS;
}

// ------------------------------------------------------------------ counters

const stats = {
  enqueued: 0,
  done: 0,
  noSpeech: 0,
  noAudio: 0,
  unavailable: 0,
  overBudget: 0,
  failed: 0,
  retried: 0,
  droppedFlagOff: 0,
  skippedGone: 0,
  lostLease: 0,
  secondsSent: 0,
  windows: 0,
  translated: 0,
  translationFailed: 0,
  translationOverBudget: 0,
  translationCharsSent: 0,
  lastError: null as string | null,
};

export type CommunityHomeCaptionCounter = Exclude<keyof typeof stats, "lastError">;

export function bumpCaptionStat(key: CommunityHomeCaptionCounter, by = 1): void {
  stats[key] += by;
}

export function noteCaptionError(message: string): void {
  stats.lastError = message.slice(0, 300);
}

export interface CommunityHomeCaptionsMetrics {
  /** Per process since boot. The worker's live on the worker, so read the `jobs24h` below for the deployment. */
  process: Omit<typeof stats, "lastError">;
  lastError: string | null;
  /** From the database: the whole deployment. */
  jobs24h: { done: number; skipped: number; failed: number; queued: number; running: number } | null;
  tracks: { videos: number; translated: number } | null;
}

export async function communityHomeCaptionsMetrics(): Promise<CommunityHomeCaptionsMetrics> {
  const { lastError, ...process } = stats;
  let jobs24h: CommunityHomeCaptionsMetrics["jobs24h"] = null;
  let tracks: CommunityHomeCaptionsMetrics["tracks"] = null;
  try {
    const jobs = await getPool().query<{
      done: string;
      skipped: string;
      failed: string;
      queued: string;
      running: string;
    }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'done' AND last_error IS NULL
                                 AND finished_at >= NOW() - interval '24 hours')::text AS done,
              COUNT(*) FILTER (WHERE status = 'done' AND last_error IS NOT NULL
                                 AND finished_at >= NOW() - interval '24 hours')::text AS skipped,
              COUNT(*) FILTER (WHERE status = 'failed'
                                 AND finished_at >= NOW() - interval '24 hours')::text AS failed,
              COUNT(*) FILTER (WHERE status = 'queued')::text AS queued,
              COUNT(*) FILTER (WHERE status = 'running')::text AS running
         FROM speech_jobs WHERE kind = $1`,
      [CAPTIONS_JOB_KIND],
    );
    const row = jobs.rows[0];
    jobs24h = {
      done: Number(row?.done ?? 0),
      skipped: Number(row?.skipped ?? 0),
      failed: Number(row?.failed ?? 0),
      queued: Number(row?.queued ?? 0),
      running: Number(row?.running ?? 0),
    };
    const counted = await getPool().query<{ videos: string; translated: string }>(
      `SELECT COUNT(*) FILTER (WHERE is_source)::text AS videos,
              COUNT(*) FILTER (WHERE NOT is_source)::text AS translated
         FROM community_home_post_captions`,
    );
    tracks = {
      videos: Number(counted.rows[0]?.videos ?? 0),
      translated: Number(counted.rows[0]?.translated ?? 0),
    };
  } catch {
    // The metrics page must not fail because this block could not be read.
  }
  return { process, lastError, jobs24h, tracks };
}

export function resetCommunityHomeCaptionsForTests(): void {
  for (const key of Object.keys(stats) as Array<keyof typeof stats>) {
    if (key === "lastError") stats.lastError = null;
    else stats[key] = 0;
  }
  inFlightTranslations.clear();
  readKicks.clear();
}

// ------------------------------------------------------------------- enqueue

type Queryable = Pick<PoolClient, "query">;

/**
 * Queue subtitles for one post if it is a published, uploaded video on a
 * server that has them on. Never awaited by the request that published the
 * post, and cannot reject: the minute sweep catches anything this misses.
 */
export function scheduleCommunityHomeCaptions(postId: string, serverId: string): Promise<void> {
  if (!isCommunityHomeCaptionsOn(serverId)) {
    return Promise.resolve();
  }
  return (async () => {
    const found = await getPool().query(
      `SELECT 1 FROM community_home_posts
        WHERE id = $1 AND status = 'published'
          AND media_kind = 'video' AND media_storage_key IS NOT NULL`,
      [postId],
    );
    if ((found.rowCount ?? 0) === 0) return;
    if (await enqueueSpeechJob(getPool(), { kind: CAPTIONS_JOB_KIND, postId })) {
      stats.enqueued += 1;
      logEvent("communityHome.captions.enqueued", { postId, via: "publish" });
    }
  })().catch((error: unknown) => {
    console.error(
      "[community-home] captions enqueue failed:",
      error instanceof Error ? error.message : error,
    );
  });
}

/**
 * The post's video was replaced or removed: its job, its tracks and its
 * translation claims go, so the next enqueue makes subtitles for the new
 * file. Runs inside the edit's transaction. A worker that is mid-job on the
 * old file loses its fence (the row is gone) and writes nothing.
 */
export async function forgetCommunityHomeCaptions(db: Queryable, postId: string): Promise<void> {
  await db.query(`DELETE FROM speech_jobs WHERE kind = $1 AND post_id = $2`, [CAPTIONS_JOB_KIND, postId]);
  await db.query(`DELETE FROM community_home_post_captions WHERE post_id = $1`, [postId]);
  await db.query(`DELETE FROM community_home_caption_translation_jobs WHERE post_id = $1`, [postId]);
}

// --------------------------------------------------------------------- reads

interface CaptionRow {
  post_id: string;
  lang: string;
  is_source: boolean;
  media_key: string;
  source_lang: string | null;
  source_hash: string;
  cue_count: number;
  duration_ms: number | null;
}

/**
 * What the feed says about each post's subtitles, for the reader's language:
 * the source track when it is for the post's current video and has words,
 * plus the translation into `lang` when it is current and translations are
 * on for the server. One query for a page of posts.
 */
export async function loadCaptionAvailability(
  posts: Array<{ id: string; server_id: string; media_storage_key: string | null }>,
  lang: CommunityHomeTranslationLang | null,
): Promise<Map<string, CommunityHomePostCaptions>> {
  const out = new Map<string, CommunityHomePostCaptions>();
  const wanted = posts.filter((p) => p.media_storage_key && isCommunityHomeCaptionsOn(p.server_id));
  if (wanted.length === 0) return out;
  const { rows } = await getPool().query<CaptionRow>(
    `SELECT post_id, lang, is_source, media_key, source_lang, source_hash,
            jsonb_array_length(cues) AS cue_count, duration_ms
       FROM community_home_post_captions
      WHERE post_id = ANY($1::uuid[]) AND (is_source OR lang = $2)`,
    [wanted.map((p) => p.id), lang ?? ""],
  );
  const byPost = new Map<string, CaptionRow[]>();
  for (const row of rows) {
    const list = byPost.get(row.post_id) ?? [];
    list.push(row);
    byPost.set(row.post_id, list);
  }
  for (const post of wanted) {
    const list = byPost.get(post.id) ?? [];
    const source = list.find((r) => r.is_source && r.media_key === post.media_storage_key && r.cue_count > 0);
    if (!source) continue;
    const langs = [source.lang];
    const translated = list.find(
      (r) =>
        !r.is_source &&
        r.lang === lang &&
        r.media_key === source.media_key &&
        r.source_hash === source.source_hash &&
        r.cue_count > 0,
    );
    if (translated && isCommunityHomeTranslationOn(post.server_id)) {
      langs.push(translated.lang);
    }
    out.set(post.id, { sourceLang: source.lang, langs, durationMs: source.duration_ms });
  }
  return out;
}

/**
 * The tracks themselves, as WebVTT. The caller has already decided the viewer
 * may see this post's video (`getCommunityHomePostCaptions` in
 * community-home.ts goes through the same read as the feed, lock included).
 * When the reader's language has no current translation yet, one is asked for
 * in the background on this process, so the next read has it.
 */
export async function loadCaptionTracks(
  post: { id: string; server_id: string; media_storage_key: string | null },
  lang: CommunityHomeTranslationLang | null,
): Promise<CommunityHomeCaptionTrack[]> {
  if (!post.media_storage_key || !isCommunityHomeCaptionsOn(post.server_id)) return [];
  const { rows } = await getPool().query<CaptionRow & { cues: unknown }>(
    `SELECT post_id, lang, is_source, media_key, source_lang, source_hash, cues,
            jsonb_array_length(cues) AS cue_count, duration_ms
       FROM community_home_post_captions
      WHERE post_id = $1 AND (is_source OR lang = $2)`,
    [post.id, lang ?? ""],
  );
  const source = rows.find((r) => r.is_source && r.media_key === post.media_storage_key && r.cue_count > 0);
  if (!source) return [];
  const tracks: CommunityHomeCaptionTrack[] = [
    { lang: source.lang, source: true, auto: true, vtt: toWebVtt(parseStoredCues(source.cues)) },
  ];
  if (lang && lang !== source.lang && isCommunityHomeTranslationOn(post.server_id)) {
    const translated = rows.find(
      (r) =>
        !r.is_source &&
        r.lang === lang &&
        r.media_key === source.media_key &&
        r.source_hash === source.source_hash &&
        r.cue_count > 0,
    );
    if (translated) {
      tracks.push({ lang, source: false, auto: true, vtt: toWebVtt(parseStoredCues(translated.cues)) });
    } else {
      void kickTranslationFromRead(post.id, lang, source.source_hash);
    }
  }
  return tracks;
}

// ---------------------------------------------------------------- translation

async function claimCaptionTranslation(
  postId: string,
  lang: string,
  sourceHash: string,
): Promise<{ attempts: number } | null> {
  const { rows } = await getPool().query<{ attempts: number }>(
    `INSERT INTO community_home_caption_translation_jobs AS j
       (post_id, lang, source_hash, claimed_by, claimed_at, attempts)
     VALUES ($1, $2, $3, $4, NOW(), 1)
     ON CONFLICT (post_id, lang) DO UPDATE
        SET attempts = CASE WHEN j.source_hash = EXCLUDED.source_hash
                            THEN j.attempts + 1 ELSE 1 END,
            source_hash = EXCLUDED.source_hash,
            claimed_by = EXCLUDED.claimed_by,
            claimed_at = NOW(),
            retry_at = NULL
      WHERE (j.claimed_at IS NULL
             OR j.claimed_at < NOW() - make_interval(secs => $5))
        AND (j.source_hash <> EXCLUDED.source_hash
             OR ((j.retry_at IS NULL OR j.retry_at <= NOW())
                 AND j.attempts < $6))
     RETURNING attempts`,
    [postId, lang, sourceHash, INSTANCE_ID, CAPTION_CLAIM_LEASE_SECONDS, CAPTION_TRANSLATION_MAX_ATTEMPTS],
  );
  return rows[0] ? { attempts: rows[0].attempts } : null;
}

/**
 * Let go of a claim THIS process holds. Fenced by `claimed_by`: a process
 * whose lease ran out and was taken over must not release, back off or delete
 * the new holder's claim.
 */
async function releaseCaptionClaim(
  postId: string,
  lang: string,
  failure?: { error: string; retryInSeconds: number },
  options: { uncount?: boolean } = {},
): Promise<void> {
  if (options.uncount) {
    // Nothing reached the provider (the database hiccuped before the call):
    // free the claim and give the attempt back, so an infrastructure blip can
    // never use up the tries a translation has.
    await getPool().query(
      `UPDATE community_home_caption_translation_jobs
          SET claimed_at = NULL, claimed_by = NULL,
              attempts = GREATEST(attempts - 1, 0)
        WHERE post_id = $1 AND lang = $2 AND claimed_by = $3`,
      [postId, lang, INSTANCE_ID],
    );
    return;
  }
  if (!failure) {
    await getPool().query(
      `DELETE FROM community_home_caption_translation_jobs
        WHERE post_id = $1 AND lang = $2 AND claimed_by = $3`,
      [postId, lang, INSTANCE_ID],
    );
    return;
  }
  await getPool().query(
    `UPDATE community_home_caption_translation_jobs
        SET claimed_at = NULL, claimed_by = NULL, last_error = $3,
            retry_at = NOW() + make_interval(secs => $4)
      WHERE post_id = $1 AND lang = $2 AND claimed_by = $5`,
    [postId, lang, failure.error.slice(0, 300), failure.retryInSeconds, INSTANCE_ID],
  );
}

/**
 * Keep the claim alive between batches. False when it is no longer ours (the
 * lease ran out and another process took it): the caller stops and writes
 * nothing, so a long video is never paid for twice by two processes.
 */
async function renewCaptionClaim(postId: string, lang: string): Promise<boolean> {
  const renewed = await getPool().query(
    `UPDATE community_home_caption_translation_jobs SET claimed_at = NOW()
      WHERE post_id = $1 AND lang = $2 AND claimed_by = $3`,
    [postId, lang, INSTANCE_ID],
  );
  return (renewed.rowCount ?? 0) > 0;
}

interface SourceForTranslation {
  server_id: string;
  status: string;
  media_storage_key: string | null;
  lang: string;
  media_key: string;
  source_hash: string;
  cues: unknown;
}

async function loadSourceTrack(postId: string): Promise<SourceForTranslation | null> {
  const { rows } = await getPool().query<SourceForTranslation>(
    `SELECT p.server_id, p.status, p.media_storage_key, c.lang, c.media_key,
            c.source_hash, c.cues
       FROM community_home_posts p
       JOIN community_home_post_captions c ON c.post_id = p.id AND c.is_source
      WHERE p.id = $1`,
    [postId],
  );
  return rows[0] ?? null;
}

export type CaptionTranslationOutcome =
  | "done"
  | "failed"
  | "skipped:gone"
  | "skipped:flag_off"
  | "skipped:no_key"
  | "skipped:same_language"
  | "skipped:fresh"
  | "skipped:claimed"
  | "skipped:over_budget"
  | "skipped:source_changed";

function skipped(postId: string, lang: string, reason: string): CaptionTranslationOutcome {
  logEvent("communityHome.captions.translation.skipped", { postId, lang, reason });
  return `skipped:${reason}` as CaptionTranslationOutcome;
}

/**
 * Translate one post's source subtitles into `lang`, keeping every timing.
 * Never throws. Same budget, same provider and the same claim discipline as
 * the post text (`community-home-translation.ts`).
 */
export async function translateCommunityHomeCaptions(
  postId: string,
  lang: CommunityHomeTranslationLang,
  signal?: AbortSignal,
): Promise<CaptionTranslationOutcome> {
  try {
    return await translateOnce(postId, lang, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stats.translationFailed += 1;
    stats.lastError = message.slice(0, 300);
    logEvent("communityHome.captions.translation.failed", { postId, lang, reason: "unexpected", error: message.slice(0, 200) });
    return "failed";
  }
}

async function translateOnce(
  postId: string,
  lang: CommunityHomeTranslationLang,
  signal: AbortSignal | undefined,
): Promise<CaptionTranslationOutcome> {
  const source = await loadSourceTrack(postId);
  if (!source || source.status !== "published" || source.media_key !== source.media_storage_key) {
    return "skipped:gone";
  }
  if (!isCommunityHomeCaptionsOn(source.server_id) || !isCommunityHomeTranslationOn(source.server_id)) {
    return skipped(postId, lang, "flag_off");
  }
  if (source.lang === lang) {
    return "skipped:same_language";
  }
  const translator = communityHomeTranslator();
  if (!translator) {
    return skipped(postId, lang, "no_key");
  }
  const cues = parseStoredCues(source.cues);
  if (cues.length === 0) {
    return "skipped:gone";
  }
  const existing = await getPool().query<{ source_hash: string; media_key: string }>(
    `SELECT source_hash, media_key FROM community_home_post_captions
      WHERE post_id = $1 AND lang = $2 AND NOT is_source`,
    [postId, lang],
  );
  const current = existing.rows[0];
  if (current && current.source_hash === source.source_hash && current.media_key === source.media_key) {
    return "skipped:fresh";
  }

  const claim = await claimCaptionTranslation(postId, lang, source.source_hash);
  if (!claim) {
    return "skipped:claimed";
  }
  const texts = cues.map((cue) => cue.text);
  const chars = texts.reduce((n, t) => n + t.length, 0);
  let reserved: Awaited<ReturnType<typeof reserveTranslationBudget>>;
  try {
    reserved = await reserveTranslationBudget(chars);
  } catch (error) {
    await releaseCaptionClaim(postId, lang, undefined, { uncount: true }).catch(() => undefined);
    throw error;
  }
  if (!reserved) {
    await releaseCaptionClaim(postId, lang);
    stats.translationOverBudget += 1;
    return skipped(postId, lang, "over_budget");
  }

  // What reached the provider, batch by batch: a translation that stops half
  // way keeps only what was actually sent and gives the rest of the
  // reservation back.
  const translated: string[] = [];
  let sentChars = 0;
  let lost = false;
  // Never throws: a refund that cannot be written must not skip the claim's
  // cleanup after it. What it costs is that the unrefunded characters stay
  // counted for the rest of the UTC day, which errs on the side of spending
  // less, and the day's row is new tomorrow; it is logged so it is not silent.
  const settleBudget = async (spent: number) => {
    stats.translationCharsSent += spent;
    if (spent >= chars) return;
    try {
      await refundTranslationBudget(reserved.day, chars - spent);
    } catch (error) {
      logEvent("communityHome.captions.translation.refundFailed", {
        postId,
        lang,
        chars: chars - spent,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
      });
    }
  };
  for (const batch of batchCueTexts(texts)) {
    const batchChars = batch.reduce((n, t) => n + t.length, 0);
    // Each batch gets a fresh lease (and a 180 s budget below, inside the
    // 240 s lease), so a long video never outlives its claim.
    let ours: boolean;
    try {
      ours = await renewCaptionClaim(postId, lang);
    } catch (error) {
      // The database, not the provider. Before any batch went out this is
      // not a translation attempt at all: free the claim and give the try
      // back. After one did, it is an ordinary failure of a paid translation.
      await settleBudget(sentChars);
      if (sentChars === 0) {
        await releaseCaptionClaim(postId, lang, undefined, { uncount: true }).catch(() => undefined);
        throw error;
      }
      return failTranslation(postId, lang, claim.attempts, error);
    }
    if (!ours) {
      lost = true;
      break;
    }
    // Consent, again, at the provider boundary: an operator who turns either
    // switch off while this waited on the database stops the next batch. No
    // await between this check and the call.
    if (!isCommunityHomeCaptionsOn(source.server_id) || !isCommunityHomeTranslationOn(source.server_id)) {
      await settleBudget(sentChars);
      await releaseCaptionClaim(postId, lang);
      return skipped(postId, lang, "flag_off");
    }
    try {
      const result = await translator.translate(
        batch,
        !source.lang || source.lang === "und" ? "auto" : source.lang,
        lang,
        signal ?? AbortSignal.timeout(180_000),
      );
      sentChars += batchChars;
      if (result.texts.length !== batch.length) {
        throw new Error("the model returned a misaligned answer");
      }
      translated.push(...result.texts);
    } catch (error) {
      // A batch the provider answered (or said it billed) is spent; the rest
      // of the reservation goes back.
      const detail = error as { costUsd?: unknown; costIncomplete?: unknown };
      const billedHere =
        detail.costIncomplete === true || (typeof detail.costUsd === "number" && detail.costUsd > 0);
      // A misaligned answer already counted its batch above; a thrown
      // provider error counts it only when it says it was billed.
      await settleBudget(Math.min(chars, sentChars + (billedHere ? batchChars : 0)));
      return failTranslation(postId, lang, claim.attempts, error);
    }
  }
  if (lost) {
    // Somebody else holds it now and will write it. What was sent is spent;
    // the rest of the reservation is given back.
    await settleBudget(sentChars);
    return skipped(postId, lang, "claimed");
  }
  await settleBudget(chars);

  let out: CaptionCue[];
  try {
    out = applyTranslatedCueTexts(cues, translated);
  } catch (error) {
    return failTranslation(postId, lang, claim.attempts, error);
  }

  // From here on the money is spent; a database error writing the result
  // must still release the claim (with backoff), not hold it for a lease.
  try {
    // A new transcription (or a new video) may have landed while the model
    // worked: this translation is of the old one, so it is thrown away.
    const now = await loadSourceTrack(postId);
    if (!now || now.source_hash !== source.source_hash || now.media_key !== source.media_key) {
      await releaseCaptionClaim(postId, lang);
      return skipped(postId, lang, "source_changed");
    }
    if (!(await renewCaptionClaim(postId, lang))) {
      return skipped(postId, lang, "claimed");
    }
    await getPool().query(
      `INSERT INTO community_home_post_captions
         (post_id, lang, is_source, media_key, cues, source_lang, source_hash, made_by, created_at)
       VALUES ($1, $2, FALSE, $3, $4::jsonb, $5, $6, $7, NOW())
       ON CONFLICT (post_id, lang) DO UPDATE
          SET is_source = FALSE, media_key = EXCLUDED.media_key, cues = EXCLUDED.cues,
              source_lang = EXCLUDED.source_lang, source_hash = EXCLUDED.source_hash,
              made_by = EXCLUDED.made_by, created_at = NOW()
        WHERE NOT community_home_post_captions.is_source`,
      [postId, lang, source.media_key, JSON.stringify(out), source.lang, source.source_hash, communityHomeTranslationModel()],
    );
    await releaseCaptionClaim(postId, lang);
  } catch (error) {
    return failTranslation(postId, lang, claim.attempts, error);
  }
  stats.translated += 1;
  logEvent("communityHome.captions.translation.done", { postId, lang, cues: out.length, chars });
  return "done";
}

async function failTranslation(
  postId: string,
  lang: string,
  attempts: number,
  error: unknown,
): Promise<CaptionTranslationOutcome> {
  const message = error instanceof Error ? error.message : String(error);
  const retryInSeconds = CAPTION_BACKOFF_BASE_SECONDS * 3 ** (attempts - 1);
  await releaseCaptionClaim(postId, lang, { error: message, retryInSeconds }).catch(() => undefined);
  stats.translationFailed += 1;
  stats.lastError = message.slice(0, 300);
  logEvent("communityHome.captions.translation.failed", {
    postId,
    lang,
    attempt: attempts,
    gaveUp: attempts >= CAPTION_TRANSLATION_MAX_ATTEMPTS,
    error: message.slice(0, 200),
  });
  return "failed";
}

/** A reader's request asks for a missing translation at most this often per (post, language) and process. */
const READ_KICK_COOLDOWN_MS = 60_000;
const READ_KICKS_MAX = 2_000;
const readKicks = new Map<string, number>();

/**
 * A reader asked for a language that has no current track: ask for one in the
 * background, but cheaply. A popular video read a thousand times while its
 * translation is in backoff or given up must not reload and parse its cues a
 * thousand times, so the claim row's own gate is read first (one indexed row,
 * no cues), and each process asks at most once a minute per pair.
 */
async function kickTranslationFromRead(
  postId: string,
  lang: CommunityHomeTranslationLang,
  sourceHash: string,
): Promise<void> {
  const key = `${postId}:${lang}`;
  const now = Date.now();
  if ((readKicks.get(key) ?? 0) > now - READ_KICK_COOLDOWN_MS || inFlightTranslations.has(key)) return;
  // Re-inserted so the map stays in time order: the oldest entries are the
  // first ones, and trimming past the cap drops them without scanning the rest.
  readKicks.delete(key);
  readKicks.set(key, now);
  if (readKicks.size > READ_KICKS_MAX) {
    for (const k of readKicks.keys()) {
      if (readKicks.size <= READ_KICKS_MAX / 2) break;
      readKicks.delete(k);
    }
  }
  try {
    if (!communityHomeTranslator()) return;
    const blocked = await getPool().query(
      `SELECT 1 FROM community_home_caption_translation_jobs
        WHERE post_id = $1 AND lang = $2 AND source_hash = $3
          AND (attempts >= $4 OR retry_at > NOW()
               OR claimed_at > NOW() - make_interval(secs => $5))`,
      [postId, lang, sourceHash, CAPTION_TRANSLATION_MAX_ATTEMPTS, CAPTION_CLAIM_LEASE_SECONDS],
    );
    if ((blocked.rowCount ?? 0) > 0) return;
    await runCaptionTranslationOnce(postId, lang);
  } catch (error) {
    console.error(
      "[community-home] captions read-time translation failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

/** One (post, language) at a time per process; a second ask while it runs is a no-op. */
const inFlightTranslations = new Map<string, Promise<CaptionTranslationOutcome>>();

export function runCaptionTranslationOnce(
  postId: string,
  lang: CommunityHomeTranslationLang,
): Promise<CaptionTranslationOutcome> {
  const key = `${postId}:${lang}`;
  const running = inFlightTranslations.get(key);
  if (running) return running;
  const started = translateCommunityHomeCaptions(postId, lang).finally(() => inFlightTranslations.delete(key));
  inFlightTranslations.set(key, started);
  return started;
}

/**
 * Translate a freshly made source track into every other UI language, where
 * the server has translations on. Called by the worker right after it stores
 * the track; awaited there, never by a request.
 */
export async function translateCaptionsEverywhere(postId: string, serverId: string, sourceLang: string): Promise<void> {
  if (!isCommunityHomeTranslationOn(serverId) || !communityHomeTranslator()) return;
  for (const lang of COMMUNITY_HOME_TRANSLATION_LANGS) {
    if (lang === sourceLang) continue;
    await runCaptionTranslationOnce(postId, lang);
  }
}

// ---------------------------------------------------------------------- sweep

/**
 * Every minute (`jobs.ts`, so on the worker when there is one):
 *
 *   1. Queue subtitles for published videos on servers with the flag on that
 *      have no job yet. This is also the BACKFILL: turning the flag on for a
 *      server queues every video already in its Baú, newest first, a few per
 *      minute. A job that settled as "no provider" or "over budget" is
 *      offered again after an hour.
 *   2. Translate source tracks that are missing a current translation.
 *
 * With the flag off everywhere it is an in-memory check and returns.
 */
export async function sweepCommunityHomeCaptions(limit = 5): Promise<{ enqueued: number; translated: number }> {
  if (!isEnabled("community_home")) return { enqueued: 0, translated: 0 };
  const globalOn = isEnabled("community_home_video_captions");
  const overrides = flagServerOverrides("community_home_video_captions");
  const serverIds = [...overrides.entries()].filter(([, on]) => on === !globalOn).map(([id]) => id);
  if (!globalOn && serverIds.length === 0) return { enqueued: 0, translated: 0 };
  const scope = globalOn ? "p.server_id <> ALL($2::uuid[])" : "p.server_id = ANY($2::uuid[])";

  const queued = await getPool().query<{ post_id: string }>(
    `INSERT INTO speech_jobs (kind, post_id)
     SELECT $1::text, p.id
       FROM community_home_posts p
      WHERE p.status = 'published'
        AND p.media_kind = 'video'
        AND p.media_storage_key IS NOT NULL
        AND ${scope}
        AND NOT EXISTS (
          SELECT 1 FROM speech_jobs j
           WHERE j.kind = $1::text AND j.post_id = p.id
             AND NOT (j.status IN ('done', 'failed')
                      AND j.last_error IN ('no-provider', 'over-budget')
                      AND j.finished_at <= NOW() - make_interval(secs => $4)))
      ORDER BY p.published_at DESC NULLS LAST, p.id
      LIMIT $3
     ON CONFLICT (kind, post_id) WHERE post_id IS NOT NULL DO UPDATE
        SET status = 'queued', attempts = 0, run_after = NOW(), leased_by = NULL,
            lease_expires_at = NULL, finished_at = NULL, last_error = NULL
      WHERE speech_jobs.status IN ('done', 'failed')
        AND speech_jobs.last_error IN ('no-provider', 'over-budget')
        AND speech_jobs.finished_at <= NOW() - make_interval(secs => $4)
     RETURNING post_id`,
    [CAPTIONS_JOB_KIND, serverIds, limit, CAPTIONS_REQUEUE_AFTER_SECONDS],
  );
  if (queued.rows.length > 0) {
    stats.enqueued += queued.rows.length;
    await getPool().query(`SELECT pg_notify($1, '')`, [SPEECH_JOBS_CHANNEL]);
    logEvent("communityHome.captions.enqueued", { via: "sweep", posts: queued.rows.length });
  }

  let translated = 0;
  if (communityHomeTranslator()) {
    const missing = await getPool().query<{ post_id: string; server_id: string; lang: CommunityHomeTranslationLang }>(
      `SELECT p.id AS post_id, p.server_id, l.lang
         FROM community_home_post_captions s
         JOIN community_home_posts p ON p.id = s.post_id
        CROSS JOIN unnest($1::text[]) AS l(lang)
         LEFT JOIN community_home_post_captions t
           ON t.post_id = s.post_id AND t.lang = l.lang AND NOT t.is_source
        WHERE s.is_source
          AND s.lang <> l.lang
          AND s.media_key = p.media_storage_key
          AND jsonb_array_length(s.cues) > 0
          AND p.status = 'published'
          AND ${scope}
          AND (t.post_id IS NULL OR t.source_hash <> s.source_hash OR t.media_key <> s.media_key)
          AND NOT EXISTS (
            SELECT 1 FROM community_home_caption_translation_jobs j
             WHERE j.post_id = s.post_id AND j.lang = l.lang AND j.source_hash = s.source_hash
               AND (j.attempts >= $3 OR j.retry_at > NOW()
                    OR j.claimed_at > NOW() - make_interval(secs => $4)))
        ORDER BY p.published_at DESC NULLS LAST, p.id, l.lang
        LIMIT $5`,
      [[...COMMUNITY_HOME_TRANSLATION_LANGS], serverIds, CAPTION_TRANSLATION_MAX_ATTEMPTS, CAPTION_CLAIM_LEASE_SECONDS, limit],
    );
    for (const row of missing.rows) {
      if (!isCommunityHomeTranslationOn(row.server_id)) continue;
      if ((await runCaptionTranslationOnce(row.post_id, row.lang)) === "done") translated += 1;
    }
  }
  return { enqueued: queued.rows.length, translated };
}

/** Tests only. */
export async function waitForCaptionTranslationsForTests(): Promise<void> {
  await Promise.all([...inFlightTranslations.values()]);
}
