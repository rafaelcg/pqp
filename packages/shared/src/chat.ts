import { z } from "zod";
import {
  MESSAGE_MAX_LENGTH,
  messageReactionSchema,
  messageReplyRefSchema,
  reactionEmojiSchema,
  safeTextSchema,
} from "./api.js";
import {
  attachmentSchema,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "./attachments.js";

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
  body: z.string().max(MESSAGE_MAX_LENGTH).pipe(safeTextSchema),
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
  frame: { body: string; attachmentIds?: string[] },
  ctx: z.RefinementCtx,
): void {
  if (frame.body.length === 0 && !frame.attachmentIds?.length) {
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
});

export const messageBroadcastSchema = z.object({
  type: z.literal("message-broadcast"),
  message: broadcastMessageSchema,
  nonce: z.string().optional(),
});

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
  serverId: z.string().uuid(),
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

export const chatServerMessageSchema = z.discriminatedUnion("type", [
  messageBroadcastSchema,
  messageUpdateBroadcastSchema,
  messageDeleteBroadcastSchema,
  reactionBroadcastSchema,
  messageDeletedBroadcastSchema,
  presenceUpdateSchema,
  typingBroadcastSchema,
  channelActivitySchema,
]);

/**
 * `discriminatedUnion` only takes plain objects as options, so the refinement
 * on `messageCreateMessageSchema` cannot ride along inside the union — and this
 * is the schema every inbound frame is actually parsed with. Re-applying the
 * same function here is what keeps the two from drifting; dropping it would
 * leave the empty-message rule enforced only on a schema nothing parses with.
 */
export const chatClientMessageSchema = z
  .discriminatedUnion("type", [
    joinChannelMessageSchema,
    leaveChannelMessageSchema,
    messageCreateFrameSchema,
    reactionToggleMessageSchema,
    typingMessageSchema,
  ])
  .superRefine((message, ctx) => {
    if (message.type === "message-create") {
      requireBodyOrAttachment(message, ctx);
    }
  });

/** Server message types the chat controller owns (everything else is voice). */
export const CHAT_SERVER_MESSAGE_TYPES = [
  "message-broadcast",
  "message-update",
  "message-delete",
  "reaction-broadcast",
  "presence-update",
  "typing-broadcast",
  "channel-activity",
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
export type ChatClientMessage = z.infer<typeof chatClientMessageSchema>;
export type ChatServerMessage = z.infer<typeof chatServerMessageSchema>;
