import { z } from "zod";
import { messageReactionSchema, reactionEmojiSchema } from "./api.js";

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
  body: z.string().min(1).max(4000),
});

export const reactionToggleMessageSchema = z.object({
  type: z.literal("reaction-toggle"),
  channelId: z.string().uuid(),
  messageId: z.string().uuid(),
  emoji: reactionEmojiSchema,
});

export const messageBroadcastSchema = z.object({
  type: z.literal("message-broadcast"),
  message: z.object({
    id: z.string().uuid(),
    channelId: z.string().uuid(),
    authorId: z.string().uuid(),
    authorName: z.string(),
    authorTag: z.string().nullable().optional(),
    authorAvatarUrl: z.string().nullable(),
    body: z.string(),
    createdAt: z.string(),
    reactions: z.array(messageReactionSchema).default([]),
  }),
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
  reactionBroadcastSchema,
  messageDeletedBroadcastSchema,
  presenceUpdateSchema,
]);

export const chatClientMessageSchema = z.discriminatedUnion("type", [
  joinChannelMessageSchema,
  leaveChannelMessageSchema,
  messageCreateMessageSchema,
  reactionToggleMessageSchema,
]);

export type JoinChannelMessage = z.infer<typeof joinChannelMessageSchema>;
export type MessageBroadcast = z.infer<typeof messageBroadcastSchema>;
export type ReactionBroadcast = z.infer<typeof reactionBroadcastSchema>;
export type MessageDeletedBroadcast = z.infer<
  typeof messageDeletedBroadcastSchema
>;
export type PresenceUpdate = z.infer<typeof presenceUpdateSchema>;
export type ChatClientMessage = z.infer<typeof chatClientMessageSchema>;
export type ChatServerMessage = z.infer<typeof chatServerMessageSchema>;
