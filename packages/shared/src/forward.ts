import { z } from "zod";

/**
 * ENCAMINHAR (forward).
 *
 * Putting a Baú post, or a chat message, into another channel or a
 * conversation as a small card that says where it came from. This file is the
 * contract every client (web, iOS, Android) and the server share; the server
 * PR that introduced it owns it. See `server/src/services/forwards.ts` for the
 * rules and `docs/FORWARD.md` for the walk-through.
 *
 * A FORWARD IS A MESSAGE. It is a row in `messages` with a nullable JSONB
 * column `forward` holding a SNAPSHOT taken at forward time. It travels
 * through the same REST history reads, `message-broadcast` frames, unread,
 * push and cluster relay as any message, so a client that renders
 * `message.forward` gets it everywhere messages render (channels, DMs,
 * threads, forum posts) and an older client simply shows `body`.
 *
 * ON THE WIRE. `forward` is a key of the message object (`messageSchema` in
 * `api.ts`, `messageBroadcastSchema` in `chat.ts`). It is ABSENT for every
 * ordinary message and present only on a forward, so no other payload grows.
 * Read it as `message.forward ?? null`.
 *
 * `body` is the forwarder's own optional comment. When there is no comment the
 * server writes the fallback `forwardFallbackBody` so a client that predates
 * this field still shows something useful. A client that renders the card
 * should hide `body` when it equals the fallback (see `isForwardFallbackBody`).
 *
 * THE SNAPSHOT IS PLAIN TEXT AND NEVER RE-RESOLVED. Mentions inside `title` and
 * `excerpt` are not links and ping nobody; render them as text. The server
 * also never fires `@everyone`, `@here` or the fallback's words as a mention.
 *
 * THE SNAPSHOT DOES NOT FOLLOW THE SOURCE. Editing or deleting the original
 * later does not change a forward already sent (that is what a snapshot is
 * for). `url` still opens the live source, and the source's own access rules
 * apply there, so a reader who cannot open it just sees the card.
 */

/** At most this many targets in one `POST /api/forwards`. */
export const FORWARD_MAX_TARGETS = 5;

/** `excerpt` is cut to this many characters (plain text). */
export const FORWARD_EXCERPT_MAX = 500;

/** The forwarder's own words above the card. Below `MESSAGE_MAX_LENGTH`. */
export const FORWARD_COMMENT_MAX = 1500;

/** Snapshot version. A reader that does not know a version renders `body` only. */
export const FORWARD_VERSION = 1;

/** The same set `api.ts` refuses in a message body (it cannot be imported: cycle). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS =/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const forwardKindSchema = z.enum(["bau_post", "message"]);
export type ForwardKind = z.infer<typeof forwardKindSchema>;

/**
 * What the thumbnail is of, when the source has media. `mediaKind` can be set
 * with no `mediaThumbUrl`: the server only stores a thumbnail URL that is
 * stable and public (a YouTube poster), never a signed, expiring one. A client
 * with no thumbnail draws a small glyph for the kind.
 */
export const forwardMediaKindSchema = z.enum([
  "image",
  "video",
  "youtube",
  "embed",
]);
export type ForwardMediaKind = z.infer<typeof forwardMediaKindSchema>;

