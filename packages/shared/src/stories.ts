import { z } from "zod";
import { safeTextSchema } from "./api.js";

/**
 * STORIES: a photo, a short video or a text card that lives for 24 hours,
 * posted to one or more servers the author is in, to their friends, or both.
 *
 * This file is the whole wire contract (HTTP and the one WebSocket frame) for
 * every client: web, iOS and Android build against these names. The design
 * study that fixed them is summarised in `docs/STORIES.md` once it lands; the
 * rules a client has to know are on each schema below.
 *
 * Three rules shape everything here:
 *
 * 1. NOTHING IS PUBLIC. A server story is visible to members of that server;
 *    a friends story to accepted friends. Blocking hides stories in BOTH
 *    directions. There is no discovery surface and no anonymous read.
 * 2. THE BYTES NEVER PASS THE API. Media goes up with a presigned PUT (the
 *    same seam as chat attachments), and is read with a presigned GET whose
 *    lifetime never outlives the story.
 * 3. NOTHING IS VISIBLE BEFORE IT IS SCANNED. An image is scanned at publish,
 *    before the story goes live; a video is processed (duration, codec,
 *    poster, three sampled frames scanned) by a job before it goes live.
 *
 * Behind two runtime flags: `stories` (per server, default off) for server
 * audiences and `stories_friends` (global, default off) for the friends
 * audience. With a flag off every route of that audience answers 404, except
 * the strip, which answers `{ enabled: false }` so clients hide it without a
 * 404 storm.
 */

// ------------------------------------------------------------------ limits

/** A story lives this long from publish. One rule, no choices. */
export const STORY_TTL_HOURS = 24;
export const STORY_TTL_MS = STORY_TTL_HOURS * 60 * 60 * 1000;

/** The longest video a client may post. */
export const STORY_MAX_VIDEO_MS = 30_000;
/**
 * What the server accepts when it probes the stored file: a second of slack
 * over `STORY_MAX_VIDEO_MS`, because a phone that stops recording at 30 s
 * writes a container a few frames longer than that.
 */
export const STORY_MAX_PROBED_VIDEO_MS = 31_000;

/** One file, image or video. */
export const STORY_MAX_BYTES = 25 * 1024 * 1024;

/** Clients re-encode images to at most this long side, stripping EXIF. */
export const STORY_IMAGE_MAX_EDGE = 1440;
/** A sanity bound on the dimensions a client declares, not a product rule. */
export const STORY_MAX_DIMENSION = 8192;

export const STORY_IMAGE_TYPES = ["image/jpeg", "image/webp", "image/png"] as const;
export const STORY_VIDEO_TYPES = ["video/mp4"] as const;
export const STORY_CONTENT_TYPES = [...STORY_IMAGE_TYPES, ...STORY_VIDEO_TYPES] as const;

export const STORY_KINDS = ["image", "video", "text"] as const;
export const STORY_REACTIONS = ["gg", "fire", "joy", "wow", "skull", "clap"] as const;
/** Palette keys for a text card. Each is chosen for at least 4.5:1 with white text. */
export const STORY_BACKGROUNDS = ["lime", "night", "ember", "grape", "sand", "ink"] as const;

export const STORY_CAPTION_MAX = 200;
export const STORY_TEXT_MAX = 280;
export const STORY_REPLY_MAX = 2000;
export const STORY_REMOVE_REASON_MAX = 200;

/** How many servers one story may go to at once. */
export const STORY_MAX_SERVER_AUDIENCES = 10;
/** Authors per strip. The viewer's "Ver todos" walks the rest. */
export const STORY_STRIP_MAX_AUTHORS = 30;
/** `GET /api/stories?ids=` answers at most this many. */
export const STORY_IDS_MAX = 20;
/** `POST /api/stories/views` takes at most this many ids. */
export const STORY_VIEWS_BATCH_MAX = 50;
/** `GET /api/stories/:storyId/viewers` page size. */
export const STORY_VIEWERS_PAGE_SIZE = 50;

