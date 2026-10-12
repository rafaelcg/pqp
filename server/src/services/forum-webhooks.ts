import { createHash } from "node:crypto";
import {
  FORUM_ERRORS,
  FORUM_MAX_TAGS_PER_POST,
  FORUM_TITLE_MAX,
  FORUM_WEBHOOK_POST_BURST,
  FORUM_WEBHOOK_POST_REFILL_MS,
  WEBHOOK_FORUM_SETTINGS_DEFAULTS,
  WEBHOOK_FORUM_THREAD_NAME_CODE,
  type ExecuteWebhookBody,
  type ForumPostSummary,
  type WebhookForumSettings,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { sharedRateLimit } from "../lib/cluster-rate-limit.js";
import { forumChannelsEnabled } from "../lib/forum-config.js";
import {
  announceForumPost,
  announceForumPostUpdate,
  broadcastToChannel,
} from "../ws/chat.js";
import { WEBHOOK_FORUM_THREAD_NAME_MESSAGE } from "./forum-guards.js";
import {
  bumpForumPostActivity,
  createForumPostShell,
  discardForumPostShell,
  ForumError,
  getForumPostRow,
  getForumPostSummary,
  publishForumPost,
} from "./forums.js";
import { getHydratedMessage, mapMessage } from "./messages.js";
import {
  executeWebhook,
  executeWebhookIntoOpenPost,
  type DbWebhook,
} from "./webhooks.js";

/**
 * Webhooks into a forum (plan §7, forum PR 4): one execution, one post.
 *
 * A webhook on a forum speaks Discord's forum dialect, so an RSS tool built
 * for Discord works unchanged: `thread_name` is the post title, `applied_tags`
 * picks tags (by id or by name), `?thread_id=` replies in an existing post.
 * pqp adds two things Discord does not have, both because RSS tools re-send
 * after a restart and a forum is the one place a repeat is loud:
 *
 *  - THE TITLE FALLS BACK. No `thread_name`: the first embed's title, then the
 *    first line of `content` with its markdown and bare links stripped. Only
 *    when none of those leaves any text is the execute refused, with Discord's
 *    own 220001, so a tool that knows Discord forums recognises it.
 *  - DEDUPE. Each post carries a key (the `Idempotency-Key` header, else a
 *    hash of the folded title and the item's canonical link), and the same
 *    key inside the webhook's window answers the post that exists, with the
 *    header `X-Pqp-Deduplicated: 1`, writing nothing and notifying nobody.
 *    Per forum, not per webhook: two feeds carrying one story post it once.
 *
 * A webhook is a pipe, not a resident (`handleWebhookExecute`'s comment), so
 * none of the person-only gates of `forum-posts.ts` apply: no AutoMod, no
 * slow mode, no mentions recorded. Its budget is the per-process execute
 * limiter in front of this, plus a CLUSTER-WIDE post bucket here (10 burst,
 * one a minute, per webhook), so two machines allow 60 posts an hour and not
 * twice that. Replies spend only the per-process limiter.
 *
 * A webhook never CREATES a tag: a feed's vocabulary is unbounded and every
 * tag is a chip every reader sees. It applies only tags in its allowlist
 * (`webhook_forum_settings.allowed_tag_ids`; NULL is every non-moderated tag,
 * a staff-only tag must be listed by id), and what does not resolve comes
 * back as `ignored_tags` so whoever set the tool up can see why a chip is
 * missing. When nothing resolves the webhook's default tags apply.
 */

// --------------------------------------------------------------- refusals

/**
 * A refusal with a Discord-shaped body. `error` is the house `sendError`
 * field; `message` (and `code`, `retry_after`) are what a Discord client
 * reads. The route sends it as is, plus `Retry-After` when there is a wait.
 */
export class ForumWebhookRefusal extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
    readonly retryAfterSeconds?: number,
  ) {
    super(String(body.error ?? body.message ?? "Refused"));
    this.name = "ForumWebhookRefusal";
  }
}