export const messageForwardSchema = z.object({
  v: z.literal(FORWARD_VERSION),
  kind: forwardKindSchema,
  sourceServerId: z.string().uuid(),
  sourceServerName: z.string(),
  /**
   * The source server's icon exactly as `servers.icon_url` carries it:
   * root-relative (`/api/servers/<id>/icon?v=<hash>`) or null. Resolve it
   * against the API origin like any server icon.
   */
  sourceServerIconUrl: z.string().nullable().optional(),
  /** `message` only: the channel's name, without the `#`. */
  sourceChannelName: z.string().optional(),
  /** The Baú post id (`bau_post`) or the message id (`message`). */
  sourceId: z.string().uuid(),
  /** Who wrote the source: the author's display name (a nickname in a server). */
  authorDisplayName: z.string().optional(),
  /** `bau_post` only: the post's title. */
  title: z.string().optional(),
  /** Plain text, at most `FORWARD_EXCERPT_MAX` characters. May be empty when `mediaKind` is set. */
  excerpt: z.string().max(FORWARD_EXCERPT_MAX),
  mediaThumbUrl: z.string().nullable().optional(),
  mediaKind: forwardMediaKindSchema.optional(),
  /**
   * Where the card opens, an absolute URL on the instance's own origin:
   * `<origin>/app/server/<serverId>/bau/<postId>` for a Baú post, or the
   * message jump link `<origin>/app/server/<serverId>/channel/<channelId>/message/<messageId>`.
   * A client opens a URL on its own instance inside the app and anything else
   * in the browser.
   */
  url: z.string(),
  /** When the SOURCE was created (a post's publish time), ISO 8601. */
  createdAt: z.string(),
  /**
   * True when the source is members-only (VIP) or lives in a private channel.
   * Such a card can only be forwarded again inside ONE server, named by
   * `restrictedToServerId`; it never gets a public page. Absent reads as false.
   */
  restricted: z.boolean().optional(),
  /**
   * With `restricted`: the only server this card may be forwarded into, and
   * never a conversation. For a members-only post it is `sourceServerId`; for
   * a card that was stamped inside a private channel it is the server of THAT
   * channel, which can differ from `sourceServerId` (a free card from server A
   * that someone forwarded into a private channel of server B is restricted to
   * B). Clients offer only this server; the server enforces it. Absent on a
   * restricted card from an older build: read it as `sourceServerId`.
   */
  restrictedToServerId: z.string().uuid().optional(),
});

export type MessageForward = z.infer<typeof messageForwardSchema>;

/**
 * The field as it sits on a message. `.catch(null)` so a snapshot of a future
 * version (or one that fails today's parse) is an ordinary message that shows
 * its `body`, never a failed history page. Optional: absent on every
 * ordinary message.
 */
export const messageForwardFieldSchema = messageForwardSchema
  .nullable()
  .optional()
  .catch(null);

// ---------------------------------------------------------------- the request

export const forwardSourceSchema = z.object({
  kind: forwardKindSchema,
  /** The Baú post id, or the message id. */
  id: z.string().uuid(),
  /**
   * `bau_post` only: the server the post is in. Posts are addressed by
   * `(serverId, postId)` everywhere else, and a bare post id cannot be looked
   * up without it. Ignored for `message` (the message knows its channel).
   */
  serverId: z.string().uuid().optional(),
}).refine((source) => source.kind !== "bau_post" || source.serverId !== undefined, {
  message: "A Baú post is addressed with serverId",
  path: ["serverId"],
});

/**
 * One destination: a channel the forwarder may send in (a server text channel,
 * a thread, a voice channel's chat, or a conversation they are in), or a
 * person to forward to as a direct message (the 1:1 conversation is opened or
 * reused, under the same rules as `POST /api/dms`).
 */
export const forwardTargetSchema = z.union([
  z.object({ channelId: z.string().uuid() }).strict(),
  z.object({ userId: z.string().uuid() }).strict(),
]);
export type ForwardTarget = z.infer<typeof forwardTargetSchema>;

export const createForwardSchema = z.object({
  source: forwardSourceSchema,
  /** 1 to `FORWARD_MAX_TARGETS`. Duplicates are dropped, order is kept. */
  targets: z.array(forwardTargetSchema).min(1).max(FORWARD_MAX_TARGETS),
  /** The forwarder's own words; becomes the message `body`. May be empty. */
  comment: z
    .string()
    .max(FORWARD_COMMENT_MAX)
    // Message storage cannot hold a NUL, and the other control characters are
    // refused on every other body in the app (`messageBodyTextSchema`).
    .refine((value) => !CONTROL_CHARS.test(value), "Invalid characters")
    .optional(),
  /**
   * One per dialog attempt. Chat de-duplicates on it per channel, so a retry
   * after a lost response returns the messages that already went out instead
   * of posting second cards.
   */
  nonce: z.string().min(1).max(64).optional(),
});
export type CreateForwardRequest = z.infer<typeof createForwardSchema>;

