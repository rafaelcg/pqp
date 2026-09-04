import { z } from "zod";
import {
  channelKindSchema,
  messageBodyTextSchema,
  messagePinnedBySchema,
  messageReactionSchema,
  messageReplyRefSchema,
  reactionEmojiSchema,
  SLOWMODE_SECONDS_MAX,
} from "./api.js";
import {
  attachmentSchema,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "./attachments.js";
import { embedSchema } from "./embeds.js";
import { friendActivitySchema } from "./friends.js";
import { permissionsUpdateSchema } from "./permissions.js";
import { communityHomeUpdateSchema } from "./community-home.js";
import { sanctionNoticeSchema } from "./sanctions.js";
import { setIdleMessageSchema } from "./status.js";
// --- threads ---
import {
  threadJoinMessageSchema,
  threadLeaveMessageSchema,
  threadSummarySchema,
  threadUpdateBroadcastSchema,
} from "./threads.js";
import { webhookEmbedSchema } from "./webhooks.js";
import { chanceRequestSchema, chanceResultSchema } from "./chance.js";
import { pollRequestSchema, pollSchema } from "./polls.js";

export const joinChannelMessageSchema = z.object({
  type: z.literal("join-channel"),
  channelId: z.string().uuid(),
});

export const leaveChannelMessageSchema = z.object({
  type: z.literal("leave-channel"),
});

const messageCreateFrameSchema = z.object({
  type: z.literal("message-create"),
  channelId: z.string().uuid(),
  /**
   * Deliberately not `messageBodySchema`: a message that carries attachments is
   * allowed to say nothing, so the floor of one character has to come off. The
   * emptiness rule moves to `requireBodyOrAttachment` below instead of being
   * dropped — see there for why it cannot live on the leaf.
   */
  body: messageBodyTextSchema,
  /**
   * Client-generated id echoed back on the broadcast so the sender can swap its
   * optimistic bubble for the stored message instead of rendering it twice.
   */
  nonce: z.string().min(1).max(64).optional(),
  /** The message this one answers. Must live in the same channel. */
  replyToId: z.string().uuid().optional(),
  /**
   * Rows minted by `POST /api/channels/:channelId/attachments` and not yet
   * claimed by a message.
   *
   * Ids and nothing else: filename, type and size are re-read from the row and
   * from the object itself when the claim happens, so a sender cannot describe
   * its own upload into something it is not.
   */
  attachmentIds: z
    .array(z.string().uuid())
    .max(MAX_ATTACHMENTS_PER_MESSAGE)
    .optional(),
  /**
   * A randomizer request. The server rolls and writes `chance` plus a
   * fallback `body`. A client that already filled `body` with a total is
   * ignored: the number on the card is never the sender's.
   */
  chance: chanceRequestSchema.optional(),
  /**
   * A poll request. The server writes the question into `body` and the
   * options into `polls` / `poll_options`.
   */
  poll: pollRequestSchema.optional(),
});

/**
 * A message may be text, attachments, or both — never neither.
 *
 * The rule sits on the frame rather than on `messageBodySchema` because the
 * leaf cannot see `attachmentIds`, and because that leaf is also what the edit
 * path validates: relaxing it to allow `""` would let an edit blank an existing
 * message out, which is a delete wearing an edit's clothes.
 */
function requireBodyOrAttachment(
  frame: {
    body: string;
    attachmentIds?: string[];
    chance?: unknown;
    poll?: unknown;
  },
  ctx: z.RefinementCtx,
): void {
  if (frame.chance && frame.poll) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["chance"],
      message: "A message cannot be both a chance result and a poll",
    });
    return;
  }
  if (
    frame.body.length === 0 &&
    !frame.attachmentIds?.length &&
    !frame.chance &&
    !frame.poll
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["body"],
      message: "A message needs a body or an attachment",
    });
  }
}

export const messageCreateMessageSchema = messageCreateFrameSchema.superRefine(
  requireBodyOrAttachment,
);

export const typingMessageSchema = z.object({
  type: z.literal("typing"),
  channelId: z.string().uuid(),
});

export const reactionToggleMessageSchema = z.object({
  type: z.literal("reaction-toggle"),
  channelId: z.string().uuid(),
  messageId: z.string().uuid(),
  emoji: reactionEmojiSchema,
});