/** Posting budget: per author, per rolling 24 hours, counted in the database. */
export const STORY_POSTS_PER_DAY = 20;
/** Posting budget: per author, per minute, per API process. */
export const STORY_POSTS_PER_MINUTE = 3;
/** In a listed community, an account must be this old to post a story there. */
export const STORY_COMMUNITY_MIN_ACCOUNT_AGE_HOURS = 72;

/**
 * How long each kind stays on screen in the viewer, for clients that want
 * the same pacing everywhere. A video plays for its own length.
 */
export const STORY_PHOTO_DISPLAY_MS = 5_000;
export const STORY_CALL_DISPLAY_MS = 8_000;
export function storyTextDisplayMs(text: string): number {
  return Math.min(10_000, 5_000 + 50 * [...text].length);
}

// ------------------------------------------------------------------ enums

export const storyKindSchema = z.enum(STORY_KINDS);
export type StoryKind = z.infer<typeof storyKindSchema>;

/** One reaction per viewer per story, changeable. Never creates a message. */
export const storyReactionValueSchema = z.enum(STORY_REACTIONS);
export type StoryReaction = z.infer<typeof storyReactionValueSchema>;

export const storyBackgroundSchema = z.enum(STORY_BACKGROUNDS);
export type StoryBackground = z.infer<typeof storyBackgroundSchema>;

export const storyContentTypeSchema = z.enum(STORY_CONTENT_TYPES);
export type StoryContentType = z.infer<typeof storyContentTypeSchema>;

export function isStoryImageType(value: string): boolean {
  return (STORY_IMAGE_TYPES as readonly string[]).includes(value);
}

export function isStoryVideoType(value: string): boolean {
  return (STORY_VIDEO_TYPES as readonly string[]).includes(value);
}

/** Bytes of a file's start that `sniffStoryMediaType` needs. */
export const STORY_SNIFF_BYTES = 12;

/**
 * The `ftyp` major brands that are an MP4 a player plays as video. HEIC
 * (`heic`, `mif1`), AVIF (`avif`) and QuickTime (`qt  `) are ISO BMFF too, and
 * an iPhone photo renamed `.mp4` must not pass as one.
 */
const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "M4V ",
  "MSNV",
  "dash",
  "mmp4",
]);

/**
 * Which allowed story type these leading bytes really are, or null. Shared so
 * a composer can refuse a renamed file before uploading, and the publish can
 * refuse it again on the stored object.
 */
export function sniffStoryMediaType(bytes: Uint8Array): StoryContentType | null {
  const startsWith = (signature: number[], offset = 0) =>
    bytes.length >= offset + signature.length &&
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith([0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  // "RIFF", four size bytes, "WEBP".
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  // An ISO BMFF file: a box size, "ftyp", then the major brand, which is
  // what tells an MP4 from a HEIC photo or a QuickTime movie.
  if (startsWith([0x66, 0x74, 0x79, 0x70], 4) && bytes.length >= 12) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    return MP4_BRANDS.has(brand) ? "video/mp4" : null;
  }
  return null;
}

// ------------------------------------------------------------------ config

/**
 * `GET /api/stories/config[?serverId=]`. Always 200.
 *
 * `enabled` is the `stories` flag for the server named in `?serverId=`, or
 * the deployment-wide value without one. A server can be on while the
 * deployment-wide value is off (that is how a single server goes first), so a
 * client deciding whether to draw a server's strip asks the strip itself.
 *
 * `mediaEnabled` is object storage; off means text cards only.
 * `videoEnabled` is off when a scanner is configured and no process can
 * sample frames (no ffmpeg anywhere): video is then refused rather than
 * posted unscanned.
 */
export const storiesConfigSchema = z.object({
  enabled: z.boolean(),
  friendsEnabled: z.boolean(),
  mediaEnabled: z.boolean(),
  videoEnabled: z.boolean(),
  maxVideoMs: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
  ttlHours: z.number().int().positive(),
});
export type StoriesConfig = z.infer<typeof storiesConfigSchema>;

// ------------------------------------------------------------------ people

/** Who posted it, or who watched it. No tag, no email, no presence. */
export const storyAuthorSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  handle: z.string().nullable().default(null),
});
export type StoryAuthor = z.infer<typeof storyAuthorSchema>;