/** Discord's own 429 body, so a tool built for Discord backs off by it. */
export function webhookRateLimitedBody(retryAfterSeconds: number): Record<string, unknown> {
  return {
    error: "Too many requests",
    message: "You are being rate limited.",
    retry_after: retryAfterSeconds,
    global: false,
  };
}

const THREAD_NAME_REQUIRED = new ForumWebhookRefusal(400, {
  error: WEBHOOK_FORUM_THREAD_NAME_MESSAGE,
  message: WEBHOOK_FORUM_THREAD_NAME_MESSAGE,
  code: WEBHOOK_FORUM_THREAD_NAME_CODE,
});

// ------------------------------------------------------------------ title

// The same characters `forumTitleSchema` refuses. A title from a feed is
// cleaned, never refused, because the person who could fix it is not here.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/** One line, trimmed, at most `FORUM_TITLE_MAX` code points; null when empty. */
function cleanTitle(raw: string): string | null {
  const flat = raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  if (!flat) {
    return null;
  }
  const points = Array.from(flat);
  return points.length > FORUM_TITLE_MAX
    ? points.slice(0, FORUM_TITLE_MAX).join("").trimEnd()
    : flat;
}

const URL_IN_TEXT = /<?https?:\/\/[^\s<>]+>?/gi;

/**
 * A `content` line as a headline: markdown links keep their text, bare links
 * go, and the marks a feed tool puts around a headline (a heading, a quote,
 * a list bullet, bold or italic around the whole line) come off.
 */
function lineAsHeadline(line: string): string {
  return line
    .replace(/\[([^\]]*)\]\((?:[^()\s]+)\)/g, "$1")
    .replace(URL_IN_TEXT, " ")
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+)/, "")
    .replace(/^\s*(\*\*|__|\*|_)(.+)\1\s*$/, "$2");
}

/**
 * The post's title: `thread_name`, else the first embed's title, else the
 * first line of `content` that is still text once links and markdown are
 * gone. Null when the payload carries no headline at all (an embed with only
 * a description), which is Discord's 220001.
 */
export function deriveWebhookPostTitle(body: ExecuteWebhookBody): string | null {
  const named = cleanTitle(body.thread_name ?? "");
  if (named) {
    return named;
  }
  const embedTitle = cleanTitle(body.embeds?.[0]?.title ?? "");
  if (embedTitle) {
    return embedTitle;
  }
  for (const line of (body.content ?? "").split(/\r?\n/)) {
    const headline = cleanTitle(lineAsHeadline(line));
    if (headline) {
      return headline;
    }
  }
  return null;
}

// ------------------------------------------------------------------- tags

/** Case- and accent-insensitive: "noticias" is "Notícias", "LANÇAMENTO" is "Lançamento". */
export function foldTagName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export interface ForumTagChoice {
  id: string;
  name: string;
  moderated: boolean;
}

/**
 * `applied_tags` against this forum's tags and this webhook's settings. Each
 * entry is tried as a tag id, then as a tag name. An entry that matches no
 * tag, matches one outside the allowlist, repeats one already chosen, or
 * comes after `FORUM_MAX_TAGS_PER_POST` were chosen is ignored and reported
 * (a repeat is not reported: nothing is missing because of it). Nothing
 * chosen: the default tags, those that still exist.
 */