// --------------------------------------------------------------- the response

/**
 * Why one target did not get the forward. Machine-readable; the rest of the
 * request carries on. Deliberately coarse: a block and a person's privacy
 * setting are both `unreachable`, so this cannot be probed for who blocked
 * whom.
 *
 *  - `no_access`: the forwarder cannot see that channel;
 *  - `cannot_send`: no SEND_MESSAGES there, or a locked forum post;
 *  - `bad_target`: not somewhere a message can go (a category, a forum);
 *  - `stays_in_server`: the source is members-only or private and the target
 *    is another server or a conversation;
 *  - `unreachable`: a person who cannot be messaged (block, privacy, self);
 *  - `slow_mode`: slow mode there, `retryAfterMs` says when;
 *  - `rate_limited`: the sender's send budget is empty, `retryAfterMs` says when;
 *  - `automod`: an AutoMod rule of that server blocked it;
 *  - `unavailable`: anything else (the database), safe to retry.
 */
export const forwardRefusalReasonSchema = z.enum([
  "no_access",
  "cannot_send",
  "bad_target",
  "stays_in_server",
  "unreachable",
  "slow_mode",
  "rate_limited",
  "automod",
  "unavailable",
]);
export type ForwardRefusalReason = z.infer<typeof forwardRefusalReasonSchema>;

/**
 * Per target, in request order (after de-duplication). `message` is the
 * stored message in the shape history returns (`messageSchema`), already
 * broadcast to the channel; `channelId` is where it went, which for a `userId`
 * target is the conversation that was opened or reused, and `serverId` is null
 * for a conversation. Typed loosely here (`z.unknown()`) on purpose: this
 * module cannot import `messageSchema` without a cycle, and every client
 * already parses a message with its own schema.
 */
export const forwardResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    target: forwardTargetSchema,
    channelId: z.string().uuid(),
    serverId: z.string().uuid().nullable(),
    message: z.unknown(),
  }),
  z.object({
    ok: z.literal(false),
    target: forwardTargetSchema,
    reason: forwardRefusalReasonSchema,
    retryAfterMs: z.number().int().nonnegative().optional(),
  }),
]);
export type ForwardResult = z.infer<typeof forwardResultSchema>;

/** `POST /api/forwards` answer: always 200 once the request itself was valid. */
export const createForwardResponseSchema = z.object({
  results: z.array(forwardResultSchema),
});
export type CreateForwardResponse = z.infer<typeof createForwardResponseSchema>;

/**
 * `GET /api/forwards/config`. `enabled` is the runtime flag `forward_messages`.
 * Off, `POST /api/forwards` is a 404 and clients hide the action; cards already
 * in history keep rendering.
 */
export const forwardConfigSchema = z.object({
  enabled: z.boolean(),
});
export type ForwardConfig = z.infer<typeof forwardConfigSchema>;

/**
 * `GET /api/servers/:serverId/forward-destinations`: the channels of one
 * server the caller may post a forward into, in channel order, in ONE request
 * (the destination picker used to ask for the channel list and the permission
 * snapshot separately, two requests per server). A channel is listed when the
 * caller can see it, it holds messages (text, a voice channel's chat, a watch
 * party's chat) and they hold SEND_MESSAGES on it, which is the same check the
 * send makes. Slow mode, AutoMod and the like are still decided per send.
 */
export const forwardDestinationChannelSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  type: z.enum(["text", "voice", "watch_party"]),
});
export type ForwardDestinationChannel = z.infer<typeof forwardDestinationChannelSchema>;