// ------------------------------------------------------------------ stickers

/**
 * "Chama pra call": joins a voice channel in one tap. The channel must be a
 * voice channel of a server the story goes to, and the author must be able
 * to connect to it. Phase 2 adds more `type`s to this union; a client that
 * meets a type it does not know draws nothing for it.
 */
export const storyCallStickerSchema = z.object({
  type: z.literal("call"),
  serverId: z.string().uuid(),
  channelId: z.string().uuid(),
});

export const storyStickerSchema = z.discriminatedUnion("type", [storyCallStickerSchema]);
export type StorySticker = z.infer<typeof storyStickerSchema>;

/**
 * The call sticker as it is RIGHT NOW, read from the voice roster when the
 * story is served. `state` is `ended` once the room is empty or the author has
 * left it; `full` when a peer-to-peer room has no seat left. `joinable` is
 * `state === "live"` and the viewer may connect to the channel.
 */
export const storyCallLiveSchema = z.object({
  serverId: z.string().uuid(),
  channelId: z.string().uuid(),
  channelName: z.string(),
  /** Up to five faces, the author first when they are in. */
  participants: z.array(storyAuthorSchema).max(5),
  count: z.number().int().nonnegative(),
  state: z.enum(["live", "ended", "full"]),
  joinable: z.boolean(),
});
export type StoryCallLive = z.infer<typeof storyCallLiveSchema>;

// ------------------------------------------------------------------ the story

/**
 * Where a story is seen. A viewer only ever gets the audiences they see it
 * through (a server they are in, Amigos when they are a friend), never the
 * full list; the author gets every audience of their own story.
 */
export const storyAudienceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("server"),
    serverId: z.string().uuid(),
    serverName: z.string(),
  }),
  z.object({ kind: z.literal("friends") }),
]);
export type StoryAudience = z.infer<typeof storyAudienceSchema>;

export const storyMediaSchema = z.object({
  /** Presigned GET. Valid for at most an hour and never past `expiresAt`. */
  url: z.string(),
  /** Video only: a frame at 0.5 s. Null for images and while unavailable. */
  posterUrl: z.string().nullable(),
  contentType: storyContentTypeSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationMs: z.number().int().positive().nullable(),
});
export type StoryMedia = z.infer<typeof storyMediaSchema>;

/**
 * Why the reply box is gone. `replies_off`: the author turned replies off
 * for this story. `dm_closed`: the author's DM privacy does not admit the
 * viewer ("X só recebe mensagem de amigos"). Null when `canReply` is true,
 * and for the author's own story.
 */
export const storyReplyBlockedReasonSchema = z.enum(["replies_off", "dm_closed"]);
export type StoryReplyBlockedReason = z.infer<typeof storyReplyBlockedReasonSchema>;

export const storyViewerStateSchema = z.object({
  /** This account has a view row for the story. */
  seen: z.boolean(),
  reaction: storyReactionValueSchema.nullable(),
  canReply: z.boolean(),
  replyBlockedReason: storyReplyBlockedReasonSchema.nullable(),
  /**
   * The servers (among `audiences`) where this viewer may remove the story
   * ("Tirar do servidor"): MANAGE_MESSAGES there. Empty for most people.
   */
  canModerate: z.array(z.string().uuid()),
  /**
   * The author holds MANAGE_SERVER in these servers (among `audiences`), so
   * "Salvar no Baú" may be offered for them. Empty for everybody but the
   * author.
   */
  canSaveToBau: z.array(z.string().uuid()).default([]),
});
export type StoryViewerState = z.infer<typeof storyViewerStateSchema>;