export function resolveWebhookTags(
  applied: ReadonlyArray<string | number> | null | undefined,
  forumTags: readonly ForumTagChoice[],
  settings: WebhookForumSettings,
): { tagIds: string[]; ignored: string[] } {
  const byId = new Map(forumTags.map((tag) => [tag.id.toLowerCase(), tag]));
  const byName = new Map(forumTags.map((tag) => [foldTagName(tag.name), tag]));
  const allowedIds = settings.allowedTagIds ? new Set(settings.allowedTagIds) : null;
  const allowed = (tag: ForumTagChoice) =>
    allowedIds ? allowedIds.has(tag.id) : !tag.moderated;

  const tagIds: string[] = [];
  const ignored: string[] = [];
  for (const entry of applied ?? []) {
    const raw = String(entry).trim();
    const tag = byId.get(raw.toLowerCase()) ?? byName.get(foldTagName(raw));
    if (tag && tagIds.includes(tag.id)) {
      continue;
    }
    if (!tag || !allowed(tag) || tagIds.length >= FORUM_MAX_TAGS_PER_POST) {
      ignored.push(String(entry));
      continue;
    }
    tagIds.push(tag.id);
  }
  if (tagIds.length === 0) {
    const existing = new Set(forumTags.map((tag) => tag.id));
    for (const id of settings.defaultTagIds) {
      if (existing.has(id) && !tagIds.includes(id) && tagIds.length < FORUM_MAX_TAGS_PER_POST) {
        tagIds.push(id);
      }
    }
  }
  return { tagIds, ignored };
}

async function readForumTagChoices(forumId: string): Promise<ForumTagChoice[]> {
  const result = await getPool().query<ForumTagChoice>(
    `SELECT id, name, moderated FROM forum_tags
      WHERE forum_id = $1
      ORDER BY position, created_at, id`,
    [forumId],
  );
  return result.rows;
}

// ----------------------------------------------------------------- dedupe

/**
 * The item's link with what does not identify it removed: the fragment and
 * every `utm_*` parameter. Anything that does not parse as a URL is used as
 * it came.
 */
export function canonicalItemLink(raw: string): string {
  const trimmed = raw.trim().replace(/^<|>$/g, "");
  try {
    const url = new URL(trimmed);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return trimmed;
  }
}

function firstLink(body: ExecuteWebhookBody): string | null {
  const embedUrl = body.embeds?.[0]?.url;
  if (embedUrl) {
    return embedUrl;
  }
  const match = /https?:\/\/[^\s<>)\]]+/i.exec(body.content ?? "");
  return match ? match[0] : null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The dedupe key. The caller's `Idempotency-Key` wins (n8n, Zapier, Make and
 * a script can all set one, usually to the item's GUID). Otherwise the folded
 * title plus the canonical first link; with no link at all, the folded title
 * plus the first 500 characters of `content`. Hashed, so the index holds a
 * fixed 64 characters whatever the caller sent, and prefixed by kind so a
 * header can never collide with a derived key.
 */
export function webhookDedupeKey(
  title: string,
  body: ExecuteWebhookBody,
  idempotencyKey: string | null,
): string {
  const header = idempotencyKey?.trim();
  if (header) {
    return sha256(`header\n${header}`);
  }
  const folded = foldTagName(title);
  const link = firstLink(body);
  if (link) {
    return sha256(`link\n${folded}\n${canonicalItemLink(link)}`);
  }
  const content = Array.from(body.content ?? "").slice(0, 500).join("");
  return sha256(`text\n${folded}\n${content}`);
}

/** A post of this forum with this key inside the window, shell or published. */
async function findDuplicate(
  forumId: string,
  key: string,
  hours: number,
): Promise<string | null> {
  const result = await getPool().query<{ channel_id: string }>(
    `SELECT channel_id FROM forum_posts
      WHERE forum_id = $1 AND dedupe_key = $2
        AND created_at > NOW() - make_interval(hours => $3::int)
      ORDER BY created_at DESC
      LIMIT 1`,
    [forumId, key, hours],
  );
  return result.rows[0]?.channel_id ?? null;
}

/** How long a repeat waits for the first copy's opening message to land. */
const DUPLICATE_WAIT_MS = 3_000;
const DUPLICATE_POLL_MS = 100;

/**
 * The answer to a repeat: the post that exists and its opening message. When
 * the first copy is still a shell (it is between its shell and its message,
 * a few milliseconds), wait for it. Null when it is gone (it failed and was
 * discarded), so the caller may create the post after all.
 */
