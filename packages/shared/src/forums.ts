import { z } from "zod";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "./attachments.js";
import { clampChatNewlines } from "./chat-text.js";

/**
 * Forum channels: the wire contract. Frozen in PR 0 so the server, web and
 * mobile PRs can be built in parallel against one shape. Plan:
 * docs/plans/FORUM_CHANNELS.md (engineering) and the UX study beside it.
 *
 * THE MODEL, STATED ONCE: A FORUM IS A CHANNEL THAT HOLDS POSTS, AND A POST IS
 * A THREAD. The forum is a `channels` row with `type = 'forum'` that never
 * carries a message of its own. Each post is a `channels` row with
 * `type = 'thread'`, `parent_id` = the forum and `thread_root_message_id`
 * NULL, so visibility, overwrites, read cursors, mentions, search, retention,
 * reports and the fan-out audience all cover posts because a post is a
 * channel (the same argument as `threads.ts`). What a chat thread does not
 * need lives in side tables (`server/src/schema.sql`, "forum channels"):
 *
 *   forum_posts             one row per post: author, opening message, pinned /
 *                           locked / resolved, the accepted answer, the bumped
 *                           `last_activity_at` the list sorts on, nonce, dedupe
 *   forum_tags              the forum's tags (20 max), some staff-only
 *   forum_post_tags         post <-> tag
 *   forum_post_follows      who follows a post (P2 push; inert until then)
 *   forum_settings          per forum: require a tag, default sort
 *   webhook_forum_settings  per webhook into a forum: tag allowlist, default
 *                           tags, dedupe window (P1b)
 *
 * Nothing new is ever a column on `channels` (CLAUDE.md pitfall 22: every
 * `ADD COLUMN IF NOT EXISTS` takes ACCESS EXCLUSIVE before it checks).
 *
 * This file imports nothing from `api.ts` or `chat.ts`, the same rule as
 * `threads.ts`: `chat.ts` imports the two frames from here.
 *
 * -------------------------------------------------------------------------
 * GUIDELINES ARE THE CHANNEL TOPIC. A forum's "Regras do fórum" banner is
 * `channels.topic` (max 200, the existing column, the existing settings field
 * and `updateChannelSchema.topic`). No new storage. Longer rules go in a
 * pinned, locked post.
 *
 * PER-FORUM SETTINGS (`forumSettingsSchema`): `requireTag` (a post needs at
 * least one tag; the create route answers 422 `forum_tag_required`) and
 * `defaultSort` (what the list uses when the request names no `sort`). Stored
 * in `forum_settings`; no row means `FORUM_SETTINGS_DEFAULTS`.
 *
 * -------------------------------------------------------------------------
 * REST SURFACE (frozen here; implemented in PR 1 unless noted)
 *
 * | Route                                              | Body / query                    | Answer                                   | Who |
 * |----------------------------------------------------|---------------------------------|------------------------------------------|-----|
 * | GET    /api/forum/config?serverId=                 |                                 | `ForumConfig`                            | any signed-in account (PR 0) |
 * | GET    /api/channels/:forumId/posts                | `listForumPostsQuerySchema`     | `ForumPostListResponse`                  | can see the forum |
 * | GET    /api/channels/:forumId/posts/similar?title= | `similarForumPostsQuerySchema`  | `{ posts: ForumPostSummary[] }`          | can see the forum |
 * | POST   /api/channels/:forumId/posts                | `createForumPostSchema`         | 201 `{ post, viewer }`; 200 on a nonce retry | SEND_MESSAGES on the forum |
 * | GET    /api/forum-posts/:postId                    |                                 | `ForumPostDetailResponse`                | can see the forum (deep links) |
 * | PATCH  /api/forum-posts/:postId                    | `updateForumPostSchema`         | `{ post }`                               | per field, see below |
 * | DELETE /api/forum-posts/:postId                    |                                 | 204                                      | MANAGE_MESSAGES / MANAGE_CHANNELS on the forum |
 * | PUT    /api/forum-posts/:postId/follow             | `setForumPostFollowSchema`      | `{ viewer }`                             | can see the forum (P2) |
 * | GET    /api/channels/:forumId/forum-tags           |                                 | `{ tags: ForumTag[] }`                   | can see the forum |
 * | PUT    /api/channels/:forumId/forum-tags           | `putForumTagsSchema`            | `{ tags: ForumTag[] }`                   | MANAGE_CHANNELS on the forum |
 * | GET    /api/channels/:forumId/forum-settings       |                                 | `{ settings: ForumSettings }`            | can see the forum |
 * | PATCH  /api/channels/:forumId/forum-settings       | `updateForumSettingsSchema`     | `{ settings: ForumSettings }`            | MANAGE_CHANNELS on the forum |
 * | PUT    /api/webhooks/:webhookId/forum-settings     | `webhookForumSettingsSchema`    | `{ settings: WebhookForumSettings }`     | MANAGE_CHANNELS (P1b) |
 *
 * PATCH /api/forum-posts/:postId, field by field: `title`, `tagIds`,
 * `resolved` and `acceptedAnswerId` are the author's or staff's
 * (MANAGE_MESSAGES or MANAGE_CHANNELS on the forum); `pinned` and `locked` are
 * staff only; a moderated tag is applied or removed by staff only. Pin, lock,
 * delete and staff edits of someone else's post write audit rows
 * (`forum.post_pin`, `forum.post_lock`, `forum.post_delete`,
 * `forum.post_edit`); tag and settings edits write `forum.tags_update` and
 * `forum.settings_update`.
 *
 * Creating the forum CHANNEL itself is the ordinary
 * `POST /api/servers/:serverId/channels` with `type: "forum"`, refused 403
 * `forum_channels_off` unless the runtime flag `forum_channels` is on for that
 * server (PR 0).
 *
 * Deep link: `/app/server/<serverId>/channel/<forumId>/post/<postId>`.
 *
 * ERRORS: `{ error: <FORUM_ERRORS value> }`, the house `sendError` shape. A
 * create refused by the message path (slow mode, AutoMod, timeout, the post
 * bucket) is 422 with `forumPostRejectedBodySchema` (in `chat.ts`), i.e. the
 * same `reason` / `retryAfterMs` / `automodMessage` a `message-rejected`
 * frame carries, so the composer reuses its copy.
 *
 * -------------------------------------------------------------------------
 * LIST SEMANTICS
 *
 * - Two orders: `activity` (`last_activity_at`, bumped by every reply; a
 *   deleted reply never un-bumps) and `created`. Keyset on (sort key, post id).
 *   `sort` absent = the forum's `defaultSort`.
 * - Tags are AND: several `tag` values return the posts that carry EVERY one
 *   of them. Picking more narrows (the top complaint about Discord's OR).
 * - `status`: `open` = not resolved, `resolved` = resolved. Absent = both.
 * - PINNED POSTS IGNORE THE TAG, STATUS AND `mine` FILTERS: they are returned
 *   on page 1 only, in `pinned`, whatever is filtered, and never repeated in
 *   `posts`. They are hidden (empty `pinned`) while `q` is set.
 * - `q` matches titles, case- and accent-insensitive, and bypasses the cache.
 * - A post never auto-archives; there is no `archived` field.
 *
 * UNREAD
 *
 * - "Novo": the viewer never opened the post (`lastReadAt` null), it is not
 *   theirs, and it was created after `forumPreviousReadAt`.
 * - "Unread": opened before and `lastActivityAt > lastReadAt`;
 *   `newReplyCount` says how many replies by others arrived since (cap 99).
 * - The forum's sidebar row (`GET /api/servers/:id/unread`, PR 2): its `count`
 *   is the number of new posts by others after the forum's cursor (cap 99);
 *   its `mentions` is the viewer's mentions inside posts after each post's
 *   cursor; posts never get rows of their own there. A reply in a post the
 *   viewer never opened does not light the forum.
 *
 * FOLLOWING (P2, stored from PR 0 so there is one schema deploy)
 *
 * `forum_post_follows (post_id, user_id, created_at, muted)`. A row with
 * `muted = false` is "following": P2 pushes replies to followers (at most one
 * per post per 10 minutes, respecting mute and DND). A row with
 * `muted = true` is an explicit "stop following", kept so an automatic follow
 * never re-adds it. The author follows their own post automatically; replying
 * does NOT follow. `ForumPostViewer.following` reads `row exists AND NOT
 * muted`, so a muted row and no row both read false.
 *
 * ACCEPTED ANSWER
 *
 * `forum_posts.resolved_message_id`: a reply in the post that the author or
 * staff picked as the answer ("Marcar como solução"). Setting it also marks
 * the post resolved; `resolved: false` clears it. A resolve with no answer
 * stays allowed. No foreign key, on purpose (same reasoning as
 * `opening_message_id`): a deleted answer keeps its id, so the post can say
 * "A resposta marcada foi apagada" instead of silently losing the fact that it
 * had one, and no message delete in the product pays a lookup on this table.
 * The summary carries the id; the detail route carries the excerpt.
 *
 * CARD EXTRAS (all computed on read, no stored column)
 *
 * - `thumbnailUrl`: the first image attachment of the opening message, signed
 *   exactly like a message attachment (`ATTACHMENT_URL_TTL_SECONDS`), with
 *   its id and size so a long-lived list can refresh an expired URL through
 *   `GET /api/attachments/:id/url`. Null when the opening message has no image
 *   (or attachments are off).
 * - `reactionCount` and `topReaction`: the opening message's reactions.
 * - `replyCount`: messages in the post other than the opening one.
 *
 * -------------------------------------------------------------------------
 * WEBHOOKS INTO A FORUM (P1b; the contract lands now and stays inert)
 *
 * - `executeWebhookSchema` (`webhooks.ts`) accepts Discord's `thread_name`
 *   and `applied_tags`. Until P1b they are parsed and ignored, which is what
 *   happened to them before (silently stripped).
 * - An execute into a forum answers `{ id, channel_id, message, post, ignored_tags? }`
 *   (`webhookForumExecuteExtrasSchema` is the part beside `message`), and a
 *   dedupe hit adds the header `WEBHOOK_DEDUPLICATED_HEADER: 1`.
 * - `?thread_id=<postId>` replies into an existing post of that forum.
 * - No title derivable: 400 with Discord's code `WEBHOOK_FORUM_THREAD_NAME_CODE`.
 * - `PUT /api/webhooks/:webhookId/forum-settings` takes
 *   `webhookForumSettingsSchema`. `GET /api/channels/:forumId/webhooks`
 *   answers each webhook with its `forumSettings` and the forum's tags as
 *   `forumTags` beside the list (null on any other channel), so the settings
 *   section draws from one request.
 */

