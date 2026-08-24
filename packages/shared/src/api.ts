import { z } from "zod";
import { attachmentSchema } from "./attachments.js";
import { embedSchema } from "./embeds.js";
import { handleSchema } from "./profiles.js";
import { nicknameSchema } from "./permissions.js";
import { manualStatusSchema } from "./status.js";
// --- threads ---
import { threadSummarySchema } from "./threads.js";
import { webhookEmbedSchema } from "./webhooks.js";

export const channelTypeSchema = z.enum(["text", "voice", "category"]);
export type ChannelType = z.infer<typeof channelTypeSchema>;

/**
 * What a channel row *is*, as opposed to what it carries (`type` above).
 *
 * `'server'` is a channel inside a server. `'dm'` and `'group'` are
 * conversations, which have no server and whose participants are rows in
 * `channel_members`. One kind column rather than a second table, so messages,
 * reactions, read cursors, mentions and attachments are reused unchanged.
 */
export const channelKindSchema = z.enum(["server", "dm", "group"]);
export type ChannelKind = z.infer<typeof channelKindSchema>;

/**
 * Who may open a conversation with a user.
 *
 * `'server_members'` means "someone I already share a server with" — the only
 * relationship this product models. Stating the rule in those terms is what
 * lets DM privacy ship without first building a friend graph to gate it.
 */
export const dmPrivacySchema = z.enum([
  "everyone",
  "server_members",
  "nobody",
]);
export type DmPrivacy = z.infer<typeof dmPrivacySchema>;

export const memberRoleSchema = z.enum(["owner", "admin", "member"]);
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const usernameSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9_]+$/, "Username must be lowercase letters, numbers, or _")
  .refine(
    (value) => value !== "everyone" && value !== "here",
    "That username is reserved",
  );

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
 * In-app sound cues. Replaced as a whole on write, same as `notifications`:
 * the preference store merges one level deep, so a patch of
 * `{ sounds: { message: false } }` would drop every other cue. The client
 * always sends the full object.
 *
 * Independent of `notifications.desktop`. Sounds still play when OS banners
 * are off. Device ids stay out of this object.
 */
export const soundPreferencesSchema = z.object({
  enabled: z.boolean().optional(),
  message: z.boolean().optional(),
  mention: z.boolean().optional(),
  voiceJoin: z.boolean().optional(),
  voiceLeave: z.boolean().optional(),
  incomingCall: z.boolean().optional(),
  outgoingCall: z.boolean().optional(),
});

