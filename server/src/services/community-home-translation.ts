import { createHash } from "node:crypto";
import {
  COMMUNITY_HOME_TRANSLATION_LANGS,
  hasChannelRefs,
  protectChannelRefs,
  type CommunityHomePostTranslationRow,
  type CommunityHomeTranslationLang,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { INSTANCE_ID } from "../lib/bus.js";
import { flagServerOverrides, isEnabled } from "../lib/flags.js";
import { logEvent } from "../lib/log.js";
import { createOpenRouterChatTranslator } from "../speech/translators/openrouter-chat.js";
import type { Translator } from "../speech/types.js";
import { detectLanguage } from "./lang-detect.js";

/**
 * Automatic translation of published Baú posts.
 *
 * Off unless BOTH hold: the runtime flag `community_home_translation` is on
 * for the post's server, and `OPENROUTER_API_KEY` is set on this process.
 * Either one missing means this whole file does nothing and says why in one
 * log line; a deployment with neither behaves exactly as before it existed.
 *
 * The rules that shape the code:
 *
 *   * NEVER IN A TRANSACTION. A translation is a network call that can take a
 *     minute with retries. Nothing here holds a transaction (or a pooled
 *     connection) across it, and publishing never waits for it or fails
 *     because of it: the callers fire and forget.
 *   * THE CLAIM IS A ROW, NOT A MAP. Two API machines share one Postgres, so
 *     "is somebody translating this post?" is answered by an atomic
 *     `INSERT ... ON CONFLICT DO UPDATE ... WHERE <lease expired and not in
 *     backoff>` on `community_home_translation_jobs`. An in-process Set would
 *     answer "not in my map", which is not an answer.
 *   * AN EDIT INVALIDATES BY HASH. A translation row remembers the md5 of the
 *     title, teaser and body it was made from. The read compares it with the
 *     post as it is now and serves the original on a mismatch; the sweep then
 *     makes a fresh one. Nothing deletes anything on edit, so there is no
 *     window in which an old translation is served for new text.
 *   * BOUNDED. Source text is capped per post, a daily character budget is
 *     shared by every API machine (a row in `community_home_translation_usage`
 *     reserved atomically), retries back off and then give up quietly.
 *   * SAYS WHY. Every path that does not translate logs the reason and bumps a
 *     counter on `GET /api/admin/metrics` (`communityHomeTranslation`).
 */

const DEFAULT_MODEL = "google/gemini-3.1-flash-lite";
const DEFAULT_DAILY_CHARS = 200_000;
const DEFAULT_MAX_SOURCE_CHARS = 6_000;
/** A claim not finished in this long is assumed dead (a crashed machine). */
const CLAIM_LEASE_SECONDS = 240;
/** Tries per version of a post before the job gives up until it is edited. */
export const TRANSLATION_MAX_ATTEMPTS = 4;
const BACKOFF_BASE_SECONDS = 120;
const CONCURRENCY = 2;
const TRUNCATION_MARK = " […]";
/** What is stored, whatever the model returns. Original limits are 200/500/4000. */
const STORED_TITLE_MAX = 600;
const STORED_TEASER_MAX = 1_500;
const STORED_BODY_MAX = 12_000;

export function communityHomeTranslationModel(): string {
  return process.env.COMMUNITY_HOME_TRANSLATION_MODEL?.trim() || DEFAULT_MODEL;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  // 0 is a real answer (a budget of nothing), so only garbage falls back.
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function communityHomeTranslationDailyChars(): number {
  return positiveIntFromEnv(
    "COMMUNITY_HOME_TRANSLATION_DAILY_CHARS",
    DEFAULT_DAILY_CHARS,
  );
}

export function communityHomeTranslationMaxSourceChars(): number {
  return Math.max(
    200,
    positiveIntFromEnv(
      "COMMUNITY_HOME_TRANSLATION_MAX_CHARS",
      DEFAULT_MAX_SOURCE_CHARS,
    ),
  );
}

// ------------------------------------------------------------------ switches

/**
 * The feature is on for this server's readers: the Baú itself is on and this
 * server has not been left out of (or put into) the translation flag. This is
 * the whole of "serve a translation"; producing one also needs the key.
 */
export function isCommunityHomeTranslationOn(serverId: string): boolean {
  return (
    isEnabled("community_home") &&
    isEnabled("community_home_translation", { serverId })
  );
}

let translatorOverride: Translator | null = null;
let cachedTranslator: {
  key: string;
  model: string;
  baseUrl: string;
  t: Translator;
} | null = null;

/**
 * Where the chat call goes. OpenRouter unless the operator points it at
 * another OpenAI-compatible endpoint (a proxy, a local model, the stub the
 * Playwright suite runs). The key is sent to whatever this names, so it is
 * environment only and never anything a request can set.
 */
function translationBaseUrl(): string {
  return (
    process.env.COMMUNITY_HOME_TRANSLATION_BASE_URL?.trim().replace(/\/+$/, "") ||
    "https://openrouter.ai/api/v1"
  );
}

/** Tests only: a fake in place of OpenRouter. Pass null to put the real one back. */
export function setCommunityHomeTranslatorForTests(
  translator: Translator | null,
): void {
  translatorOverride = translator;
}

function getTranslator(): Translator | null {
  if (translatorOverride) {
    return translatorOverride;
  }
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }
  const model = communityHomeTranslationModel();
  const baseUrl = translationBaseUrl();
  if (
    cachedTranslator?.key === apiKey &&
    cachedTranslator.model === model &&
    cachedTranslator.baseUrl === baseUrl
  ) {
    return cachedTranslator.t;
  }
  const t = createOpenRouterChatTranslator({
    apiKey,
    model,
    baseUrl,
    // The job retries on its own schedule too; this is the quick retry for a
    // 429 or a 5xx inside one attempt, with the provider's Retry-After honoured.
    retry: {
      maxAttempts: 4,
      baseDelayMs: 2_000,
      maxDelayMs: 30_000,
      onRetry: (info) => {
        stats.providerRetries += 1;
        logEvent("communityHome.translation.retry", {
          status: info.status,
          attempt: info.attempt,
          delayMs: info.delayMs,
        });
      },
    },
  });
  cachedTranslator = { key: apiKey, model, baseUrl, t };
  return t;
}

/**
 * The same translator the posts use (model, base URL, retries, the system
 * prompt that keeps product names untouched), for the Baú's video subtitles
 * (`community-home-captions.ts`). Null without a key.
 */
export function communityHomeTranslator(): Translator | null {
  return getTranslator();
}

/** The key (or a test translator) is present, so a job can actually run. */
export function isCommunityHomeTranslationConfigured(): boolean {
  return getTranslator() !== null;
}

// ------------------------------------------------------------------- counters

const stats = {
  done: 0,
  sameLanguage: 0,
  failed: 0,
  gaveUp: 0,
  skippedOverBudget: 0,
  skippedClaimed: 0,
  skippedFlagOff: 0,
  skippedNoKey: 0,
  skippedNotPublished: 0,
  discardedStale: 0,
  truncated: 0,
  channelRefsKept: 0,
  providerRetries: 0,
  charsSent: 0,
  costUsd: 0,
  lastError: null as string | null,
};

export interface CommunityHomeTranslationMetrics {
  /** A key (or a test translator) is on this process. */
  configured: boolean;
  model: string;
  /** Since this process started. Per machine, like the other counters. */
  done: number;
  sameLanguage: number;
  failed: number;
  gaveUp: number;
  skippedOverBudget: number;
  skippedClaimed: number;
  skippedFlagOff: number;
  skippedNoKey: number;
  skippedNotPublished: number;
  discardedStale: number;
  truncated: number;
  /** Fields left in the author's words because a `#channel` reference did not survive translation. */
  channelRefsKept: number;
  providerRetries: number;
  charsSent: number;
  costUsd: number;
  lastError: string | null;
  /** From the database, so it is the whole deployment's day, not this machine's. */
  today: { chars: number; requests: number; capChars: number } | null;
}

export async function communityHomeTranslationMetrics(): Promise<CommunityHomeTranslationMetrics> {
  let today: CommunityHomeTranslationMetrics["today"] = null;
  try {
    const { rows } = await getPool().query<{ chars: string; requests: number }>(
      `SELECT chars::text, requests FROM community_home_translation_usage
        WHERE day = (NOW() AT TIME ZONE 'UTC')::date`,
    );
    today = {
      chars: Number(rows[0]?.chars ?? 0),
      requests: rows[0]?.requests ?? 0,
      capChars: communityHomeTranslationDailyChars(),
    };
  } catch {
    today = null;
  }
  return {
    configured: isCommunityHomeTranslationConfigured(),
    model: communityHomeTranslationModel(),
    ...stats,
    costUsd: Math.round(stats.costUsd * 1_000_000) / 1_000_000,
    today,
  };
}

export function resetCommunityHomeTranslationForTests(): void {
  for (const key of Object.keys(stats) as Array<keyof typeof stats>) {
    if (key === "lastError") {
      stats.lastError = null;
    } else {
      stats[key] = 0;
    }
  }
  translatorOverride = null;
  cachedTranslator = null;
  lastSweepState = "";
  idleUntil = 0;
  idleSignature = "";
  queued.clear();
  maxQueued = MAX_QUEUED;
}

// ---------------------------------------------------------------- hash + text

export interface TranslationSourceFields {
  title: string | null;
  teaser: string | null;
  body: string;
}

/** md5 of what a translation is made from. Mirrored in SQL by `SOURCE_HASH_SQL`. */
export function translationSourceHash(f: TranslationSourceFields): string {
  return createHash("md5")
    .update(`${f.title ?? ""}\u001f${f.teaser ?? ""}\u001f${f.body}`, "utf8")
    .digest("hex");
}

/** The same hash computed by Postgres, for the sweep's "is this row stale". */
function sourceHashSql(alias: string): string {
  return `md5(coalesce(${alias}.title, '') || chr(31) || coalesce(${alias}.teaser, '') || chr(31) || ${alias}.body)`;
}

/** Cuts at a paragraph, line or word boundary when one is close, never mid-word if it can help it. */
export function truncateForTranslation(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  if (text.length <= max) {
    return { text, truncated: false };
  }
  const slice = text.slice(0, max);
  const cut = Math.max(
    slice.lastIndexOf("\n\n"),
    slice.lastIndexOf("\n"),
    slice.lastIndexOf(". "),
    slice.lastIndexOf(" "),
  );
  const at = cut > max * 0.6 ? cut : max;
  return { text: slice.slice(0, at).trimEnd() + TRUNCATION_MARK, truncated: true };
}

/** Words to translate: a line that is only links, emoji or a GIF URL has none. */
const hasLetters = (text: string | null): text is string =>
  text != null && /\p{L}/u.test(text.replace(/https?:\/\/\S+/gu, " "));

// ------------------------------------------------------------------ the claim

export interface ClaimOptions {
  leaseSeconds?: number;
  maxAttempts?: number;
  claimedBy?: string;
}

/**
 * Take the (post, language) job, or learn that somebody else holds it, that it
 * is in backoff, or that it gave up on this version of the post. One
 * statement, so two machines racing for the same post get one winner.
 */
export async function claimTranslationJob(
  postId: string,
  lang: CommunityHomeTranslationLang,
  sourceHash: string,
  options: ClaimOptions = {},
): Promise<{ attempts: number } | null> {
  const { rows } = await getPool().query<{ attempts: number }>(
    `INSERT INTO community_home_translation_jobs AS j
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
        -- The backoff and the give-up belong to ONE version of the post: an
        -- edit is a new version and starts fresh, whatever the old one owes.
        AND (j.source_hash <> EXCLUDED.source_hash
             OR ((j.retry_at IS NULL OR j.retry_at <= NOW())
                 AND j.attempts < $6))
     RETURNING attempts`,
    [
      postId,
      lang,
      sourceHash,
      options.claimedBy ?? INSTANCE_ID,
      options.leaseSeconds ?? CLAIM_LEASE_SECONDS,
      options.maxAttempts ?? TRANSLATION_MAX_ATTEMPTS,
    ],
  );
  return rows[0] ? { attempts: rows[0].attempts } : null;
}

async function releaseClaim(
  postId: string,
  lang: string,
  failure?: { error: string; retryInSeconds: number },
): Promise<void> {
  if (!failure) {
    await getPool().query(
      `DELETE FROM community_home_translation_jobs WHERE post_id = $1 AND lang = $2`,
      [postId, lang],
    );
    return;
  }
  await getPool().query(
    `UPDATE community_home_translation_jobs
        SET claimed_at = NULL, claimed_by = NULL, last_error = $3,
            retry_at = NOW() + make_interval(secs => $4)
      WHERE post_id = $1 AND lang = $2`,
    [postId, lang, failure.error.slice(0, 300), failure.retryInSeconds],
  );
}

// ------------------------------------------------------------------ the budget

const utcDay = (): string => new Date().toISOString().slice(0, 10);

/** Reserve `chars` against today's cap, or say there is no room. Atomic across machines. */
export async function reserveTranslationBudget(
  chars: number,
): Promise<{ day: string } | null> {
  const cap = communityHomeTranslationDailyChars();
  if (chars > cap) {
    return null;
  }
  const day = utcDay();
  const { rows } = await getPool().query(
    `INSERT INTO community_home_translation_usage AS u (day, chars, requests)
     VALUES ($1::date, $2, 1)
     ON CONFLICT (day) DO UPDATE
        SET chars = u.chars + EXCLUDED.chars, requests = u.requests + 1
      WHERE u.chars + EXCLUDED.chars <= $3
     RETURNING chars`,
    [day, chars, cap],
  );
  return rows[0] ? { day } : null;
}

/** Give back a reservation that never reached the provider. Shared with the video subtitles. */
export async function refundTranslationBudget(day: string, chars: number): Promise<void> {
  await getPool().query(
    `UPDATE community_home_translation_usage
        SET chars = GREATEST(0, chars - $2), requests = GREATEST(0, requests - 1)
      WHERE day = $1::date`,
    [day, chars],
  );
}

async function remainingBudget(): Promise<number> {
  const { rows } = await getPool().query<{ chars: string }>(
    `SELECT chars::text FROM community_home_translation_usage
      WHERE day = $1::date`,
    [utcDay()],
  );
  return communityHomeTranslationDailyChars() - Number(rows[0]?.chars ?? 0);
}

// ------------------------------------------------------------------- one job

interface PostSource {
  id: string;
  server_id: string;
  status: string;
  title: string | null;
  teaser: string | null;
  body: string;
}

async function loadSource(postId: string): Promise<PostSource | null> {
  const { rows } = await getPool().query<PostSource>(
    `SELECT id, server_id, status, title, teaser, body
       FROM community_home_posts WHERE id = $1`,
    [postId],
  );
  return rows[0] ?? null;
}

type SkipReason =
  | "post_gone"
  | "not_published"
  | "flag_off"
  | "no_key"
  | "claimed"
  | "over_budget"
  | "source_changed"
  | "fresh";

export type TranslationOutcome =
  | "done"
  | "same_language"
  | "failed"
  | `skipped:${SkipReason}`;

type CounterKey = Exclude<keyof typeof stats, "lastError">;

function skip(
  reason: SkipReason,
  postId: string,
  lang: string,
  counter?: CounterKey,
): TranslationOutcome {
  if (counter) {
    stats[counter] += 1;
  }
  logEvent("communityHome.translation.skipped", { postId, lang, reason });
  return `skipped:${reason}`;
}

async function upsertTranslation(row: {
  postId: string;
  lang: CommunityHomeTranslationLang;
  title: string | null;
  body: string;
  teaser: string | null;
  sourceLang: string | null;
  sameLanguage: boolean;
  sourceHash: string;
  model: string;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO community_home_post_translations
       (post_id, lang, title, body, teaser, source_lang, same_language,
        source_hash, model, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (post_id, lang) DO UPDATE
        SET title = EXCLUDED.title, body = EXCLUDED.body,
            teaser = EXCLUDED.teaser, source_lang = EXCLUDED.source_lang,
            same_language = EXCLUDED.same_language,
            source_hash = EXCLUDED.source_hash, model = EXCLUDED.model,
            created_at = NOW()`,
    [
      row.postId,
      row.lang,
      row.title,
      row.body,
      row.teaser,
      row.sourceLang,
      row.sameLanguage,
      row.sourceHash,
      row.model,
    ],
  );
}

/**
 * Translate one post into one language, if it should be. Never throws: every
 * outcome is a return value, a log line and a counter.
 */
export async function translateCommunityHomePost(
  postId: string,
  lang: CommunityHomeTranslationLang,
  options: { signal?: AbortSignal } = {},
): Promise<TranslationOutcome> {
  try {
    return await translateOnce(postId, lang, options.signal, 0);
  } catch (error) {
    // Anything the steps below did not expect (a dropped connection, say).
    const message = error instanceof Error ? error.message : String(error);
    stats.failed += 1;
    stats.lastError = message.slice(0, 300);
    logEvent("communityHome.translation.failed", {
      postId,
      lang,
      reason: "unexpected",
      error: message.slice(0, 200),
    });
    return "failed";
  }
}

async function translateOnce(
  postId: string,
  lang: CommunityHomeTranslationLang,
  signal: AbortSignal | undefined,
  pass: number,
): Promise<TranslationOutcome> {
  const post = await loadSource(postId);
  if (!post) {
    return skip("post_gone", postId, lang);
  }
  if (post.status !== "published") {
    return skip("not_published", postId, lang, "skippedNotPublished");
  }
  if (!isCommunityHomeTranslationOn(post.server_id)) {
    return skip("flag_off", postId, lang, "skippedFlagOff");
  }
  const translator = getTranslator();
  if (!translator) {
    return skip("no_key", postId, lang, "skippedNoKey");
  }

  const hash = translationSourceHash(post);
  const model = communityHomeTranslationModel();

  // Already done for this exact text (by this machine, its sibling, or an
  // earlier call): nothing to claim and nothing worth a log line, this is the
  // common answer to "an edit that changed nothing" and to a second machine's
  // late call.
  const existing = await getPool().query<{ source_hash: string }>(
    `SELECT source_hash FROM community_home_post_translations
      WHERE post_id = $1 AND lang = $2`,
    [postId, lang],
  );
  if (existing.rows[0]?.source_hash === hash) {
    return "skipped:fresh";
  }

  // Which fields have words to translate. A GIF URL or an emoji-only line
  // has none and is carried over untouched. `#channel` references are stored
  // as `<#uuid>`; they are swapped for numbered placeholders for everything
  // below (detection, the "has words" test, truncation, the model) and put
  // back afterwards, so the model never sees an id it could "fix" and a uuid's
  // hex letters never count as words.
  const names = ["title", "teaser", "body"] as const;
  const guard = protectChannelRefs([
    post.title ?? "",
    post.teaser ?? "",
    post.body,
  ]);
  const fields: Array<[string, string, number]> = [];
  names.forEach((name, index) => {
    const value = guard.texts[index]!;
    if (hasLetters(value)) {
      fields.push([name, value, index]);
    }
  });
  const detected = detectLanguage(fields.map(([, value]) => value).join("\n"));

  if (fields.length === 0 || detected === lang) {
    // Nothing to do, and the sweep must be told so it does not ask again.
    await upsertTranslation({
      postId,
      lang,
      title: post.title,
      body: post.body,
      teaser: post.teaser,
      sourceLang: detected,
      sameLanguage: true,
      sourceHash: hash,
      model,
    });
    stats.sameLanguage += 1;
    logEvent("communityHome.translation.sameLanguage", {
      postId,
      lang,
      detected,
    });
    return "same_language";
  }

  const claim = await claimTranslationJob(postId, lang, hash);
  if (!claim) {
    return skip("claimed", postId, lang, "skippedClaimed");
  }

  // Cap what is sent: the title and teaser first (they are short), the body
  // gets what is left.
  const max = communityHomeTranslationMaxSourceChars();
  let room = max;
  let wasTruncated = false;
  const texts: string[] = [];
  for (const [, value] of fields) {
    const cut = truncateForTranslation(value, Math.max(room, 0));
    room -= cut.text.length;
    wasTruncated ||= cut.truncated;
    texts.push(cut.text);
  }
  const sentChars = texts.reduce((n, t) => n + t.length, 0);

  const reserved = await reserveTranslationBudget(sentChars);
  if (!reserved) {
    await releaseClaim(postId, lang);
    logEvent("communityHome.translation.overBudget", {
      postId,
      lang,
      chars: sentChars,
      capChars: communityHomeTranslationDailyChars(),
    });
    return skip("over_budget", postId, lang, "skippedOverBudget");
  }

  let translated: string[];
  try {
    const result = await translator.translate(
      texts,
      detected ?? "auto",
      lang,
      signal ?? AbortSignal.timeout(180_000),
    );
    if (
      result.texts.length !== texts.length ||
      result.texts.some((t, i) => !t.trim() && texts[i]!.trim())
    ) {
      // The provider answered, so it billed: this is a billed failure.
      throw Object.assign(
        new Error("the model returned an empty or misaligned answer"),
        { costUsd: result.costUsd ?? 0, billed: true },
      );
    }
    translated = result.texts;
    stats.costUsd += result.costUsd ?? 0;
  } catch (error) {
    // A failure after a billed call (`TranslateError`, or an answer we
    // rejected) still cost money: it keeps its reservation and is counted as
    // sent, so repeated billed failures cannot free the same budget again. Only
    // a failure known not to have reached the provider gives it back.
    const detail = error as {
      costUsd?: unknown;
      costIncomplete?: unknown;
      billed?: unknown;
    };
    const wasBilled =
      detail.billed === true ||
      detail.costIncomplete === true ||
      (typeof detail.costUsd === "number" && detail.costUsd > 0);
    if (typeof detail.costUsd === "number") {
      stats.costUsd += detail.costUsd;
    }
    if (wasBilled) {
      stats.charsSent += sentChars;
    } else {
      await refundTranslationBudget(reserved.day, sentChars);
    }
    const message = error instanceof Error ? error.message : String(error);
    const retryInSeconds = BACKOFF_BASE_SECONDS * 3 ** (claim.attempts - 1);
    await releaseClaim(postId, lang, { error: message, retryInSeconds });
    stats.failed += 1;
    stats.lastError = message.slice(0, 300);
    const gaveUp = claim.attempts >= TRANSLATION_MAX_ATTEMPTS;
    if (gaveUp) {
      stats.gaveUp += 1;
    }
    logEvent("communityHome.translation.failed", {
      postId,
      lang,
      attempt: claim.attempts,
      retryInSeconds: gaveUp ? null : retryInSeconds,
      gaveUp,
      error: message.slice(0, 200),
    });
    return "failed";
  }
  stats.charsSent += sentChars;
  if (wasTruncated) {
    stats.truncated += 1;
  }

  // Put the channel ids back. A field whose placeholders did not all survive
  // keeps the author's own words: an untranslated post beats a dead link.
  const allTranslated = names.map((_, index) => guard.texts[index]!);
  const allSent = [...allTranslated];
  fields.forEach(([, , index], i) => {
    allTranslated[index] = translated[i]!;
    allSent[index] = texts[i]!;
  });
  const restored = guard.restore(allTranslated, allSent);
  const byField = new Map<string, string>();
  const storedMax: Record<string, number> = {
    title: STORED_TITLE_MAX,
    teaser: STORED_TEASER_MAX,
    body: STORED_BODY_MAX,
  };
  fields.forEach(([name, , index]) => {
    const value = restored[index];
    // A restored id is longer than its placeholder: if the result no longer
    // fits what we store, keep the author's words rather than cut a reference.
    if (value == null || (hasChannelRefs(value) && value.length > storedMax[name]!)) {
      stats.channelRefsKept += 1;
      logEvent("communityHome.translation.channelRefsLost", { postId, lang, field: name });
      return;
    }
    byField.set(name, value);
  });

  // The post may have been edited while the model worked. The row we are about
  // to write is for the OLD text: throw it away and go again on the new one.
  const now = await loadSource(postId);
  if (!now || translationSourceHash(now) !== hash || now.status !== "published") {
    await releaseClaim(postId, lang);
    stats.discardedStale += 1;
    logEvent("communityHome.translation.discarded", {
      postId,
      lang,
      reason: "source_changed",
    });
    return pass < 1 && now
      ? translateOnce(postId, lang, signal, pass + 1)
      : "skipped:source_changed";
  }

  await upsertTranslation({
    postId,
    lang,
    title: byField.has("title")
      ? byField.get("title")!.slice(0, STORED_TITLE_MAX)
      : post.title,
    body: byField.has("body")
      ? byField.get("body")!.slice(0, STORED_BODY_MAX)
      : post.body,
    teaser: byField.has("teaser")
      ? byField.get("teaser")!.slice(0, STORED_TEASER_MAX)
      : post.teaser,
    sourceLang: detected,
    sameLanguage: false,
    sourceHash: hash,
    model,
  });
  await releaseClaim(postId, lang);
  stats.done += 1;
  logEvent("communityHome.translation.done", {
    postId,
    lang,
    chars: sentChars,
    truncated: wasTruncated,
    model,
  });
  return "done";
}

// ---------------------------------------------------------- scheduling + sweep

let running = 0;
const waiting: Array<() => void> = [];

/** What may wait for a slot. Past it the work is dropped and the sweep finds it again. */
const MAX_QUEUED = 50;
let maxQueued = MAX_QUEUED;
const queued = new Set<string>();

/** Tests only: a smaller queue, to see the overflow path. */
export function setCommunityHomeTranslationQueueLimitForTests(limit: number | null): void {
  maxQueued = limit ?? MAX_QUEUED;
}

/**
 * Run one (post, language) through the slots, once: a pair already waiting or
 * running in this process is not queued again (the minute sweep would
 * otherwise re-add the same unclaimed candidates every tick while a slow
 * provider holds the slots), and the queue is bounded.
 */
function runQueued(
  postId: string,
  lang: CommunityHomeTranslationLang,
): Promise<unknown> {
  const key = `${postId}:${lang}`;
  if (queued.has(key)) {
    return Promise.resolve();
  }
  if (waiting.length >= maxQueued) {
    // Dropped for room, not for being done: the sweep has to be able to find
    // it, so the idle shortcut must not hide it.
    idleUntil = 0;
    return Promise.resolve();
  }
  queued.add(key);
  return withSlot(() => translateCommunityHomePost(postId, lang)).finally(() =>
    queued.delete(key),
  );
}

async function withSlot<T>(run: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENCY) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running += 1;
  try {
    return await run();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/**
 * Translate a post into every language it is not written in. Called after a
 * publish and after an edit of a published post, never awaited by the request
 * that triggered it: it returns a promise only so tests can wait for it, and
 * it cannot reject.
 */
export function scheduleCommunityHomeTranslation(
  postId: string,
  serverId: string,
): Promise<void> {
  try {
    return scheduleUnsafe(postId, serverId);
  } catch {
    return Promise.resolve();
  }
}

function scheduleUnsafe(postId: string, serverId: string): Promise<void> {
  // The cheap refusals first, before a single query: a deployment that never
  // turned this on pays nothing for it on every publish.
  if (!isCommunityHomeTranslationOn(serverId)) {
    return Promise.resolve();
  }
  if (!isCommunityHomeTranslationConfigured()) {
    stats.skippedNoKey += 1;
    logEvent("communityHome.translation.skipped", {
      postId,
      reason: "no_key",
      note: "flag is on but OPENROUTER_API_KEY is not set",
    });
    return Promise.resolve();
  }
  return Promise.all(
    COMMUNITY_HOME_TRANSLATION_LANGS.map((lang) => runQueued(postId, lang)),
  ).then(
    () => undefined,
    () => undefined,
  );
}

let lastSweepState = "";
/**
 * After a scan that found nothing missing, the next full scan waits this long
 * (unless the switches changed): the query walks every published post, and an
 * idle deployment should not pay for that once a minute. A publish or an edit
 * does not wait for it, it translates by itself; this is only the safety net.
 */
const IDLE_RESCAN_MS = 10 * 60_000;
let idleUntil = 0;
let idleSignature = "";

function sweepState(state: string, fields: Record<string, unknown> = {}): void {
  // Only on a change, so an idle deployment is not one log line a minute.
  if (state === lastSweepState) {
    return;
  }
  lastSweepState = state;
  logEvent("communityHome.translation.sweep", { state, ...fields });
}

/**
 * Translate published posts that are missing a current translation: a crash
 * mid-job, an edit nobody triggered a job for, a key or a flag that arrived
 * after the post was published, a scheduled post that went live on a read.
 * Newest first, a bounded batch per tick. Cheap when idle: with the flag off
 * everywhere or no key it is one in-memory check and returns.
 */
export async function sweepCommunityHomeTranslations(
  limit = 12,
): Promise<{ attempted: number }> {
  if (!isEnabled("community_home")) {
    sweepState("idle", { reason: "community_home_off" });
    return { attempted: 0 };
  }
  if (!isCommunityHomeTranslationConfigured()) {
    // Only worth saying if somebody turned the feature on.
    const anyOn =
      isEnabled("community_home_translation") ||
      [...flagServerOverrides("community_home_translation").values()].some(Boolean);
    sweepState(anyOn ? "idle" : "off", {
      reason: anyOn ? "no_key" : "flag_off_everywhere",
    });
    return { attempted: 0 };
  }

  const globalOn = isEnabled("community_home_translation");
  const overrides = flagServerOverrides("community_home_translation");
  const serverIds = [...overrides.entries()]
    .filter(([, on]) => on === !globalOn)
    .map(([id]) => id);
  if (!globalOn && serverIds.length === 0) {
    sweepState("off", { reason: "flag_off_everywhere" });
    return { attempted: 0 };
  }
  const remaining = await remainingBudget();
  if (remaining <= 0) {
    sweepState("idle", {
      reason: "over_budget",
      capChars: communityHomeTranslationDailyChars(),
    });
    return { attempted: 0 };
  }

  // Global on: every server except the ones overridden off. Global off: only
  // the ones overridden on. Done in SQL so servers that will never qualify
  // cannot fill the batch and starve the ones that do.
  const signature = `${globalOn}|${serverIds.sort().join(",")}|${communityHomeTranslationModel()}`;
  if (signature === idleSignature && Date.now() < idleUntil) {
    return { attempted: 0 };
  }
  const scope = globalOn
    ? "p.server_id <> ALL($4::uuid[])"
    : "p.server_id = ANY($4::uuid[])";
  const { rows } = await getPool().query<{
    post_id: string;
    server_id: string;
    lang: CommunityHomeTranslationLang;
  }>(
    `SELECT p.id AS post_id, p.server_id, l.lang
       FROM community_home_posts p
       CROSS JOIN unnest($1::text[]) AS l(lang)
       LEFT JOIN community_home_post_translations t
         ON t.post_id = p.id AND t.lang = l.lang
      WHERE p.status = 'published'
        AND ${scope}
        -- Only what the rest of today's budget can pay for, so a post too big
        -- for what is left is not claimed, refused and logged every minute.
        AND LEAST(
              coalesce(length(p.title), 0) + coalesce(length(p.teaser), 0)
                + length(p.body),
              $6::int
            ) <= $7::bigint
        AND (t.post_id IS NULL OR t.source_hash <> ${sourceHashSql("p")})
        AND NOT EXISTS (
          SELECT 1 FROM community_home_translation_jobs j
           WHERE j.post_id = p.id AND j.lang = l.lang
             AND j.source_hash = ${sourceHashSql("p")}
             AND (j.attempts >= $2
                  OR j.retry_at > NOW()
                  OR j.claimed_at > NOW() - make_interval(secs => $5))
        )
      ORDER BY p.published_at DESC NULLS LAST, p.id, l.lang
      LIMIT $3`,
    [
      [...COMMUNITY_HOME_TRANSLATION_LANGS],
      TRANSLATION_MAX_ATTEMPTS,
      limit,
      serverIds,
      CLAIM_LEASE_SECONDS,
      communityHomeTranslationMaxSourceChars(),
      remaining,
    ],
  );
  if (rows.length === 0) {
    sweepState("idle", { reason: "nothing_missing" });
    idleSignature = signature;
    idleUntil = Date.now() + IDLE_RESCAN_MS;
    return { attempted: 0 };
  }
  idleUntil = 0;
  lastSweepState = "working";
  logEvent("communityHome.translation.sweep", {
    state: "working",
    candidates: rows.length,
  });
  await Promise.all(rows.map((r) => runQueued(r.post_id, r.lang)));
  return { attempted: rows.length };
}

// ---------------------------------------------------------------------- reads

export interface TranslationReadRow {
  post_id: string;
  title: string | null;
  body: string;
  teaser: string | null;
  source_lang: string | null;
  same_language: boolean;
  source_hash: string;
}

/** One reader's language, for a page of posts: the rows, fresh or not (the caller checks the hash). */
export async function loadTranslationRows(
  postIds: string[],
  lang: CommunityHomeTranslationLang,
): Promise<Map<string, TranslationReadRow>> {
  const map = new Map<string, TranslationReadRow>();
  if (postIds.length === 0) {
    return map;
  }
  const { rows } = await getPool().query<TranslationReadRow>(
    `SELECT post_id, title, body, teaser, source_lang, same_language, source_hash
       FROM community_home_post_translations
      WHERE post_id = ANY($1::uuid[]) AND lang = $2`,
    [postIds, lang],
  );
  for (const row of rows) {
    map.set(row.post_id, row);
  }
  return map;
}

/** Staff, read only: every stored translation of one post, with whether it is still current. */
export async function listPostTranslations(
  postId: string,
): Promise<CommunityHomePostTranslationRow[]> {
  const { rows } = await getPool().query<
    TranslationReadRow & {
      lang: CommunityHomeTranslationLang;
      model: string;
      created_at: Date;
      current_hash: string;
    }
  >(
    `SELECT t.post_id, t.lang, t.title, t.body, t.teaser, t.source_lang,
            t.same_language, t.source_hash, t.model, t.created_at,
            ${sourceHashSql("p")} AS current_hash
       FROM community_home_post_translations t
       JOIN community_home_posts p ON p.id = t.post_id
      WHERE t.post_id = $1
      ORDER BY t.lang`,
    [postId],
  );
  return rows.map((row) => ({
    lang: row.lang,
    title: row.title,
    body: row.body,
    teaser: row.teaser,
    sourceLang: row.source_lang,
    sameLanguage: row.same_language,
    stale: row.source_hash !== row.current_hash,
    model: row.model,
    createdAt: row.created_at.toISOString(),
  }));
}