// ------------------------------------------------------------------ caps

/** Tags a forum may define. Discord's number. */
export const FORUM_MAX_TAGS = 20;
/** Tags on one post. */
export const FORUM_MAX_TAGS_PER_POST = 5;
/** Pinned posts per forum. */
export const FORUM_MAX_PINNED = 3;
/** Post title length, 1 to this. Discord's forum limit, so imported habits fit. */
export const FORUM_TITLE_MAX = 100;
/** Tag name length, 1 to this. */
export const FORUM_TAG_NAME_MAX = 20;
/** One unicode emoji, stored as text; generous for ZWJ sequences. */
export const FORUM_TAG_EMOJI_MAX = 16;
/** Posts per list page by default. */
export const FORUM_PAGE_SIZE = 25;
/** The most a client may ask for in one page. */
export const FORUM_PAGE_MAX = 50;
/** Title search query length. */
export const FORUM_SEARCH_MAX = 100;
/** "Posts parecidos": at most this many. */
export const FORUM_SIMILAR_MAX = 5;
/** Characters of the opening message on a card. */
export const FORUM_PREVIEW_MAX = 200;
/** Characters of the accepted answer quoted under the opening message. */
export const FORUM_ANSWER_EXCERPT_MAX = 280;
/** Unread counts (forum row, per-post new replies) stop here. */
export const FORUM_UNREAD_CAP = 99;
/**
 * The opening message body. Restated from `MESSAGE_MAX_LENGTH` in `api.ts`
 * because this module must not import it; `forums.test.ts` pins the two equal.
 */
