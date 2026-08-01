import { z } from "zod";
import {
  messageBodySchema,
  messageReactionSchema,
  reactionEmojiSchema,
} from "./api.js";

export const joinChannelMessageSchema = z.object({
  type: z.literal("join-channel"),
  channelId: z.string().uuid(),
});

export const leaveChannelMessageSchema = z.object({
  type: z.literal("leave-channel"),
});

export const messageCreateMessageSchema = z.object({
  type: z.literal("message-create"),
  channelId: z.string().uuid(),
  body: messageBodySchema,
  /**
   * Client-generated id echoed back on the broadcast so the sender can swap its
   * optimistic bubble for the stored message instead of rendering it twice.
   */
  nonce: z.string().min(1).max(64).optional(),
});

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
  presenceUpdateSchema,
  typingBroadcastSchema,
  channelActivitySchema,
]);

export const chatClientMessageSchema = z.discriminatedUnion("type", [
  joinChannelMessageSchema,
  leaveChannelMessageSchema,
  messageCreateMessageSchema,
  reactionToggleMessageSchema,
  typingMessageSchema,
]);

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
export type PresenceUpdate = z.infer<typeof presenceUpdateSchema>;
export type TypingBroadcast = z.infer<typeof typingBroadcastSchema>;
export type ChannelActivity = z.infer<typeof channelActivitySchema>;
export type ChatClientMessage = z.infer<typeof chatClientMessageSchema>;
export type ChatServerMessage = z.infer<typeof chatServerMessageSchema>;