const broadcastMessageSchema = z.object({
  id: z.string().uuid(),
  channelId: z.string().uuid(),
  authorId: z.string().uuid(),
  authorName: z.string(),
  authorTag: z.string().nullable().optional(),
  authorAvatarUrl: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  editedAt: z.string().nullable().default(null),
  reactions: z.array(messageReactionSchema).default([]),
  replyTo: messageReplyRefSchema.nullable().default(null),
  /**
   * Only the attachments that survived the claim: one that failed its HEAD
   * check is dropped from the message rather than broadcast with a URL that
   * would 404. Defaulted so a client keeps parsing broadcasts from an API that
   * predates attachments.
   */
  attachments: z.array(attachmentSchema).default([]),
  pinnedAt: z.string().nullable().default(null),
  pinnedBy: messagePinnedBySchema.nullable().default(null),
  embeds: z.array(embedSchema).default([]),
  isWebhook: z.boolean().default(false),
  mentionEveryone: z.boolean().default(false),
  mentionHere: z.boolean().default(false),
  webhookEmbeds: z.array(webhookEmbedSchema).default([]),
  // --- threads ---
  thread: threadSummarySchema.nullable().default(null),
  chance: chanceResultSchema.nullable().default(null),
  poll: pollSchema.nullable().default(null),
});

export const pollVoteMessageSchema = z.object({
  type: z.literal("poll-vote"),
  channelId: z.string().uuid(),
  messageId: z.string().uuid(),
  optionId: z.string().uuid(),
});

export const pollCloseMessageSchema = z.object({
  type: z.literal("poll-close"),
  channelId: z.string().uuid(),
  messageId: z.string().uuid(),
});

/**
 * Live vote / close refresh. Counts replace; the client keeps its own
 * `voted` flags unless `voterId` is the current user.
 */
export const pollUpdateBroadcastSchema = z.object({
  type: z.literal("poll-update"),
  channelId: z.string().uuid(),
  messageId: z.string().uuid(),
  poll: pollSchema,
  voterId: z.string().uuid().optional(),
  optionId: z.string().uuid().optional(),
  added: z.boolean().optional(),
});

export const messageBroadcastSchema = z.object({
  type: z.literal("message-broadcast"),
  message: broadcastMessageSchema,
  nonce: z.string().optional(),
});

/**
 * Why a `message-create` never became a broadcast.
 *
 * A WebSocket frame has no status code, so without this the sender's optimistic
 * bubble sits pending until a 10s timer paints a generic failure. The reasons
 * are machine tokens: the client i18n's them, the same way a 403 body would.
 *
 * Addressed to the sender only. Not a member of `CHAT_SERVER_MESSAGE_TYPES` —
 * listing it there would let the cluster relay hand one person's refusal to
 * everyone in the channel.
 */
export const messageRejectReasonSchema = z.enum([
  "rate-limited",
  "no-access",
  "cannot-send",
  /**
   * A create that will not land, and the wire must not say why.
   *
   * Includes a blocked DM. `services/dms.ts` refuses to tell a caller whether
   * a specific person has blocked them; this token must stay equally vague.
   * In a 1:1 the only non-rate-limit refusal is a block, so any reject is
   * already a weaker signal. Naming the block would make it an oracle.
   */
  "undeliverable",
  /** Channel slow mode: this sender must wait before the next create. */
  "slow-mode",
]);
export type MessageRejectReason = z.infer<typeof messageRejectReasonSchema>;

export const messageRejectedSchema = z.object({
  type: z.literal("message-rejected"),
  channelId: z.string().uuid(),
  /** Echo of the create frame, so the sender can match the optimistic bubble. */
  nonce: z.string().min(1).max(64).optional(),
  reason: messageRejectReasonSchema,
  /** May be present when `reason` is `rate-limited` or `slow-mode`. */
  retryAfterMs: z
    .number()
    .int()
    .min(0)
    .max(SLOWMODE_SECONDS_MAX * 1000)
    .optional(),
});
export type MessageRejected = z.infer<typeof messageRejectedSchema>;

export const messageUpdateBroadcastSchema = z.object({
  type: z.literal("message-update"),
  message: broadcastMessageSchema,
});

export const messageDeleteBroadcastSchema = z.object({
  type: z.literal("message-delete"),
  channelId: z.string().uuid(),
  messageId: z.string().uuid(),
});

export const typingBroadcastSchema = z.object({
  type: z.literal("typing-broadcast"),
  channelId: z.string().uuid(),
  userId: z.string().uuid(),
  displayName: z.string(),
});

/**
 * Sent to members who can see a channel but are not currently viewing it, so
 * unread badges update live instead of only on refresh. Deliberately carries no
 * message content — it is a notification, not a delivery.
 */
export const channelActivitySchema = z.object({
  type: z.literal("channel-activity"),
  /**
   * Null when the activity is in a conversation, which has no server.
   *
   * This was required until conversations existed, so it is a wire change: a
   * client older than this schema rejects the whole frame rather than
   * mis-filing it, which costs a live unread badge until that client reloads
   * and never routes a DM's activity into a server.
   */
  serverId: z.string().uuid().nullable(),
  /**
   * Which list the badge belongs in — the server sidebar or the conversation
   * list. Derivable from a null `serverId` today, and sent anyway so a client
   * never has to infer a kind from the absence of a field.
   */
  kind: channelKindSchema.default("server"),
  channelId: z.string().uuid(),
  mention: z.boolean(),
});

