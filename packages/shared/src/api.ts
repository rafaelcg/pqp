import { z } from "zod";

export const channelTypeSchema = z.enum(["text", "voice"]);
export type ChannelType = z.infer<typeof channelTypeSchema>;

export const memberRoleSchema = z.enum(["owner", "admin", "member"]);
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const usernameSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9_]+$/, "Username must be lowercase letters, numbers, or _");

export const userSchema = z.object({
  id: z.string().uuid(),
  clerkId: z.string(),
  displayName: z.string(),
  username: z.string().nullable(),
  discriminator: z.string().nullable(),
  tag: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});

export const serverSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  ownerId: z.string().uuid(),
  role: memberRoleSchema.optional(),
  createdAt: z.string(),
});

export const channelSchema = z.object({
  id: z.string().uuid(),
  serverId: z.string().uuid(),
  name: z.string(),
  type: channelTypeSchema,
  position: z.number(),
  isPrivate: z.boolean(),
  topic: z.string().nullable().default(null),
  imageUrl: z.string().nullable().default(null),
});

export const reactionEmojiSchema = z
  .string()
  .min(1)
  .max(32)
  .refine((value) => !/\s/.test(value), "Invalid emoji");

export const messageReactionSchema = z.object({
  emoji: z.string(),
  count: z.number().int().positive(),
  me: z.boolean(),
});

export const messageSchema = z.object({
  id: z.string().uuid(),
  channelId: z.string().uuid(),
  authorId: z.string().uuid(),
  authorName: z.string(),
  authorTag: z.string().nullable(),
  authorAvatarUrl: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  reactions: z.array(messageReactionSchema).default([]),
});

export const inviteSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  serverId: z.string().uuid(),
  serverName: z.string().optional(),
  maxUses: z.number().nullable(),
  uses: z.number(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});

export const createServerSchema = z.object({
  name: z.string().min(1).max(100),
});

export const createChannelSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-_]+$/i, "Use letters, numbers, - or _"),
  type: channelTypeSchema,
  isPrivate: z.boolean().optional().default(false),
});

export const updateChannelSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-_]+$/i)
    .optional(),
  isPrivate: z.boolean().optional(),
  topic: z.string().max(200).nullable().optional(),
  imageUrl: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .refine(
      (value) =>
        value == null ||
        value === "" ||
        value.startsWith("http://") ||
        value.startsWith("https://") ||
        value.startsWith("/") ||
        [...value].length <= 8,
      "Use an image URL or a short emoji/icon",
    ),
});

export const createInviteSchema = z.object({
  maxUses: z.number().int().positive().nullable().optional(),
  expiresInHours: z.number().int().positive().nullable().optional(),
});

export const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  username: usernameSchema.optional(),
  avatarUrl: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .refine(
      (value) =>
        value == null ||
        value === "" ||
        value.startsWith("http://") ||
        value.startsWith("https://") ||
        value.startsWith("/"),
      "Avatar must be an image URL",
    ),
});

export const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});

export type IceServerConfig = z.infer<typeof iceServerSchema>;

export const updateMemberRoleSchema = z.object({
  role: z.enum(["admin", "member"]),
});

export const addChannelMemberSchema = z.object({
  userId: z.string().uuid(),
});

export const banMemberSchema = z.object({
  userId: z.string().uuid(),
  reason: z.string().max(500).nullable().optional(),
});

export type User = z.infer<typeof userSchema>;
export type Server = z.infer<typeof serverSchema>;
export type Channel = z.infer<typeof channelSchema>;
export type Message = z.infer<typeof messageSchema>;
export type MessageReaction = z.infer<typeof messageReactionSchema>;
export type Invite = z.infer<typeof inviteSchema>;

export function formatUserTag(
  username: string | null | undefined,
  discriminator: string | null | undefined,
): string | null {
  if (!username || !discriminator) {
    return null;
  }
  return `${username}#${discriminator}`;
}