/** Only on the author's own story. */
export const storyOwnStateSchema = z.object({
  /** `processing`: a video waiting for its frames to be checked. */
  status: z.enum(["pending", "processing", "live"]),
  viewCount: z.number().int().nonnegative(),
  reactionCount: z.number().int().nonnegative(),
  replyCount: z.number().int().nonnegative(),
  repliesEnabled: z.boolean(),
});
export type StoryOwnState = z.infer<typeof storyOwnStateSchema>;

export const storySchema = z.object({
  id: z.string().uuid(),
  author: storyAuthorSchema,
  kind: storyKindSchema,
  /** Image and video only. */
  caption: z.string().nullable(),
  /** Text card only. */
  text: z.string().nullable(),
  /** Text card only. */
  background: storyBackgroundSchema.nullable(),
  /** Image and video only; null for a text card and while not yet uploaded. */
  media: storyMediaSchema.nullable(),
  sticker: storyStickerSchema.nullable(),
  /** The live state of `sticker` when it is a call sticker. */
  call: storyCallLiveSchema.nullable(),
  /** Null only on the author's own story before it goes live. */
  publishedAt: z.string().nullable(),
  /** Null only on the author's own story before it goes live. */
  expiresAt: z.string().nullable(),
  audiences: z.array(storyAudienceSchema),
  viewer: storyViewerStateSchema,
  own: storyOwnStateSchema.nullable(),
});
export type Story = z.infer<typeof storySchema>;

// ------------------------------------------------------------------ the strip

/**
 * One ring. `storyIds` is the play order, oldest first; `unseen` is true when
 * any of them has no view row for the viewer. `expiresAt` is the expiry of
 * the newest story, so a client can drop a ring locally once it passes
 * without waiting for a frame (expiry sends none).
 */
export const storyStripItemSchema = z.object({
  author: storyAuthorSchema,
  storyIds: z.array(z.string().uuid()).min(1),
  latestAt: z.string(),
  expiresAt: z.string(),
  unseen: z.boolean(),
  hasCall: z.boolean(),
});
export type StoryStripItem = z.infer<typeof storyStripItemSchema>;

/**
 * `GET /api/servers/:serverId/stories` and `GET /api/stories/friends`.
 *
 * `own` is the viewer's own live stories in this audience ("Teu story").
 * `items` never includes the viewer, is ordered on the server (unseen first,
 * then friends, then DM recency, then newest; then seen authors, newest
 * first) and is capped at `STORY_STRIP_MAX_AUTHORS`. Clients do not reorder.
 *
 * `canPost`: the viewer may post to this audience now (POST_STORIES, no
 * timeout, account age in a listed community). `firstRunHint`: nobody has a
 * live story here, the flag turned on in the last 7 days and this viewer has
 * never posted here, so the client may show the one-off dashed row (its
 * dismissal is the client's to remember).
 *
 * With the flag off for the audience this is `{ enabled: false }` with every
 * other field at its default.
 */
export const storyStripSchema = z.object({
  enabled: z.boolean(),
  canPost: z.boolean().default(false),
  own: storyStripItemSchema.nullable().default(null),
  items: z.array(storyStripItemSchema).default([]),
  firstRunHint: z.boolean().default(false),
});
export type StoryStrip = z.infer<typeof storyStripSchema>;

/**
 * `GET /api/stories/audiences`: what the composer's "Quem vê" sheet draws.
 * Every server the viewer is in that has stories on, with whether they may
 * post there and, when not, why. `friends.enabled` is the friends flag.
 */
export const storyAudienceBlockedReasonSchema = z.enum([
  "no_permission",
  "timed_out",
  "account_too_new",
]);
export type StoryAudienceBlockedReason = z.infer<typeof storyAudienceBlockedReasonSchema>;