export type SoundPreferences = z.infer<typeof soundPreferencesSchema>;

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
  /**
   * Voice-activity or push-to-talk. Synced because it is a preference about
   * how you talk, not about this machine — somebody who uses PTT on a laptop
   * wants it on the desktop too.
   *
   * The KEY BINDING is deliberately NOT here. It is a physical key position
   * (`KeyboardEvent.code`), so syncing it to a phone with no keyboard, or to a
   * different physical layout, means carrying a binding that cannot be pressed.
   * That one stays device-local.
   */
  inputMode: z.enum(["voice-activity", "push-to-talk"]).optional(),
  micProcessing: z
    .object({
      echoCancellation: z.boolean(),
      noiseSuppression: z.boolean(),
      autoGainControl: z.boolean(),
    })
    .optional(),
  /**
   * The manual half of user status — `dnd` or `invisible`, or `online` meaning
   * "no override". Absent is the same as `online`.
   *
   * A PREFERENCE AND NOT A `users` COLUMN, for three reasons that all point the
   * same way. It has to survive a reconnect and follow the person across
   * devices, which rules out anything socket-scoped or in localStorage. It is
   * read exactly once per socket and never on the message path, so it does not
   * want to be on `users` — the table every message, member list and mention
   * lookup already joins, and the one place a migration is most expensive. And
   * what it stores is a *choice*: the derived half of status (online, idle,
   * offline) is deliberately not stored anywhere at all, because a stored
   * "online" outlives the process that was holding the socket.
   *
   * That it lands in an existing JSONB blob is why user status ships with no
   * database migration whatsoever.
   *
   * `invisible` is written here in the clear and is only ever read back to its
   * own owner — `/api/me` is the account's own view of itself. What third
   * parties are told goes through `userStatusSchema`, which has no `invisible`
   * member at all.
   */
  status: manualStatusSchema.optional(),
  theme: themePreferenceSchema.optional(),
  muteOnJoin: z.boolean().optional(),
  compactPeers: z.boolean().optional(),
  /** Mic gain, where 1 is unity and 2 is the boost ceiling the UI exposes. */
  inputVolume: z.number().min(0).max(2).optional(),
  outputVolume: z.number().min(0).max(1).optional(),
  notifications: notificationPreferencesSchema.optional(),
  sounds: soundPreferencesSchema.optional(),
  /**
   * Client-render-only: the server unfurls and caches a link regardless of
   * who has this off, since the cache is shared across every viewer. Turning
   * it off just stops one person's client from drawing the card it already
   * received.
   */
  showLinkEmbeds: z.boolean().optional(),
  /**
   * When first-run onboarding was finished or skipped, as an ISO instant.
   *
   * A preference rather than a `users` column: it is not enforced server-side,
   * nothing joins on it, and it has to follow the person across devices —
   * localStorage would replay the whole flow on every new browser, and a column
   * would be a migration on the hottest table in the schema for a flag read
   * exactly once per session. It also rides down with `/api/me`, which the
   * client already awaits before first paint, so the check costs no request.
   *
   * Accounts that predate onboarding are backfilled with this key by a one-shot
   * data migration in `schema.sql` — see `onboarding_grandfather_2026_08`.
   * Absent therefore means "signed up after onboarding shipped", not "old".
   *
   * The value is only ever read for presence; the instant is for support and
   * for telling a backfilled account from one that really ran the flow.
   */
  onboardedAt: z.string().optional(),
  /**
   * When this account was dropped into the instance's default community, as an
   * ISO instant. Written once, and its only job is to make sure that never
   * happens twice.
   *
   * A PREFERENCE AND NOT A MEMBERSHIP CHECK. "Is this person already in the
   * default community" is the wrong question, because the answer changes the
   * moment they leave it, and re-adding somebody to a room they walked out of
   * is the single most obnoxious thing an auto-join can do. "Have we ever put
   * them there" does not change, so that is what is recorded.
   *
   * Absent means "never placed", which reads correctly for a brand new account
   * and for every account that predates the feature. Nobody who already has
   * communities gets swept in, because the placement only runs for an account
   * with no memberships at all.
   */
  defaultCommunityJoinedAt: z.string().optional(),
  /**
   * When the first-run checklist in the hub was put away, as an ISO instant.
   *
   * Separate from `onboardedAt` because they answer different questions.
   * `onboardedAt` means "the wizard has run"; this means "stop offering the
   * three things a new account has not done yet". The wizard is a modal you
   * cannot avoid and it ends in a couple of clicks, so finishing it says almost
   * nothing about whether the account has a server, a friend, or a face — all
   * three are skippable from inside it. The checklist is what covers the gap
   * after, and it needs its own "no thanks".
   *
   * Set two ways, and the second is the one that matters. Explicitly, when
   * somebody dismisses the card. And automatically, the first time all three
   * items read as done — because the card's visibility is otherwise *derived*
   * from live state (servers, friends, avatar), and derived state comes back:
   * leave your last server a year from now and a "get into a server" nudge
   * would reappear at somebody who has been here a year. Stamping on completion
   * is what makes "never returns" true rather than "usually does not return".
   *
   * A preference and not localStorage for the same reason as `onboardedAt`: a
   * new browser must not re-offer a checklist somebody already answered. No
   * migration and no backfill — absent means "never dismissed", which is the
   * right reading for both a brand-new account and an old one, since an old
   * account with all three done never renders the card and gets stamped on its
   * first hub visit anyway.
   */
  firstRunDismissedAt: z.string().optional(),
});

export type UserPreferences = z.infer<typeof userPreferencesSchema>;

// ------------------------------------------------------------- age gate (18+)