/**
 * A thread is a place a forward may go too: `threads` lists the active threads
 * the caller is in (the ones their channel list nests under a channel, see
 * `listActiveThreadsByParent`) that they may post in, most recently active
 * first, at most `FORWARD_DESTINATION_THREADS_MAX` per server. `parentId` and
 * `parentName` are the text channel it hangs off, for the line under the name.
 * It goes to `POST /api/forwards` as any other `{ channelId }`. An API that
 * predates threads omits the key, which reads as no threads.
 */
export const FORWARD_DESTINATION_THREADS_MAX = 30;

export const forwardDestinationThreadSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  parentId: z.string().uuid(),
  parentName: z.string(),
});
export type ForwardDestinationThread = z.infer<typeof forwardDestinationThreadSchema>;

export const forwardDestinationsSchema = z.object({
  channels: z.array(forwardDestinationChannelSchema),
  threads: z.array(forwardDestinationThreadSchema).default([]),
});
export type ForwardDestinations = z.infer<typeof forwardDestinationsSchema>;

// -------------------------------------------------------------------- helpers

/** Prefix of the body the server writes when the forwarder adds no comment. */
export const FORWARD_FALLBACK_PREFIX = "Encaminhado: ";

/** How much of the title or excerpt goes in the fallback line. */
const FORWARD_FALLBACK_TEXT_MAX = 140;

/**
 * The body an older client shows when the forwarder wrote nothing:
 * `Encaminhado: <title or excerpt> <url>`. Plain text, no emoji.
 */
export function forwardFallbackBody(
  forward: Pick<MessageForward, "title" | "excerpt" | "url" | "sourceServerName">,
): string {
  const raw = (forward.title?.trim() || forward.excerpt.trim() || forward.sourceServerName)
    .replace(/\s+/g, " ")
    .trim();
  const text =
    raw.length > FORWARD_FALLBACK_TEXT_MAX
      ? `${raw.slice(0, FORWARD_FALLBACK_TEXT_MAX - 3).trimEnd()}...`
      : raw;
  return `${FORWARD_FALLBACK_PREFIX}${text} ${forward.url}`;
}

/**
 * Whether `body` is the server's fallback rather than the forwarder's own
 * words, so a client that draws the card can hide it. Compares against the
 * snapshot, so a comment that merely starts with the same word is never hidden.
 */
export function isForwardFallbackBody(
  body: string,
  forward: Pick<MessageForward, "title" | "excerpt" | "url" | "sourceServerName">,
): boolean {
  return forwardBodyComment(body, forward) !== body || body === forwardFallbackBody(forward);
}

/**
 * What a client that draws the card should show of `body`: nothing when it is
 * the fallback line (`""`), the role-mention line alone when a followed Baú's
 * delivery put one above the fallback (`@Role` on its own line, then the
 * fallback on the next), and `body` unchanged for anything the forwarder wrote.
 * A delivery that pings a role writes `@Role\n<fallback>` so an old client still
 * reads a mention and a title, and a new one strips the fallback by this rule.
 */
export function forwardBodyComment(
  body: string,
  forward: Pick<MessageForward, "title" | "excerpt" | "url" | "sourceServerName">,
): string {
  const fallback = forwardFallbackBody(forward);
  if (body === fallback) {
    return "";
  }
  const newline = body.indexOf("\n");
  if (newline > 1 && body.startsWith("@") && body.slice(newline + 1) === fallback) {
    return body.slice(0, newline);
  }
  return body;
}

/** Where a chat message lives, as the jump link every client already opens. */
export function forwardMessagePath(
  serverId: string,
  channelId: string,
  messageId: string,
): string {
  return `/app/server/${encodeURIComponent(serverId)}/channel/${encodeURIComponent(
    channelId,
  )}/message/${encodeURIComponent(messageId)}`;
}