export const storyAudienceOptionsSchema = z.object({
  servers: z.array(
    z.object({
      serverId: z.string().uuid(),
      serverName: z.string(),
      iconUrl: z.string().nullable(),
      memberCount: z.number().int().nonnegative(),
      canPost: z.boolean(),
      blockedReason: storyAudienceBlockedReasonSchema.nullable(),
    }),
  ),
  friends: z.object({ enabled: z.boolean(), canPost: z.boolean() }),
});
export type StoryAudienceOptions = z.infer<typeof storyAudienceOptionsSchema>;

// ------------------------------------------------------------------ create

const captionSchema = z
  .string()
  .trim()
  .max(STORY_CAPTION_MAX)
  .pipe(safeTextSchema);

const textBodySchema = z
  .string()
  .trim()
  .min(1)
  .max(STORY_TEXT_MAX)
  .pipe(safeTextSchema);

export const storyMediaInputSchema = z.object({
  contentType: storyContentTypeSchema,
  byteSize: z.number().int().positive().max(STORY_MAX_BYTES),
  width: z.number().int().positive().max(STORY_MAX_DIMENSION),
  height: z.number().int().positive().max(STORY_MAX_DIMENSION),
  /** Video only, required there. Read off the file by the client. */
  durationMs: z.number().int().positive().max(STORY_MAX_VIDEO_MS).optional(),
});
export type StoryMediaInput = z.infer<typeof storyMediaInputSchema>;

export const storyAudienceTargetsSchema = z
  .object({
    serverIds: z
      .array(z.string().uuid())
      .max(STORY_MAX_SERVER_AUDIENCES)
      .default([]),
    friends: z.boolean().default(false),
  })
  .refine((value) => value.serverIds.length > 0 || value.friends, {
    message: "Pick at least one audience",
  })
  .refine((value) => new Set(value.serverIds).size === value.serverIds.length, {
    message: "Duplicate server",
  });
export type StoryAudienceTargets = z.infer<typeof storyAudienceTargetsSchema>;

/**
 * `POST /api/stories`.
 *
 * - `text`: `text` and `background`, no `media`, no `caption`. Goes live at
 *   once (no upload).
 * - `image`: `media` with an image type. `caption` optional.
 * - `video`: `media` with `video/mp4` and `durationMs`. `caption` optional.
 *
 * Media stories answer with `upload`: the client PUTs the bytes there with
 * exactly `upload.headers` (Content-Length is signed too, and browsers set it
 * from the body), then calls `POST /api/stories/:storyId/publish`. A story
 * never published is deleted with its object after an hour.
 *
 * Needs POST_STORIES in every target server (plus no timeout, and a 72 h old
 * account in a listed community); the friends audience needs only the
 * `stories_friends` flag. Budget: `STORY_POSTS_PER_MINUTE` and
 * `STORY_POSTS_PER_DAY`, answered with 429.
 */