/**
 * The minimum age the Terms require. Shared rather than repeated so the
 * sentence the user reads, the boundary the server computes, and the tests that
 * pin it are all the same number.
 */
export const MINIMUM_AGE_YEARS = 18;

/**
 * Where an account stands with the 18+ check.
 *
 * - `pending` — never answered. Everything except the exempt routes is refused
 *   until they do; this is also what every account that predates the gate
 *   reads, so existing users are prompted rather than grandfathered.
 * - `passed`  — declared a date of birth of at least `MINIMUM_AGE_YEARS`.
 * - `blocked` — declared a date of birth under it. There is exactly one
 *   attempt, and no self-serve way out of this state.
 */
export const ageGateStatusSchema = z.enum(["pending", "passed", "blocked"]);

export type AgeGateStatus = z.infer<typeof ageGateStatusSchema>;

/**
 * The one-shot declaration.
 *
 * A plain `YYYY-MM-DD` calendar date with no time and no zone, because that is
 * what a date of birth is — attaching an instant to it is what produces the
 * classic off-by-one where somebody is refused on their own birthday. The
 * regex only proves the shape; whether the date exists (and is not in the
 * future) is decided server-side, since only the server's answer counts.
 */
export const ageDeclarationSchema = z.object({
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date"),
});

export type AgeDeclarationRequest = z.infer<typeof ageDeclarationSchema>;

export const ageCheckResponseSchema = z.object({
  ageGate: ageGateStatusSchema,
});

export type AgeCheckResponse = z.infer<typeof ageCheckResponseSchema>;

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
  /**
   * A column rather than a preference, because it is enforced server-side on
   * every attempt to open a conversation — a setting the server must read
   * cannot live in a blob the client is free to reshape. Defaulted here so a
   * response from an API that predates DM privacy still parses, and defaulted
   * to the same value as the column so the two can never disagree.
   */
  dmPrivacy: dmPrivacySchema.default("server_members"),
  /**
   * Where this account stands with the 18+ check. Only ever sent to the
   * account's own owner — like `clerkId` above, and for the same reason: it is
   * the one field on this shape that says something about a person rather than
   * about how they appear to others.
   *
   * Optional, and an absent value must be read as "this API predates the gate",
   * not as "passed" — the client only *skips* the gate on an explicit `passed`.
   */
  ageGate: ageGateStatusSchema.optional(),
  /**
   * The account's public handle — `pqp.gg/@rafa` — or null when it has never
   * claimed one, which is most accounts.
   *
   * On `userSchema` and deliberately NOT on `publicUserSchema`. A handle is
   * public by definition, so hiding it is not the point; the point is that
   * nothing in the app needs somebody else's handle to render a message row or
   * a member list, and the shape that reaches strangers should carry only what
   * its call sites use. The public *profile* endpoint is where a handle is read
   * about somebody else, and it is keyed BY the handle.
   */
  handle: z.string().nullable().default(null),
  /**
   * When the handle last moved, so Settings can say when it may move again
   * without a second round trip. Null means never — the first claim is free.
   */
  handleChangedAt: z.string().nullable().default(null),
  /**
   * The banner across the top of this account's public page, or null.
   *
   * On `userSchema` and deliberately NOT on `publicUserSchema`, exactly as
   * `handle` is: nothing in the app draws somebody else's banner, and the one
   * surface that does — `pqp.gg/@rafa` — reads it from the public profile
   * endpoint keyed by handle rather than from any user payload. Defaulted so a
   * response from an API that predates banners still parses.
   */
  bannerUrl: z.string().nullable().default(null),
});

/**
 * A user as seen by somebody who is not that user.
 *
 * THIS IS NOT `userSchema`. `userSchema` — and `toPublicUser` on the server,
 * despite its name — carries `clerkId`, the account's identifier at the
 * identity provider. That is only ever safe because every response shaped that
 * way is sent to the account's own owner. User search and DM participant lists
 * hand a user to a stranger, so they must use this shape instead.
 *
 * Every field here is something the two of them could already read off a
 * message they can both see. Anything added becomes part of what any account
 * can enumerate about any other account in the instance, so nothing that is not
 * already public may be added — least of all `clerkId`, an email, or a
 * presence/last-seen field.
 */
