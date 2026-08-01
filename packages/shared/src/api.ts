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

export const themePreferenceSchema = z.enum(["light", "dark", "system"]);
export type ThemePreference = z.infer<typeof themePreferenceSchema>;

export const notificationLevelSchema = z.enum(["all", "mentions", "none"]);
export type NotificationLevel = z.infer<typeof notificationLevelSchema>;

/**
 * How loudly each place is allowed to interrupt, keyed by id. A channel entry
 * wins over the entry for the server it belongs to, which wins over `default`.
 *
 * Ids appear only once they diverge from what they inherit, so the common case
 * — one chatty #general turned down inside an otherwise normal server — costs
 * two keys rather than a row per channel the user is in.
 *
 * The whole object is replaced on write, never patched key by key: the
 * preference store merges one level deep (jsonb `||`), so a client that sent
 * `{ channels: { x: "none" } }` would drop every other channel's choice.
 */
export const notificationPreferencesSchema = z.object({
  /**
   * Whether the user has opted into OS-level notifications at all. Separate
   * from the browser permission, which they can revoke without telling us and
   * which cannot be re-requested without another explicit click.
   */
  desktop: z.boolean().optional(),
  default: notificationLevelSchema.optional(),
  servers: z.record(z.string().uuid(), notificationLevelSchema).optional(),
  channels: z.record(z.string().uuid(), notificationLevelSchema).optional(),
});

export type NotificationPreferences = z.infer<
  typeof notificationPreferencesSchema
>;

/**
 * Settings that belong to the person rather than to the machine they are on,
 * stored as one JSONB blob so adding a preference stays a schema change here
 * instead of a database migration.
 *
 * Every field is optional because a write is a patch: the client sends what the
 * user just changed, and the server merges it over what is already stored.
 *
 * Audio device ids are deliberately absent and must stay device-local. A
 * `deviceId` identifies hardware within one browser profile on one machine, so
 * the value means nothing on the next device — and
 * `getUserMedia({ audio: { deviceId: { exact } } })` rejects with
 * OverconstrainedError rather than falling back when it does not resolve, which
 * would turn "signed in on my laptop" into "microphone broken on my phone".
 *
 * Unknown keys are stripped rather than rejected (zod's default): the SPA and
 * the API deploy separately, so a client that already knows about a preference
 * this server does not must still get the rest of its patch saved.
 */
export const userPreferencesSchema = z.object({
  theme: themePreferenceSchema.optional(),
  muteOnJoin: z.boolean().optional(),
  compactPeers: z.boolean().optional(),
  /** Mic gain, where 1 is unity and 2 is the boost ceiling the UI exposes. */
  inputVolume: z.number().min(0).max(2).optional(),
  outputVolume: z.number().min(0).max(1).optional(),
  notifications: notificationPreferencesSchema.optional(),
});

export type UserPreferences = z.infer<typeof userPreferencesSchema>;

export const userSchema = z.object({
  id: z.string().uuid(),
  clerkId: z.string(),
  displayName: z.string(),
  username: z.string().nullable(),
  discriminator: z.string().nullable(),
  tag: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  /**
   * Optional so a client built against this schema still parses a response
   * from an API that predates the preference store.
   */
  preferences: userPreferencesSchema.optional(),
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

/**
 * Postgres rejects NUL bytes in `text` parameters (SQLSTATE 22021), so any
 * control character that reaches a query turns into a driver-level error rather
 * than a validation failure. Strip them at the schema boundary instead.
 * Newline and tab are kept — messages are multi-line.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const safeTextSchema = z
  .string()
  .refine((value) => !CONTROL_CHARS.test(value), "Invalid characters");

export const reactionEmojiSchema = z
  .string()
  .min(1)
  .max(32)
  .refine((value) => !/\s/.test(value), "Invalid emoji")
  .refine((value) => !CONTROL_CHARS.test(value), "Invalid emoji");

export const messageReactionSchema = z.object({
  emoji: z.string(),
  count: z.number().int().positive(),
  me: z.boolean(),
});

/** How much of a replied-to message travels with the reply. */
export const REPLY_EXCERPT_MAX_LENGTH = 120;

/**
 * Denormalised snapshot of the message a reply answers, so drawing the quote
 * header never costs a second fetch.
 *
 * The author fields are nullable rather than required: a parent can be gone by
 * the time a client renders the reply, and a quote that cannot name anyone is
 * still worth showing as "the original message was deleted".
 */
export const messageReplyRefSchema = z.object({
  id: z.string().uuid(),
  authorId: z.string().uuid().nullable(),
  authorName: z.string().nullable(),
  excerpt: z.string().max(REPLY_EXCERPT_MAX_LENGTH),
  deleted: z.boolean(),
});

export type MessageReplyRef = z.infer<typeof messageReplyRefSchema>;

/**
 * Flatten a body to a single short line for a quote header. Markdown is left
 * intact — stripping it would need the whole parser on the server, and a quote
 * header is a hint rather than a rendering.
 */
export function buildReplyExcerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= REPLY_EXCERPT_MAX_LENGTH) {
    return flat;
  }
  // Cutting by code unit can split a surrogate pair, which renders as U+FFFD.
  let cut = REPLY_EXCERPT_MAX_LENGTH - 1;
  const lead = flat.charCodeAt(cut - 1);
  if (lead >= 0xd800 && lead <= 0xdbff) {
    cut -= 1;
  }
  return `${flat.slice(0, cut).trimEnd()}…`;
}

export const messageSchema = z.object({
  id: z.string().uuid(),
  channelId: z.string().uuid(),
  authorId: z.string().uuid(),
  authorName: z.string(),
  authorTag: z.string().nullable(),
  authorAvatarUrl: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  editedAt: z.string().nullable().default(null),
  reactions: z.array(messageReactionSchema).default([]),
  replyTo: messageReplyRefSchema.nullable().default(null),
});

export const MESSAGE_MAX_LENGTH = 4000;

export const messageBodySchema = z
  .string()
  .min(1)
  .max(MESSAGE_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARS.test(value), "Invalid characters");

export const updateMessageSchema = z.object({
  body: messageBodySchema,
});

/** How many messages a single history request may return. */
export const MESSAGE_PAGE_SIZE = 50;
export const MESSAGE_PAGE_MAX = 100;

export const channelUnreadSchema = z.object({
  channelId: z.string().uuid(),
  count: z.number().int().nonnegative(),
  mentions: z.number().int().nonnegative(),
});

export type ChannelUnread = z.infer<typeof channelUnreadSchema>;

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

export const updateServerSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  ownerId: z.string().uuid().optional(),
});

export const removeMemberSchema = z.object({
  /** Also add the member to the server ban list so invites stop working. */
  ban: z.boolean().optional().default(false),
});

/**
 * Mentions are written as `@username` (the unique slug half of `name#1234`).
 * Kept in shared so the server's notification counting and the client's
 * highlighting can never disagree about what counts as a mention.
 */
export const MENTION_PATTERN = /@([A-Za-z0-9_]{2,32})/g;

export function extractMentionUsernames(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const name = match[1];
    if (name) {
      found.add(name.toLowerCase());
    }
  }
  return [...found];
}

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