export const createStorySchema = z
  .object({
    kind: storyKindSchema,
    caption: captionSchema.optional(),
    text: textBodySchema.optional(),
    background: storyBackgroundSchema.optional(),
    sticker: storyStickerSchema.optional(),
    repliesEnabled: z.boolean().default(true),
    audiences: storyAudienceTargetsSchema,
    media: storyMediaInputSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const fail = (message: string, path: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
    if (value.kind === "text") {
      if (!value.text) fail("A text story needs text", "text");
      if (!value.background) fail("A text story needs a background", "background");
      if (value.media) fail("A text story has no media", "media");
      if (value.caption) fail("A text story has no caption", "caption");
    } else {
      if (value.text !== undefined) fail("Only a text story has text", "text");
      if (value.background !== undefined) fail("Only a text story has a background", "background");
      if (!value.media) {
        fail("A photo or video story needs media", "media");
      } else if (value.kind === "image") {
        if (!isStoryImageType(value.media.contentType)) fail("Not an image type", "media");
        if (value.media.durationMs !== undefined) fail("An image has no duration", "media");
      } else {
        if (!isStoryVideoType(value.media.contentType)) fail("Not a video type", "media");
        if (value.media.durationMs === undefined) fail("A video needs its duration", "media");
      }
    }
    if (
      value.sticker?.type === "call" &&
      !value.audiences.serverIds.includes(value.sticker.serverId)
    ) {
      fail("The call must be in a server the story goes to", "sticker");
    }
  });
export type CreateStoryRequest = z.infer<typeof createStorySchema>;

export const storyUploadSchema = z.object({
  url: z.string(),
  method: z.literal("PUT"),
  /** Send exactly these. */
  headers: z.record(z.string(), z.string()),
  expiresAt: z.string(),
});
export type StoryUpload = z.infer<typeof storyUploadSchema>;

export const createStoryResponseSchema = z.object({
  story: storySchema,
  upload: storyUploadSchema.nullable(),
});
export type CreateStoryResponse = z.infer<typeof createStoryResponseSchema>;

/**
 * `POST /api/stories/:storyId/publish` answers `{ story }`. An image is live
 * on return (or refused with 422 when the scan says no, with no reason given);
 * a video comes back `own.status = "processing"` and a `stories-update` with
 * `scope: "own"` follows when it is live.
 */
export const publishStoryResponseSchema = z.object({ story: storySchema });
export type PublishStoryResponse = z.infer<typeof publishStoryResponseSchema>;

/** `GET /api/stories?ids=a,b,c` (at most `STORY_IDS_MAX`). Unseeable ids are dropped silently. */
export const storiesResponseSchema = z.object({ stories: z.array(storySchema) });
export type StoriesResponse = z.infer<typeof storiesResponseSchema>;

// ------------------------------------------------------------------ viewing

/**
 * `POST /api/stories/views`: mark seen, batched, after a second on screen.
 * Idempotent; the author's own views are never counted. Answers
 * `{ recorded }`, how many were new.
 */
export const storyViewsBatchSchema = z.object({
  storyIds: z.array(z.string().uuid()).min(1).max(STORY_VIEWS_BATCH_MAX),
});
export type StoryViewsBatch = z.infer<typeof storyViewsBatchSchema>;

/** `PUT /api/stories/:storyId/reaction`. Null clears it. Marks the story seen too. */
export const storyReactionSchema = z.object({
  reaction: storyReactionValueSchema.nullable(),
});
export type StoryReactionRequest = z.infer<typeof storyReactionSchema>;

/**
 * `POST /api/stories/:storyId/reply`: becomes a message in the 1:1
 * conversation with the author, quoting the story (`message.storyId`). Rides
 * every DM rule (privacy, blocks, limits) and the ordinary DM push.
 */
export const storyReplySchema = z.object({
  text: z.string().trim().min(1).max(STORY_REPLY_MAX).pipe(safeTextSchema),
});
export type StoryReplyRequest = z.infer<typeof storyReplySchema>;

export const storyReplyResponseSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
});
export type StoryReplyResponse = z.infer<typeof storyReplyResponseSchema>;

/** `GET /api/stories/:storyId/viewers?cursor=`: the author only, newest first. */
export const storyViewerRowSchema = z.object({
  user: storyAuthorSchema,
  viewedAt: z.string(),
  reaction: storyReactionValueSchema.nullable(),
  replied: z.boolean(),
});
export type StoryViewerRow = z.infer<typeof storyViewerRowSchema>;

export const storyViewersPageSchema = z.object({
  viewers: z.array(storyViewerRowSchema),
  /** Pass back as `?cursor=` for the next page; null on the last one. */
  nextCursor: z.string().nullable(),
  viewCount: z.number().int().nonnegative(),
  reactionCount: z.number().int().nonnegative(),
});
export type StoryViewersPage = z.infer<typeof storyViewersPageSchema>;

/**
 * `GET /api/stories/:storyId/card`: what a DM quote draws. Only for a
 * participant of a conversation holding a message that quotes the story.
 * After expiry or removal it carries no media and no text at all ("Story
 * expirou"), which is how the 24 h promise holds inside DMs too.
 */