export const publicUserSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  username: z.string().nullable(),
  tag: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});

export type PublicUser = z.infer<typeof publicUserSchema>;

/** ~10 years — generous enough for any real policy, bounded so a typo
 * (a year expressed in days times itself, say) cannot request forever
 * through a very large finite number instead of through `null`. */
export const MAX_MESSAGE_RETENTION_DAYS = 3650;

export const serverSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  ownerId: z.string().uuid(),
  role: memberRoleSchema.optional(),
  createdAt: z.string(),
  /** Null means keep forever. */
  messageRetentionDays: z.number().int().positive().max(MAX_MESSAGE_RETENTION_DAYS).nullable(),
  /** Null means SSO domain joining is off for this server. */
  ssoEmailDomain: z.string().nullable().default(null),
  /**
   * The server's two pictures, or null where it has none.
   *
   * Root-relative `/api/servers/:id/icon?v=…` when uploaded here — see
   * `serverIconPath` in `./server-images.js` for why the server does not bake
   * its own origin in. Defaulted so a client built against this schema still
   * parses a response from an API that predates them, which is what lets the
   * rail keep drawing monograms during a rolling deploy.
   */
  iconUrl: z.string().nullable().default(null),
  bannerUrl: z.string().nullable().default(null),
  /**
   * Whether this server is listed in the public directory. Defaulted so a
   * response from an API that predates communities still parses.
   *
   * On the member's own list rather than only in the directory because it is
   * what decides whether the rail's context menu offers "show this on my
   * profile" at all — a private server is never chipped onto anybody's card, so
   * offering the switch there would be offering a no-op.
   */
  isCommunity: z.boolean().default(false),
  /**
   * This membership's profile-badge opt-out, TRUE by default. Meaningless
   * unless `isCommunity`; see `server_members.show_on_profile` in schema.sql.
   */
  showOnProfile: z.boolean().default(true),
});

export const channelSchema = z.object({
  id: z.string().uuid(),
  /**
   * Null for a conversation, which belongs to no server. Nullable rather than
   * omitted so every caller that reaches for it to route or to authorise is
   * forced to say what it does when there is no server — that is the point.
   */
  serverId: z.string().uuid().nullable(),
  /**
   * Defaulted so a response from an API that predates conversations still
   * parses as what it is: a server channel.
   */
  kind: channelKindSchema.default("server"),
  name: z.string(),
  type: channelTypeSchema,
  position: z.number(),
  isPrivate: z.boolean(),
  topic: z.string().nullable().default(null),
  imageUrl: z.string().nullable().default(null),
  /**
   * The category this channel sits under in the sidebar, or null for a
   * top-level channel. Always null for a category itself and for a
   * conversation — defaulted so a client built against this schema still
   * parses a response from an API that predates categories.
   */
  parentId: z.string().uuid().nullable().default(null),
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

export const reactionUserSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1),
});

export const messageReactionSchema = z.object({
  emoji: z.string(),
  count: z.number().int().positive(),
  me: z.boolean(),
  /** First reactors, capped by the server. `count` is the full total. */
  users: z.array(reactionUserSchema).default([]),
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

/** Who pinned a message. Not just an id: the pin panel names them without a
 * second round trip, and the account can outlive its own display name changing. */
export const messagePinnedBySchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
});

export type MessagePinnedBy = z.infer<typeof messagePinnedBySchema>;

/** How many messages one channel may have pinned at once. A soft UX ceiling —
 * past it the panel stops being a place you actually look — not a security
 * limit, so the server enforces it without a lock and a small race under
 * concurrent pins is an accepted, harmless overshoot. */