export const FORUM_BODY_MAX = 4000;
/** Posts a person may create per window, cluster-wide (`sharedRateLimit`). */
export const FORUM_POSTS_PER_WINDOW = 5;
export const FORUM_POST_WINDOW_MS = 10 * 60 * 1000;
/** A webhook's post bucket: burst, then one per minute, cluster-wide. */
export const FORUM_WEBHOOK_POST_BURST = 10;
export const FORUM_WEBHOOK_POST_REFILL_MS = 60 * 1000;
/** A shell (post created, opening message not yet landed) older than this is swept. */
export const FORUM_SHELL_TTL_MS = 10 * 60 * 1000;
/** Webhook dedupe window: default and ceiling, in hours. 0 turns it off. */
export const FORUM_WEBHOOK_DEDUPE_HOURS_DEFAULT = 72;
export const FORUM_WEBHOOK_DEDUPE_HOURS_MAX = 720;

// ---------------------------------------------------------------- errors

/** The `error` token of a forum refusal. Clients i18n these by value. */
export const FORUM_ERRORS = {
  /** 403: the runtime flag `forum_channels` is off for this server. */
  off: "forum_channels_off",
  /** 422: the forum requires a tag and the post names none. */
  tagRequired: "forum_tag_required",
  /** 403: a member tried to apply or remove a staff-only tag. */
  tagModerated: "forum_tag_moderated",
  /** 400: a tag id that is not one of this forum's tags. */
  tagUnknown: "forum_tag_unknown",
  /** 409: the forum already has `FORUM_MAX_PINNED` pinned posts. */
  pinLimit: "forum_pin_limit",
  /** 400: `acceptedAnswerId` is not a reply in this post. */
  answerInvalid: "forum_answer_invalid",
  /** 422: the opening message (or the title, under AutoMod) was refused. */
  postRejected: "forum_post_rejected",
} as const;
export type ForumErrorCode = (typeof FORUM_ERRORS)[keyof typeof FORUM_ERRORS];