export const storyCardSchema = z.object({
  storyId: z.string().uuid(),
  state: z.enum(["live", "expired", "removed"]),
  authorId: z.string().uuid(),
  kind: storyKindSchema.nullable(),
  posterUrl: z.string().nullable(),
  caption: z.string().nullable(),
  text: z.string().nullable(),
  background: storyBackgroundSchema.nullable(),
  expiresAt: z.string().nullable(),
});
export type StoryCard = z.infer<typeof storyCardSchema>;

// ------------------------------------------------------------------ moderation

/**
 * `DELETE /api/servers/:serverId/stories/:storyId` (MANAGE_MESSAGES there):
 * takes the story out of THAT server only, audited as `story.remove`; the
 * author gets a one-time notice with the reason. The body is optional.
 */
export const storyModRemoveSchema = z.object({
  reason: z.string().trim().max(STORY_REMOVE_REASON_MAX).pipe(safeTextSchema).optional(),
});
export type StoryModRemoveRequest = z.infer<typeof storyModRemoveSchema>;

/**
 * `GET /api/stories/notices`: one-time cards for the author ("A staff tirou
 * teu story do X"). `POST /api/stories/notices/:noticeId/ack` dismisses one.
 */
export const storyNoticeSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal("removed"),
  storyId: z.string().uuid().nullable(),
  serverId: z.string().uuid().nullable(),
  serverName: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string(),
});
export type StoryNotice = z.infer<typeof storyNoticeSchema>;

export const storyNoticesResponseSchema = z.object({
  notices: z.array(storyNoticeSchema),
});
export type StoryNoticesResponse = z.infer<typeof storyNoticesResponseSchema>;

// ------------------------------------------------------------------ Baú

/**
 * `POST /api/stories/:storyId/save-to-bau`: the author, holding MANAGE_SERVER
 * in `serverId` (one of the story's servers), copies the media into a Baú
 * DRAFT. The copy is server side; staff still edit and publish it.
 */
export const storySaveToBauSchema = z.object({
  serverId: z.string().uuid(),
});
export type StorySaveToBauRequest = z.infer<typeof storySaveToBauSchema>;

export const storySaveToBauResponseSchema = z.object({
  postId: z.string().uuid(),
});
export type StorySaveToBauResponse = z.infer<typeof storySaveToBauResponseSchema>;

// ------------------------------------------------------------------ WebSocket

/**
 * The one frame, content-free. Refetch the strip it names.
 *
 * - `server`: a story in `serverId` went live, was deleted or was removed.
 *   Sent to that server's members, at most one per server per 5 s.
 * - `friends`: same, for the friends strip. Sent to the author's friends.
 * - `own`: something about the receiver's OWN stories changed (new views, a
 *   video finished processing, a moderator removed one): refetch them and
 *   `GET /api/stories/notices`. At most one per 10 s per author.
 *
 * Never sent on a view, a reaction or an expiry: clients drop an expired ring
 * themselves from `expiresAt`. `removedStoryIds`, when present, can be
 * dropped from any open viewer at once.
 *
 * `type` stays the first key: Android's wire test reads the frame types off
 * this file.
 *
 * This plain object is the option inside `chatServerMessageSchema` (a
 * discriminated union takes objects only); `storiesUpdateSchema` below is the
 * same shape with the scope/serverId pairing enforced, for a client to parse
 * the frame with once the socket router has picked it out.
 */
export const storiesUpdateFrameSchema = z.object({
  type: z.literal("stories-update"),
  scope: z.enum(["server", "friends", "own"]),
  /** Present exactly when `scope` is `server`. */
  serverId: z.string().uuid().optional(),
  removedStoryIds: z.array(z.string().uuid()).max(STORY_VIEWS_BATCH_MAX).optional(),
});

export const storiesUpdateSchema = storiesUpdateFrameSchema.superRefine((frame, ctx) => {
  if ((frame.scope === "server") !== (frame.serverId !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "serverId is present exactly when scope is server",
      path: ["serverId"],
    });
  }
});
export type StoriesUpdate = z.infer<typeof storiesUpdateFrameSchema>;