export const MAX_PINS_PER_CHANNEL = 50;

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
  /**
   * Defaulted rather than required, for the same reason `replyTo` is: a client
   * built against this schema still has to parse a response from an API that
   * predates attachments. Each `url` is a presigned GET minted while this row
   * was mapped, so the array is only as fresh as the response carrying it.
   */
  attachments: z.array(attachmentSchema).default([]),
  pinnedAt: z.string().nullable().default(null),
  pinnedBy: messagePinnedBySchema.nullable().default(null),
  /**
   * At most one — only the first link in a body ever unfurls. Absent rather
   * than a placeholder when nothing has resolved yet: a link just posted has
   * no embed for the moment between the send and the async fetch finishing,
   * and an empty array is what "nothing to show right now" already means
   * everywhere else in this shape.
   */
  embeds: z.array(embedSchema).default([]),
  /** True when `authorId` is a webhook's pseudo-identity rather than a real
   * account — the client shows a "Webhook" tag next to the name instead of
   * treating it as someone to @mention or open a DM with. */
  isWebhook: z.boolean().default(false),
  /** True when the body contained `@everyone` and the sender was allowed to
   * fire it. Defaulted so an older API still parses. */
  mentionEveryone: z.boolean().default(false),
  /** True when the body contained `@here` and the sender was allowed to fire
   * it. Same defaulting as `mentionEveryone`. */
  mentionHere: z.boolean().default(false),
  /** The rich-embed subset a webhook payload supplied — see the schema
   * comment on `messages.webhook_embeds`, an entirely different concept
   * from `embeds` above (that is this server's own automatic link unfurl). */
  webhookEmbeds: z.array(webhookEmbedSchema).default([]),
  // --- threads ---
  /** The thread anchored to this message, or null. Defaulted so a client
   * built against this schema still parses a response from an API that
   * predates threads. */
  thread: threadSummarySchema.nullable().default(null),
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

/**
 * Unread as a pair on its own, so a conversation summary counts with exactly
 * the same two numbers a channel does instead of redefining them.
 */
export const unreadCountsSchema = z.object({
  count: z.number().int().nonnegative(),
  mentions: z.number().int().nonnegative(),
});

export type UnreadCounts = z.infer<typeof unreadCountsSchema>;

export const channelUnreadSchema = unreadCountsSchema.extend({
  channelId: z.string().uuid(),
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

export const createChannelSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9-_]+$/i, "Use letters, numbers, - or _"),
    type: channelTypeSchema,
    isPrivate: z.boolean().optional().default(false),
  })
  // Permission-overwrite inheritance from a category to its children does
  // not exist yet (gap #22), so a "private category" would restrict nothing
  // and only imply a guarantee the product cannot keep. Refused here rather
  // than silently accepted and ignored.
  .refine((value) => !(value.type === "category" && value.isPrivate), {
    message: "Categories cannot be private yet",
    path: ["isPrivate"],
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

/**
 * Move a channel to a 0-based position among the siblings sharing
 * `parentId` — a category for `parentId`, or top-level for `null`. The
 * server renumbers the whole destination sibling group (and the group being
 * left, if any) as a contiguous sequence; `index` is clamped rather than
 * validated, so dropping past the end of a short list is "move to the end",
 * not an error.
 */
export const moveChannelSchema = z.object({
  parentId: z.string().uuid().nullable(),
  index: z.number().int().min(0),
});

export const createInviteSchema = z.object({
  maxUses: z.number().int().positive().nullable().optional(),
  expiresInHours: z.number().int().positive().nullable().optional(),
});

/**
 * Where a signup came from, as the landing page saw it.
 *
 * The five values are the ones a campaign link can carry (`utm_source`,
 * `utm_medium`, `utm_campaign`, `gclid`, and the site's own `ref`) plus the
 * path the person landed on. The client keeps them in `localStorage` through
 * the sign-up and sends them exactly once; the server writes them onto the
 * account only while the account has none (first touch) and never again. No
 * cookie, no third-party tag, no identifier of any kind rides in here, and
 * every field is bounded because a query string is user-writable: nothing in
 * this object is trusted beyond "a short label to group a count by".
 */
export const acquisitionSchema = z
  .object({
    source: z.string().trim().max(100),
    medium: z.string().trim().max(100),
    campaign: z.string().trim().max(100),
    gclid: z.string().trim().max(200),
    ref: z.string().trim().max(100),
    landing: z.string().trim().max(200),
  })
  .partial();

export type AcquisitionInput = z.infer<typeof acquisitionSchema>;

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
  dmPrivacy: dmPrivacySchema.optional(),
  /**
   * Claim or change the public handle. Optional like everything else here, and
   * absent means "leave it alone" — the settings form sends every field on
   * save, and a handle that arrives unchanged must not spend the rename
   * cooldown. `claimHandle` on the server owns that rule.
   *
   * Validated by `handleSchema`, which normalises first: a body carrying
   * `@Rafa` is a valid claim for `rafa` rather than a 400 about our character
   * set.
   */
  handle: handleSchema.optional(),
  /**
   * First-touch acquisition, sent once by the client right after sign-up.
   * Write-only: it never comes back in any user payload, and the server
   * ignores it for an account that already has one. See `acquisitionSchema`.
   */
  acquisition: acquisitionSchema.optional(),
});