// ------------------------------------------------------------ primitives

// Same rule as `safeTextSchema` in api.ts, restated (see the header).
// eslint-disable-next-line no-control-regex
const FORUM_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const uuid = z.string().uuid();

/** A post title: trimmed, 1 to 100, no control characters, one line. */
export const forumTitleSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, " ").trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(FORUM_TITLE_MAX)
      .refine((value) => !FORUM_CONTROL_CHARS.test(value), "Invalid characters"),
  );

export const forumTagNameSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, " ").trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(FORUM_TAG_NAME_MAX)
      .refine((value) => !FORUM_CONTROL_CHARS.test(value), "Invalid characters"),
  );

export const forumSortSchema = z.enum(["activity", "created"]);
export type ForumSort = z.infer<typeof forumSortSchema>;

export const forumStatusFilterSchema = z.enum(["open", "resolved"]);
export type ForumStatusFilter = z.infer<typeof forumStatusFilterSchema>;

/** What the opening message is, for the card's preview line. */
export const forumOpeningKindSchema = z.enum(["text", "voice", "attachment"]);
export type ForumOpeningKind = z.infer<typeof forumOpeningKindSchema>;

const tagIdListSchema = z
  .array(uuid)
  .max(FORUM_MAX_TAGS_PER_POST)
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate tag");

// ------------------------------------------------------------------ tags