export const reactionBroadcastSchema = z.object({
  type: z.literal("reaction-broadcast"),
  channelId: z.string().uuid(),
  messageId: z.string().uuid(),
  emoji: z.string(),
  userId: z.string().uuid(),
  added: z.boolean(),
  /** Server nickname when there is one, otherwise the account display name. */
  displayName: z.string().min(1).optional(),
});

export const messageDeletedBroadcastSchema = z.object({
  type: z.literal("message-deleted"),
  channelId: z.string().uuid(),
  messageId: z.string().uuid(),
});

export const presenceUpdateSchema = z.object({
  type: z.literal("presence-update"),
  channelId: z.string().uuid(),
  users: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      avatarUrl: z.string().nullable(),
    }),
  ),
});

/**
 * Somebody's profile changed — a new avatar, a rename, a new handle.
 *
 * FANNED OUT TO EVERY CONNECTED SOCKET, not to a channel. A person's name and
 * picture are drawn in places that have no channel to key off: the member list
 * of a server nobody is currently viewing, a conversation row in the sidebar,
 * the roster of a call. Addressing this frame to a channel would leave every
 * one of those showing the old picture until reload, which is the whole reason
 * it exists.
 *
 * Everything in it is already public — it is exactly `publicUserSchema`'s
 * fields, the same set any account can read about any other through user
 * search — so a global fan-out discloses nothing that was not already
 * enumerable. Nothing account-private may be added here for that reason;
 * `clerkId`, `dmPrivacy` and `ageGate` in particular are `userSchema` fields
 * and would be a real leak.
 */
export const profileUpdateSchema = z.object({
  type: z.literal("profile-update"),
  userId: z.string().uuid(),
  displayName: z.string(),
  username: z.string().nullable(),
  tag: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});

export const chatServerMessageSchema = z.discriminatedUnion("type", [
  messageBroadcastSchema,
  messageUpdateBroadcastSchema,
  messageDeleteBroadcastSchema,
  reactionBroadcastSchema,
  messageDeletedBroadcastSchema,
  presenceUpdateSchema,
  typingBroadcastSchema,
  channelActivitySchema,
  profileUpdateSchema,
  // --- threads ---
  threadUpdateBroadcastSchema,
  // A refusal is a chat outcome: it is sent over the chat socket, in response
  // to a chat action, and it describes what happened to a message somebody
  // tried to send. It belongs in the type the chat socket is declared to carry,
  // and being in it is what lets `App.tsx` route it by name instead of letting
  // it fall through to the voice signaling handler.
  sanctionNoticeSchema,
  // Same addressing as `sanction-notice`: one sender, never the channel.
  messageRejectedSchema,
  // Addressed to one person, like `sanction-notice` and for the same reason —
  // see the note on `friendActivitySchema`, and its absence from the list
  // below.
  friendActivitySchema,
  // Same addressing as `friend-activity`: each member's snapshot differs, so
  // this is delivered per socket, never through the channel relay. Listing it
  // in `CHAT_SERVER_MESSAGE_TYPES` would drop it (no channel id) or, worse,
  // hand a server-wide version bump to whoever happened to be looking at a
  // channel the frame named.
  permissionsUpdateSchema,
  communityHomeUpdateSchema,
  pollUpdateBroadcastSchema,
]);

/**
 * `discriminatedUnion` only takes plain objects as options, so the refinement
 * on `messageCreateMessageSchema` cannot ride along inside the union — and this
 * is the schema every inbound frame is actually parsed with. Re-applying the
 * same function here is what keeps the two from drifting; dropping it would
 * leave the empty-message rule enforced only on a schema nothing parses with.
 */
const chatClientFrameUnion = z.discriminatedUnion("type", [
  joinChannelMessageSchema,
  leaveChannelMessageSchema,
  messageCreateFrameSchema,
  reactionToggleMessageSchema,
  typingMessageSchema,
  // --- threads --- the secondary view slot beside the primary channel.
  threadJoinMessageSchema,
  threadLeaveMessageSchema,
  // Not chat, but it rides the chat socket because the thing it describes IS
  // the socket: "the person holding this connection stopped touching their
  // keyboard". Sending it over HTTP would need a way to name one connection
  // from outside it, which is an identifier this design does not otherwise
  // need to invent.
  setIdleMessageSchema,
  pollVoteMessageSchema,
  pollCloseMessageSchema,
]);

export const chatClientMessageSchema = chatClientFrameUnion.superRefine(
  (message, ctx) => {
    if (message.type === "message-create") {
      requireBodyOrAttachment(message, ctx);
    }
  },
);