async function duplicateAnswer(postId: string): Promise<ForumWebhookResult | null> {
  const deadline = Date.now() + DUPLICATE_WAIT_MS;
  for (;;) {
    const state = await getPool().query<{
      published: boolean;
      opening_message_id: string | null;
    }>(
      `SELECT published_at IS NOT NULL AS published, opening_message_id
         FROM forum_posts WHERE channel_id = $1`,
      [postId],
    );
    const row = state.rows[0];
    if (!row) {
      return null;
    }
    if (row.published) {
      const [post, message] = await Promise.all([
        getForumPostSummary(postId),
        row.opening_message_id ? getHydratedMessage(row.opening_message_id) : null,
      ]);
      if (!post) {
        return null;
      }
      return {
        message: message ? mapMessage(message) : null,
        postId,
        post,
        ignoredTags: [],
        deduplicated: true,
        reply: false,
      };
    }
    if (Date.now() > deadline) {
      throw new ForumWebhookRefusal(
        409,
        { error: "Post is being created", message: "Post is being created", retry_after: 1 },
        1,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, DUPLICATE_POLL_MS));
  }
}

// --------------------------------------------------------------- settings

/** Every webhook's settings, defaults for those with no row. */
export async function readWebhookForumSettings(
  webhookIds: readonly string[],
): Promise<Map<string, WebhookForumSettings>> {
  const out = new Map<string, WebhookForumSettings>();
  if (webhookIds.length === 0) {
    return out;
  }
  const result = await getPool().query<{
    webhook_id: string;
    allowed_tag_ids: string[] | null;
    default_tag_ids: string[];
    dedupe_window_hours: number;
  }>(
    `SELECT webhook_id, allowed_tag_ids, default_tag_ids, dedupe_window_hours
       FROM webhook_forum_settings
      WHERE webhook_id = ANY($1::uuid[])`,
    [webhookIds],
  );
  const byId = new Map(result.rows.map((row) => [row.webhook_id, row]));
  for (const id of webhookIds) {
    const row = byId.get(id);
    out.set(
      id,
      row
        ? {
            allowedTagIds: row.allowed_tag_ids,
            defaultTagIds: row.default_tag_ids,
            dedupeWindowHours: row.dedupe_window_hours,
          }
        : { ...WEBHOOK_FORUM_SETTINGS_DEFAULTS },
    );
  }
  return out;
}

export async function getWebhookForumSettings(
  webhookId: string,
): Promise<WebhookForumSettings> {
  return (await readWebhookForumSettings([webhookId])).get(webhookId)!;
}

/**
 * Replace a webhook's settings (the PUT). Every tag id must be one of the
 * forum's tags; repeats collapse. `before` is for the audit row.
 */
export async function putWebhookForumSettings(
  webhookId: string,
  forumId: string,
  settings: WebhookForumSettings,
): Promise<{ before: WebhookForumSettings; after: WebhookForumSettings }> {
  const tagIds = new Set((await readForumTagChoices(forumId)).map((tag) => tag.id));
  const allowed = settings.allowedTagIds ? [...new Set(settings.allowedTagIds)] : null;
  const defaults = [...new Set(settings.defaultTagIds)];
  if ([...(allowed ?? []), ...defaults].some((id) => !tagIds.has(id))) {
    throw new ForumError(400, FORUM_ERRORS.tagUnknown);
  }
  const before = await getWebhookForumSettings(webhookId);
  const result = await getPool().query<{
    allowed_tag_ids: string[] | null;
    default_tag_ids: string[];
    dedupe_window_hours: number;
  }>(
    `INSERT INTO webhook_forum_settings
       (webhook_id, allowed_tag_ids, default_tag_ids, dedupe_window_hours)
     VALUES ($1, $2::uuid[], $3::uuid[], $4)
     ON CONFLICT (webhook_id) DO UPDATE
       SET allowed_tag_ids = EXCLUDED.allowed_tag_ids,
           default_tag_ids = EXCLUDED.default_tag_ids,
           dedupe_window_hours = EXCLUDED.dedupe_window_hours
     RETURNING allowed_tag_ids, default_tag_ids, dedupe_window_hours`,
    [webhookId, allowed, defaults, settings.dedupeWindowHours],
  );
  const row = result.rows[0]!;
  return {
    before,
    after: {
      allowedTagIds: row.allowed_tag_ids,
      defaultTagIds: row.default_tag_ids,
      dedupeWindowHours: row.dedupe_window_hours,
    },
  };
}