/**
 * Deleting your own account (LGPD art. 18, VI).
 *
 * `confirm` carries the account's own handle, typed by hand. A bare `DELETE`
 * with an empty body is one mis-click, one stale tab replaying a request, or
 * one CSRF-shaped mistake away from destroying an account that cannot be
 * restored — and unlike every other destructive action in this product there is
 * no owner, moderator or backup on the other side to undo it. Requiring a
 * string only the account holder can read off their own profile makes the
 * request impossible to issue by accident.
 *
 * The expected value is `expectedDeleteConfirmation` below, so the client's
 * "does this match yet" check and the server's refusal can never drift.
 */
export const deleteAccountSchema = z.object({
  confirm: z.string().min(1).max(100),
});

export type DeleteAccountRequest = z.infer<typeof deleteAccountSchema>;

/**
 * What the user must type to confirm deletion: their full handle (`name#1234`),
 * or the literal phrase below for the vanishingly rare account that has no
 * handle yet. Compared case-insensitively after trimming — the requirement is
 * deliberate intent, not typing accuracy.
 */
export const DELETE_ACCOUNT_FALLBACK_PHRASE = "delete my account";

export function expectedDeleteConfirmation(
  tag: string | null | undefined,
): string {
  return tag ?? DELETE_ACCOUNT_FALLBACK_PHRASE;
}

export function deleteConfirmationMatches(
  typed: string,
  tag: string | null | undefined,
): boolean {
  return (
    typed.trim().toLowerCase() ===
    expectedDeleteConfirmation(tag).trim().toLowerCase()
  );
}

/**
 * User discovery — the only way to reach somebody you share no server with.
 *
 * Both shapes below answer with `publicUserSchema` and nothing wider. A search
 * result is the one place this product hands a user to a stranger, so the
 * narrow shape is not a nicety here, it is the feature's whole safety story.
 */

/** Below two characters a prefix search matches most of the directory. */
export const USER_SEARCH_MIN_LENGTH = 2;
export const USER_SEARCH_MAX_LENGTH = 32;

/**
 * Rows one search may return. Small on purpose: this endpoint is an enumeration
 * surface, and a page size is a cheaper brake than a rate limiter alone.
 */
export const USER_SEARCH_PAGE_SIZE = 20;

export const userSearchQuerySchema = z
  .string()
  .min(USER_SEARCH_MIN_LENGTH)
  .max(USER_SEARCH_MAX_LENGTH)
  .pipe(safeTextSchema);

export const userSearchResponseSchema = z.object({
  users: z.array(publicUserSchema),
});

export type UserSearchResponse = z.infer<typeof userSearchResponseSchema>;

/**
 * The `name#1234` handle, as typed into a lookup box.
 *
 * Parsed here beside `formatUserTag` rather than in a route, so the thing that
 * writes a tag and the thing that reads one back can never disagree about the
 * separator or about the width of the number.
 */
export const USER_TAG_PATTERN = /^([a-z0-9_]{2,32})#(\d{4})$/;

export const userTagSchema = z
  .string()
  .refine((value) => parseUserTag(value) !== null, "Use the form name#1234");

/**
 * Split a typed handle into the two columns it is stored as, or null when it is
 * not a handle at all.
 *
 * A leading `@` is dropped and case is folded because both are how people
 * actually type a handle back to you — and `username` is stored lowercase, so
 * an un-folded lookup silently finds nobody rather than failing loudly.
 */