export const forumTagSchema = z.object({
  id: uuid,
  name: z.string(),
  emoji: z.string().nullable(),
  /** Staff-only ("Só staff"): only MANAGE_MESSAGES puts it on or takes it off. */
  moderated: z.boolean(),
  /** Display order, 0 first. The PUT's array order. */
  position: z.number().int(),
  /** Published posts carrying it, for the settings row and the delete confirm. */
  postCount: z.number().int().nonnegative(),
});
export type ForumTag = z.infer<typeof forumTagSchema>;

/**
 * PUT replaces the whole list. An entry with `id` edits that tag; one without
 * creates a tag; a tag missing from the list is deleted (its post links go
 * with it). Position is the array order.
 */
export const putForumTagsSchema = z.object({
  tags: z
    .array(
      z.object({
        id: uuid.optional(),
        name: forumTagNameSchema,
        emoji: z.string().min(1).max(FORUM_TAG_EMOJI_MAX).nullable().optional(),
        moderated: z.boolean(),
      }),
    )
    .max(FORUM_MAX_TAGS)
    .refine(
      (tags) =>
        new Set(tags.map((tag) => tag.name.toLowerCase())).size === tags.length,
      "Duplicate tag name",
    )
    .refine(
      (tags) => {
        const ids = tags.flatMap((tag) => (tag.id ? [tag.id] : []));
        return new Set(ids).size === ids.length;
      },
      "Duplicate tag id",
    ),
});
export type PutForumTagsRequest = z.infer<typeof putForumTagsSchema>;

// -------------------------------------------------------------- settings

export const forumSettingsSchema = z.object({
  requireTag: z.boolean(),
  defaultSort: forumSortSchema,
});
export type ForumSettings = z.infer<typeof forumSettingsSchema>;

export const FORUM_SETTINGS_DEFAULTS: ForumSettings = {
  requireTag: false,
  defaultSort: "activity",
};

export const updateForumSettingsSchema = z
  .object({
    requireTag: z.boolean().optional(),
    defaultSort: forumSortSchema.optional(),
  })
  .refine(
    (body) => body.requireTag !== undefined || body.defaultSort !== undefined,
    "Nothing to update",
  );
export type UpdateForumSettingsRequest = z.infer<typeof updateForumSettingsSchema>;

// ----------------------------------------------------------------- posts

/**
 * One post as every viewer who can see the forum sees it. Shared across
 * viewers (the first page is read-cached), carried by `forum-post-upsert`,
 * and therefore never holds anything about the viewer: that is
 * `forumPostViewerSchema`.
 *
 * Arrays carry no `.max()` on purpose (see `threadSummarySchema`): an older
 * client must not reject a whole frame because a newer server sent more.
 */
export const forumPostSummarySchema = z.object({
  /** The post's own thread channel id. */
  id: uuid,
  forumId: uuid,
  title: z.string(),
  /** Null once the account is gone ("Conta excluída"). */
  authorId: uuid.nullable(),
  /**
   * What the card names: the account's display name, or for a webhook post
   * the per-message `username` override, then the webhook's name. Null when
   * the account is gone.
   */
  authorName: z.string().nullable(),
  authorAvatarUrl: z.string().nullable(),
  /** A feed (webhook) post: the card shows the `Feed` badge. */
  authorIsWebhook: z.boolean(),
  createdAt: z.string(),
  /** The bump: creation, or the newest reply. Never moves backwards. */
  lastActivityAt: z.string(),
  pinnedAt: z.string().nullable(),
  lockedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  /** The reply marked as the answer. May point at a deleted message. */
  acceptedAnswerId: uuid.nullable(),
  /** First `FORUM_PREVIEW_MAX` characters of the opening message, flattened. */
  preview: z.string().nullable(),
  /** The opening message was deleted; the card reads `thread.originDeleted`. */
  openingDeleted: z.boolean(),
  /** Null with `openingDeleted`. `voice` = a voice note, `attachment` = files only. */
  openingKind: forumOpeningKindSchema.nullable(),
  attachmentCount: z.number().int().nonnegative(),
  replyCount: z.number().int().nonnegative(),
  /** Reactions on the opening message, all emoji together. */
  reactionCount: z.number().int().nonnegative(),
  /** The opening message's most used reaction, for the card's number column. */
  topReaction: z
    .object({ emoji: z.string(), count: z.number().int().positive() })
    .nullable(),
  /** First image attachment of the opening message, signed. See the header. */
  thumbnailUrl: z.string().nullable(),
  thumbnailAttachmentId: uuid.nullable(),
  thumbnailWidth: z.number().int().positive().nullable(),
  thumbnailHeight: z.number().int().positive().nullable(),
  /**
   * The opening message's first video, signed, when it has no image: the web
   * card draws the video's first frame as the thumbnail (UX #18, "a video
   * shows its poster"). Additive and separate from `thumbnailUrl` on purpose:
   * a client that draws `thumbnailUrl` with an image view must never be
   * handed a video. Absent from an older API, hence the default.
   */
  thumbnailVideoUrl: z.string().nullable().default(null),
  /** In the forum's tag order. */
  tagIds: z.array(uuid),
});
export type ForumPostSummary = z.infer<typeof forumPostSummarySchema>;