/**
 * Every frame type the chat socket accepts, read off the union above rather
 * than written out again.
 *
 * The socket router in `server/src/ws/index.ts` dispatches on frame type before
 * anything parses the frame, so it needs this list. It used to keep its own
 * copy, and the copy fell behind the protocol twice: `thread-join` /
 * `thread-leave` and then `poll-vote` / `poll-close` were all accepted by this
 * schema and dropped on the floor by the router. Nothing caught it, because
 * every handler test calls `handleChatMessage` directly and so never crosses
 * the router at all. Deriving the list removes the copy that can drift.
 */
export const CHAT_CLIENT_MESSAGE_TYPES: readonly string[] =
  chatClientFrameUnion.options.map((option) => option.shape.type.value);

/**
 * The chat frames that may be **fanned out to a whole channel**.
 *
 * Its one caller is the cluster relay in `server/src/ws/chat.ts`, which takes a
 * frame published by another instance and delivers it to every socket in a
 * channel. So this is not "every member of `chatServerMessageSchema`" — it is
 * the subset for which delivering to everyone is the correct thing to do, and
 * the two lists are allowed to differ in exactly one direction.
 *
 * Every *broadcast* type must be listed: a type missing here is a frame the
 * relay silently drops. `message-deleted` was missing exactly that way; both
 * spellings are live on the wire (see the two schemas above, and the client's
 * `use-chat.ts`, which handles them in one case block).
 *
 * `profile-update` is deliberately absent for the opposite reason to the one
 * below: it is not too narrow for a channel fan-out but too *wide* for one. It
 * is addressed to every connected socket and carries no channel at all, so it
 * travels on its own cluster topic (`chat.profile`) and reaches other instances
 * through that. Listing it here would hand it to the channel relay, which would
 * deliver it to whichever channel id happened to be on the frame — there is
 * none — and drop it.
 *
 * `sanction-notice` is deliberately absent, and must stay absent. It is
 * addressed to one person — it names their timeout, its expiry and its reason —
 * and the server delivers it straight to that socket. Listing it here would
 * make the relay willing to hand one member's sanction to everyone in the
 * channel, which is a disclosure this guard is the last thing standing between.
 *
 * `message-rejected` is absent for the same reason: it tells one sender
 * their create did not land. The relay must not fan that out.
 *
 * `friend-activity` is absent on the same grounds. It is addressed to one
 * person, it names no channel, and it travels between instances on its own
 * topic (`chat.friend`) keyed by user id. Listing it here would hand a "you
 * have a friend request" nudge to a whole channel — content-free, so not a
 * disclosure, but a badge appearing on strangers' screens is still a bug.
 *
 * `permissions-update` is absent for the same reason as `friend-activity`: it
 * is addressed to a server's members, names no channel, and travels on
 * `chat.permissions`. The payload is a version number; each client refetches
 * its own snapshot. Fanning it out via the channel relay would deliver nothing.
 *
 * `community-home-update` is absent for the same reason: server-scoped, no
 * channel, clients refetch Baú. It travels on `chat.community-home`.
 */
export const CHAT_SERVER_MESSAGE_TYPES = [
  "message-broadcast",
  "message-update",
  "message-delete",
  "message-deleted",
  "reaction-broadcast",
  "presence-update",
  "typing-broadcast",
  "channel-activity",
  // --- threads --- the chip refresh for parent-channel viewers; content-free,
  // so fanning it out to everyone in the parent channel is correct.
  "thread-update",
  "poll-update",
] as const;

export function isChatServerMessage(message: {
  type: string;
}): message is ChatServerMessage {
  return (CHAT_SERVER_MESSAGE_TYPES as readonly string[]).includes(message.type);
}

export type JoinChannelMessage = z.infer<typeof joinChannelMessageSchema>;
export type MessageBroadcast = z.infer<typeof messageBroadcastSchema>;
export type MessageUpdateBroadcast = z.infer<
  typeof messageUpdateBroadcastSchema
>;
export type MessageDeleteBroadcast = z.infer<
  typeof messageDeleteBroadcastSchema
>;
export type ReactionBroadcast = z.infer<typeof reactionBroadcastSchema>;
export type MessageDeletedBroadcast = z.infer<
  typeof messageDeletedBroadcastSchema
>;
export type PresenceUpdate = z.infer<typeof presenceUpdateSchema>;
export type TypingBroadcast = z.infer<typeof typingBroadcastSchema>;
export type ChannelActivity = z.infer<typeof channelActivitySchema>;
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;
export type PollVoteMessage = z.infer<typeof pollVoteMessageSchema>;
export type PollCloseMessage = z.infer<typeof pollCloseMessageSchema>;
export type PollUpdateBroadcast = z.infer<typeof pollUpdateBroadcastSchema>;
export type ChatClientMessage = z.infer<typeof chatClientMessageSchema>;
export type ChatServerMessage = z.infer<typeof chatServerMessageSchema>;