export function parseUserTag(
  value: string,
): { username: string; discriminator: string } | null {
  const match = USER_TAG_PATTERN.exec(
    value.trim().replace(/^@/, "").toLowerCase(),
  );
  if (!match) {
    return null;
  }
  return { username: match[1]!, discriminator: match[2]! };
}

export const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});

export type IceServerConfig = z.infer<typeof iceServerSchema>;

export const updateMemberRoleSchema = z.object({
  role: z.enum(["admin", "member"]).optional(),
  nickname: nicknameSchema.nullable().optional(),
}).refine(
  (value) => value.role !== undefined || value.nickname !== undefined,
  "Provide a role or a nickname",
);

export const addChannelMemberSchema = z.object({
  userId: z.string().uuid(),
});

export const updateServerSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  ownerId: z.string().uuid().optional(),
  /** Explicit `null` clears retention back to "keep forever" — absent means
   * "not changing this," the same distinction `imageUrl` already draws on
   * `updateChannelSchema`. */
  messageRetentionDays: z
    .number()
    .int()
    .positive()
    .max(MAX_MESSAGE_RETENTION_DAYS)
    .nullable()
    .optional(),
  /** Explicit `null` turns SSO domain joining off; absent means "not changing".
   * Deliberately a loose string here and validated with `ssoEmailDomainSchema`
   * in the route: the refusal reasons ("that is a public provider") are meant
   * for the owner to read, and the generic ZodError handler flattens every
   * schema failure to "Invalid request". */
  ssoEmailDomain: z.string().max(253).nullable().optional(),
});

export const removeMemberSchema = z.object({
  /** Also add the member to the server ban list so invites stop working. */
  ban: z.boolean().optional().default(false),
});

/**
 * Mentions are written as `@username` (the unique slug half of `name#1234`).
 * `@everyone` and `@here` are literal tokens, not usernames — those two names
 * are reserved on the username schema for exactly this reason. Role names use
 * the same character class, and a username always wins when both match.
 *
 * Kept in shared so the server's notification counting and the client's
 * highlighting can never disagree about what counts as a mention.
 */
export const MENTION_PATTERN = /@([A-Za-z0-9_]{2,32})/g;

export interface ParsedMentions {
  usernames: string[];
  everyone: boolean;
  here: boolean;
  /** Lowercased tokens that are not everyone/here. Intersected with role names. */
  roleNames: string[];
}

export function extractMentions(body: string): ParsedMentions {
  const usernames = new Set<string>();
  const roleNames = new Set<string>();
  let everyone = false;
  let here = false;
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const name = match[1]?.toLowerCase();
    if (!name) {
      continue;
    }
    if (name === "everyone") {
      everyone = true;
      continue;
    }
    if (name === "here") {
      here = true;
      continue;
    }
    usernames.add(name);
    roleNames.add(name);
  }
  return {
    usernames: [...usernames],
    everyone,
    here,
    roleNames: [...roleNames],
  };
}

export function extractMentionUsernames(body: string): string[] {
  return extractMentions(body).usernames;
}

export const banMemberSchema = z.object({
  userId: z.string().uuid(),
  reason: z.string().max(500).nullable().optional(),
});

/**
 * Optional body on `POST /api/channels/:id/read`. Empty means "read up to now"
 * (opening the channel). `lastReadAt` is how Mark unread rewinds the cursor
 * to just before a chosen message.
 */
export const markChannelReadSchema = z.object({
  lastReadAt: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)), "Invalid timestamp")
    .optional(),
});

/**
 * `POST /api/channels/:id/read` answers with both cursors so the client can
 * draw a NEW divider at the previous one after opening has moved it forward.
 * Both fields default so an older API still parses as "no divider".
 */
export const markChannelReadResultSchema = z.object({
  ok: z.literal(true).optional(),
  previousLastReadAt: z.string().nullable().optional(),
  lastReadAt: z.string().optional(),
});

export type MarkChannelReadResult = z.infer<typeof markChannelReadResultSchema>;

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