/**
 * The per-viewer half, read for one page of ids and never cached or framed.
 * The list answers it beside the shared summaries, keyed by `postId`.
 */
export const forumPostViewerSchema = z.object({
  postId: uuid,
  /** The viewer's read cursor in this post; null = never opened ("Novo"). */
  lastReadAt: z.string().nullable(),
  /** Replies by others after `lastReadAt`, capped at `FORUM_UNREAD_CAP`; 0 when never opened. */
  newReplyCount: z.number().int().min(0).max(FORUM_UNREAD_CAP),
  /** A follow row that is not muted. P2 acts on it; see the header. */
  following: z.boolean(),
});
export type ForumPostViewer = z.infer<typeof forumPostViewerSchema>;

export const forumPostListResponseSchema = z.object({
  /** Page 1 only, at most `FORUM_MAX_PINNED`, unfiltered except by `q` (then empty). */
  pinned: z.array(forumPostSummarySchema),
  posts: z.array(forumPostSummarySchema),
  /** One per post in `pinned` and `posts`. */
  viewer: z.array(forumPostViewerSchema),
  /** Opaque keyset cursor; null at the end. */
  nextCursor: z.string().nullable(),
  /**
   * The viewer's forum cursor BEFORE this visit, what "Novo" is measured
   * against (`markChannelRead` returns it). Null for a first visit.
   */
  forumPreviousReadAt: z.string().nullable(),
  /** Header and end-of-list counts ("142 posts · 9 abertos"). Page 1 only, else null. */
  counts: z
    .object({
      posts: z.number().int().nonnegative(),
      open: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type ForumPostListResponse = z.infer<typeof forumPostListResponseSchema>;

/** Query-string boolean: only `true` / `1` is on. */
const queryBoolean = z.preprocess(
  (value) => value === true || value === "true" || value === "1",
  z.boolean(),
);

/**
 * `GET /api/channels/:forumId/posts`. `tag` repeats (`?tag=a&tag=b`) and is
 * AND, see the header. The server reads repeated keys with `getAll` and hands
 * this an object; a single string is accepted as a one-tag list.
 */
export const listForumPostsQuerySchema = z.object({
  /** Absent = the forum's `defaultSort`. */
  sort: forumSortSchema.optional(),
  /** AND: posts carrying every listed tag. */
  tag: z
    .union([uuid, z.array(uuid)])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .pipe(tagIdListSchema)
    .optional(),
  status: forumStatusFilterSchema.optional(),
  mine: queryBoolean.optional(),
  q: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(FORUM_SEARCH_MAX))
    .optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(FORUM_PAGE_MAX).optional(),
});
export type ListForumPostsQuery = z.infer<typeof listForumPostsQuerySchema>;

/**
 * `GET /api/channels/:forumId/posts/similar?title=`: "Posts parecidos" while
 * the composer's title is typed. Up to `FORUM_SIMILAR_MAX` posts of this
 * forum whose titles share words with it, resolved first. Never blocks
 * publishing; the client asks after 4 characters, debounced.
 */
export const similarForumPostsQuerySchema = z.object({
  title: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(FORUM_TITLE_MAX)),
});

/** The accepted answer, quoted under the opening message in the post view. */
export const forumAcceptedAnswerSchema = z.object({
  messageId: uuid,
  /** The reply was deleted after it was marked: "A resposta marcada foi apagada". */
  deleted: z.boolean(),
  authorId: uuid.nullable(),
  authorName: z.string().nullable(),
  /** First `FORUM_ANSWER_EXCERPT_MAX` characters, flattened. Null when deleted. */
  excerpt: z.string().nullable(),
  createdAt: z.string().nullable(),
});
export type ForumAcceptedAnswer = z.infer<typeof forumAcceptedAnswerSchema>;

/** `GET /api/forum-posts/:postId`: the deep link and the post view's header. */
export const forumPostDetailResponseSchema = z.object({
  post: forumPostSummarySchema,
  viewer: forumPostViewerSchema,
  /** Null when no answer was marked. */
  acceptedAnswer: forumAcceptedAnswerSchema.nullable(),
  /** Distinct people who wrote in the post, the author included ("9 pessoas"). */
  participantCount: z.number().int().nonnegative(),
});
export type ForumPostDetailResponse = z.infer<typeof forumPostDetailResponseSchema>;

/**
 * `POST /api/channels/:forumId/posts`. Attachments are minted against the
 * FORUM id (`POST /api/channels/:forumId/attachments`) and re-homed to the
 * post inside the create, because the composer has no post id yet. A post
 * needs text or at least one file. `nonce` makes a retry return the same post.
 */
export const createForumPostSchema = z
  .object({
    title: forumTitleSchema,
    body: z
      .string()
      .max(FORUM_BODY_MAX)
      .refine((value) => !FORUM_CONTROL_CHARS.test(value), "Invalid characters")
      .transform(clampChatNewlines),
    tagIds: tagIdListSchema.optional(),
    attachmentIds: z
      .array(uuid)
      .max(MAX_ATTACHMENTS_PER_MESSAGE)
      .refine((ids) => new Set(ids).size === ids.length, "Duplicate attachment")
      .optional(),
    nonce: z.string().min(1).max(64),
  })
  .refine(
    (post) => post.body.trim().length > 0 || (post.attachmentIds?.length ?? 0) > 0,
    { message: "A post needs text or a file", path: ["body"] },
  );
export type CreateForumPostRequest = z.infer<typeof createForumPostSchema>;

/**
 * `PATCH /api/forum-posts/:postId`. Every field optional, at least one
 * present. `acceptedAnswerId` set also resolves; `resolved: false` clears the
 * answer too; `acceptedAnswerId: null` unmarks the answer and leaves the
 * resolved state as it is.
 */
export const updateForumPostSchema = z
  .object({
    title: forumTitleSchema.optional(),
    tagIds: tagIdListSchema.optional(),
    resolved: z.boolean().optional(),
    pinned: z.boolean().optional(),
    locked: z.boolean().optional(),
    acceptedAnswerId: uuid.nullable().optional(),
  })
  .refine(
    (body) => Object.values(body).some((value) => value !== undefined),
    "Nothing to update",
  );
export type UpdateForumPostRequest = z.infer<typeof updateForumPostSchema>;

/** `PUT /api/forum-posts/:postId/follow` (P2). `following: false` stores a muted row. */
export const setForumPostFollowSchema = z.object({
  following: z.boolean(),
});

// ---------------------------------------------------------------- config

/** `GET /api/forum/config?serverId=`: the runtime flag `forum_channels` for that server. */
export const forumConfigSchema = z.object({
  /**
   * Creating forums and posts is allowed here. Off never hides anything:
   * existing forums stay readable and repliable, the client shows
   * "Novos posts estão pausados neste fórum." instead of "Novo post".
   */
  enabled: z.boolean(),
});
export type ForumConfig = z.infer<typeof forumConfigSchema>;

// ------------------------------------------------------------- WS frames

/**
 * A post appeared or changed: published, bumped by a reply, retitled,
 * retagged, pinned, locked, resolved. Fanned out to viewers of the FORUM
 * (`join-channel` on the forum id) through the channel relay, so it reaches
 * the sibling instance like any channel frame. Content-free beyond the
 * summary every forum viewer may already read.
 */
export const forumPostUpsertSchema = z.object({
  type: z.literal("forum-post-upsert"),
  forumId: uuid,
  post: forumPostSummarySchema,
});
export type ForumPostUpsert = z.infer<typeof forumPostUpsertSchema>;

/** A post was deleted. Sent to the forum's viewers and the post's own viewers. */
export const forumPostRemovedSchema = z.object({
  type: z.literal("forum-post-removed"),
  forumId: uuid,
  postId: uuid,
});
export type ForumPostRemoved = z.infer<typeof forumPostRemovedSchema>;

// ------------------------------------------------------- webhooks (P1b)

/** Discord's code for "a forum webhook needs thread_name or thread_id". */
export const WEBHOOK_FORUM_THREAD_NAME_CODE = 220001;
/** Header on an execute answered from the dedupe window instead of posting. */
export const WEBHOOK_DEDUPLICATED_HEADER = "X-Pqp-Deduplicated";
/** Query parameter: reply into an existing post instead of creating one. */
export const WEBHOOK_THREAD_ID_PARAM = "thread_id";

/**
 * A webhook that targets a forum. No row = every non-moderated tag allowed,
 * no default tags, a 72 h dedupe window.
 */
export const webhookForumSettingsSchema = z.object({
  /** Null = every non-moderated tag of the forum; a moderated tag must be listed. */
  allowedTagIds: z.array(uuid).max(FORUM_MAX_TAGS).nullable(),
  /** Applied when the payload names no tag that resolves ("Notícias"). */
  defaultTagIds: z.array(uuid).max(FORUM_MAX_TAGS_PER_POST),
  /** 0 turns dedupe off. */
  dedupeWindowHours: z.number().int().min(0).max(FORUM_WEBHOOK_DEDUPE_HOURS_MAX),
});
export type WebhookForumSettings = z.infer<typeof webhookForumSettingsSchema>;

/** What a webhook on a forum with no `webhook_forum_settings` row gets (P1b). */
export const WEBHOOK_FORUM_SETTINGS_DEFAULTS: WebhookForumSettings = {
  allowedTagIds: null,
  defaultTagIds: [],
  dedupeWindowHours: FORUM_WEBHOOK_DEDUPE_HOURS_DEFAULT,
};

/**
 * What an execute into a forum adds beside `message` in its answer. Snake
 * case like the rest of the webhook surface: a Discord tool reads it.
 */
export const webhookForumExecuteExtrasSchema = z.object({
  /**
   * Discord's message `id` and `channel_id`, top level, because that is where
   * a Discord tool reads them. On Discord a forum post's starter message has
   * the thread's own id, and tools rely on it: MonitoRSS sends the rest of a
   * long item to `?thread_id=<id>` of the answer. So a new post (or a repeat
   * of one) answers `id` = `channel_id` = the post id; a `?thread_id=` reply
   * answers the reply's id and the post id. pqp's own `message.id` is the
   * real message id either way.
   */
  id: uuid.optional(),
  channel_id: uuid.optional(),
  post: forumPostSummarySchema.optional(),
  /** `applied_tags` entries that matched no allowed tag of this forum. */
  ignored_tags: z.array(z.string()).optional(),
});
export type WebhookForumExecuteExtras = z.infer<typeof webhookForumExecuteExtrasSchema>;