// ---------------------------------------------------------------- execute

/** Ten posts burst, then one a minute, per webhook, counted across instances. */
export const FORUM_WEBHOOK_POST_BUCKET = {
  bucket: "forum-webhook-post",
  capacity: FORUM_WEBHOOK_POST_BURST,
  refillPerSecond: 1000 / FORUM_WEBHOOK_POST_REFILL_MS,
} as const;

const POST_BUCKET_RETRY_SECONDS = Math.ceil(FORUM_WEBHOOK_POST_REFILL_MS / 1000);

export interface ForumWebhookResult {
  /** The opening message, or the reply. Null only for a repeat whose opening was deleted. */
  message: ReturnType<typeof mapMessage> | null;
  /** The post written to (or answered from the dedupe window). */
  postId: string;
  /**
   * Its row. Null when reading it back failed after the write landed: the
   * write stands and the execute still answers 200, because a tool that sees
   * an error re-sends, and a re-sent reply would be a second reply.
   */
  post: ForumPostSummary | null;
  /** `applied_tags` entries that did not become a tag. */
  ignoredTags: string[];
  /** Answered from the dedupe window: nothing was written. */
  deduplicated: boolean;
  /** A `?thread_id=` reply rather than a new post. */
  reply: boolean;
}

export interface ExecuteForumWebhookInput {
  webhook: DbWebhook;
  forum: { id: string; server_id: string | null };
  body: ExecuteWebhookBody;
  /** `?thread_id=`: reply in this post instead of creating one. */
  threadId: string | null;
  /** The `Idempotency-Key` request header. */
  idempotencyKey: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An execute on a webhook whose channel is a forum. */
export async function executeForumWebhook(
  input: ExecuteForumWebhookInput,
): Promise<ForumWebhookResult> {
  return input.threadId !== null
    ? replyInPost(input, input.threadId)
    : createPostFromWebhook(input);
}

/**
 * `?thread_id=`: a reply in a published post of THIS webhook's forum, refused
 * like a person's reply when the post is locked. Not gated by the flag: off
 * stops new posts, and existing ones stay repliable.
 */
async function replyInPost(
  input: ExecuteForumWebhookInput,
  threadId: string,
): Promise<ForumWebhookResult> {
  const post = UUID.test(threadId) ? await getForumPostRow(threadId) : null;
  if (!post || post.forum_id !== input.forum.id) {
    // Discord's answer to a thread id it does not know.
    throw new ForumWebhookRefusal(404, {
      error: "Unknown Channel",
      message: "Unknown Channel",
      code: 10003,
    });
  }
  const locked = new ForumWebhookRefusal(403, {
    error: "This post is locked",
    message: "This post is locked",
    reason: "locked",
  });
  if (post.locked_at !== null) {
    throw locked;
  }
  // The lock is checked again inside the INSERT itself, so a moderator who
  // locks the post after the read above still wins.
  const message = await executeWebhookIntoOpenPost(input.webhook, input.body, post.channel_id);
  if (!message) {
    throw locked;
  }
  const mapped = mapMessage(message);
  broadcastToChannel(post.channel_id, { type: "message-broadcast", message: mapped });
  // The bump the send path makes for a person's reply: the post moves up and
  // every forum viewer gets the fresh row. Bookkeeping after the write: a
  // failure here is logged, never answered as a failed execute.
  let summary: ForumPostSummary | null = null;
  try {
    await bumpForumPostActivity(post.channel_id, message.created_at);
    summary = await getForumPostSummary(post.channel_id);
    if (summary) {
      announceForumPostUpdate(summary);
    }
  } catch (error) {
    console.error("[forums] webhook reply bump failed:", error);
  }
  return {
    message: mapped,
    postId: post.channel_id,
    post: summary,
    ignoredTags: [],
    deduplicated: false,
    reply: true,
  };
}

async function createPostFromWebhook(
  input: ExecuteForumWebhookInput,
): Promise<ForumWebhookResult> {
  const { webhook, forum, body } = input;
  if (!forum.server_id || !forumChannelsEnabled(forum.server_id)) {
    throw new ForumWebhookRefusal(403, {
      error: FORUM_ERRORS.off,
      message: "Forum channels are off on this server",
    });
  }
  const title = deriveWebhookPostTitle(body);
  if (!title) {
    throw THREAD_NAME_REQUIRED;
  }

  const [settings, forumTags] = await Promise.all([
    getWebhookForumSettings(webhook.id),
    readForumTagChoices(forum.id),
  ]);
  const { tagIds, ignored } = resolveWebhookTags(body.applied_tags, forumTags, settings);
  const dedupeKey = webhookDedupeKey(title, body, input.idempotencyKey);
  const windowHours = settings.dedupeWindowHours;

  // A repeat costs no post budget: answered before the bucket. The locked
  // check inside the shell transaction below is what makes it exact; this
  // read only keeps an ordinary re-send off the bucket. Copies of one item
  // arriving at the same instant all miss it and each spend a token before
  // the lock answers all but one: a cost of concurrency, not a double post.
  if (windowHours > 0) {
    const existing = await findDuplicate(forum.id, dedupeKey, windowHours);
    if (existing) {
      const answer = await duplicateAnswer(existing);
      if (answer) {
        return answer;
      }
    }
  }

  if (!(await spendPostToken(webhook.id))) {
    throw new ForumWebhookRefusal(
      429,
      webhookRateLimitedBody(POST_BUCKET_RETRY_SECONDS),
      POST_BUCKET_RETRY_SECONDS,
    );
  }

  const shell = await createForumPostShell({
    forumId: forum.id,
    serverId: forum.server_id,
    authorId: webhook.pseudo_user_id,
    title,
    tagIds,
    nonce: null,
    dedupeKey,
    dedupeWindowHours: windowHours,
  });
  if (shell.kind !== "created") {
    // Another execute of the same item won the lock a moment ago.
    const answer = await duplicateAnswer(shell.postId);
    if (answer) {
      return answer;
    }
    // It failed and was discarded; the tool's retry will post it.
    throw new ForumWebhookRefusal(
      409,
      { error: "Post is being created", message: "Post is being created", retry_after: 1 },
      1,
    );
  }
  const postId = shell.postId;

  let message;
  try {
    message = await executeWebhook(webhook, body, postId);
    await publishForumPost(postId, message.id);
  } catch (error) {
    await discardForumPostShell(postId, forum.id).catch((discardError: unknown) => {
      // The sweep removes it within FORUM_SHELL_TTL_MS.
      console.error("[forums] webhook shell cleanup failed:", discardError);
    });
    throw error;
  }

  // The post exists from here on: a failed read or fan-out is logged, never
  // answered as a failed execute (the tool would re-send it, and with dedupe
  // off that is a second post).
  let post: ForumPostSummary | null = null;
  try {
    post = await getForumPostSummary(postId);
    if (post) {
      await announceForumPost(post, webhook.pseudo_user_id);
    }
  } catch (error) {
    console.error("[forums] webhook announce failed:", error);
  }
  return {
    message: mapMessage(message),
    postId,
    post,
    ignoredTags: ignored,
    deduplicated: false,
    reply: false,
  };
}

/**
 * The cluster bucket. Fails open, as `sharedRateLimit` promises its callers:
 * a database hiccup here degrades to the per-process limiter in front of
 * this, never to a feed that cannot post.
 */
async function spendPostToken(webhookId: string): Promise<boolean> {
  try {
    return await sharedRateLimit(FORUM_WEBHOOK_POST_BUCKET, webhookId);
  } catch (error) {
    console.error("[forums] webhook post bucket failed open:", error);
    return true;
  }
}
