import { z } from "zod";
import {
  clampEveryonePermissions,
  isReservedMentionName,
  Permission,
  roleNameSchema,
  serializePermissions,
  STAFF_ROLE_NAMES,
} from "./permissions.js";
import {
  FORUM_MAX_TAGS,
  FORUM_TAG_EMOJI_MAX,
  FORUM_TAG_NAME_MAX,
} from "./forums.js";

/** SSRF boundary: only this pattern is interpolated into the Discord URL. */
export const DISCORD_TEMPLATE_CODE_RE = /^[A-Za-z0-9]{4,32}$/;

export const DISCORD_VIEW_CHANNEL = 1n << 10n;

/**
 * Discord's published flag numbers. Names match pqp; the shifts do not,
 * except the first six. Never copy a Discord bitfield into `roles.permissions`
 * without going through `mapDiscordPermissions`.
 */
export const DiscordPermission = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  STREAM: 1n << 9n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  MUTE_MEMBERS: 1n << 22n,
  MOVE_MEMBERS: 1n << 24n,
  CHANGE_NICKNAME: 1n << 26n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n,
  MODERATE_MEMBERS: 1n << 40n,
} as const;

const DISCORD_TO_PQP: ReadonlyArray<{ discord: bigint; pqp: bigint }> = [
  { discord: DiscordPermission.CREATE_INSTANT_INVITE, pqp: Permission.CREATE_INVITE },
  { discord: DiscordPermission.KICK_MEMBERS, pqp: Permission.KICK_MEMBERS },
  { discord: DiscordPermission.BAN_MEMBERS, pqp: Permission.BAN_MEMBERS },
  { discord: DiscordPermission.MANAGE_CHANNELS, pqp: Permission.MANAGE_CHANNELS },
  { discord: DiscordPermission.MANAGE_GUILD, pqp: Permission.MANAGE_SERVER },
  { discord: DiscordPermission.ADD_REACTIONS, pqp: Permission.ADD_REACTIONS },
  { discord: DiscordPermission.VIEW_CHANNEL, pqp: Permission.VIEW_CHANNEL },
  { discord: DiscordPermission.SEND_MESSAGES, pqp: Permission.SEND_MESSAGES },
  { discord: DiscordPermission.MANAGE_MESSAGES, pqp: Permission.MANAGE_MESSAGES },
  { discord: DiscordPermission.ATTACH_FILES, pqp: Permission.ATTACH_FILES },
  { discord: DiscordPermission.READ_MESSAGE_HISTORY, pqp: Permission.READ_MESSAGE_HISTORY },
  { discord: DiscordPermission.MENTION_EVERYONE, pqp: Permission.MENTION_EVERYONE },
  { discord: DiscordPermission.STREAM, pqp: Permission.STREAM },
  { discord: DiscordPermission.CONNECT, pqp: Permission.CONNECT },
  { discord: DiscordPermission.SPEAK, pqp: Permission.SPEAK },
  { discord: DiscordPermission.MUTE_MEMBERS, pqp: Permission.MUTE_MEMBERS },
  { discord: DiscordPermission.MOVE_MEMBERS, pqp: Permission.MOVE_MEMBERS },
  { discord: DiscordPermission.CHANGE_NICKNAME, pqp: Permission.CHANGE_NICKNAME },
  { discord: DiscordPermission.MANAGE_NICKNAMES, pqp: Permission.MANAGE_NICKNAMES },
  { discord: DiscordPermission.MANAGE_ROLES, pqp: Permission.MANAGE_ROLES },
  { discord: DiscordPermission.MODERATE_MEMBERS, pqp: Permission.MODERATE_MEMBERS },
];

const OVERWRITE_PQP_BITS =
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.CONNECT |
  Permission.SPEAK |
  Permission.STREAM |
  Permission.MUTE_MEMBERS |
  Permission.MOVE_MEMBERS;

/** Manage bits we will not put on imported `@everyone`, even if Discord had them. */
const EVERYONE_IMPORT_DENIED =
  Permission.MANAGE_CHANNELS |
  Permission.MANAGE_SERVER |
  Permission.MANAGE_ROLES |
  Permission.MANAGE_MESSAGES |
  Permission.MUTE_MEMBERS |
  Permission.MANAGE_NICKNAMES;

export function mapDiscordPermissions(discordBits: bigint): bigint {
  let mapped = 0n;
  for (const entry of DISCORD_TO_PQP) {
    if ((discordBits & entry.discord) === entry.discord) {
      mapped |= entry.pqp;
    }
  }
  return mapped;
}

/**
 * Bits pqp gives `@everyone` that Discord has no bit for, so no template can
 * carry them: an imported `@everyone` gets them as a new server's would
 * (`PERMISSION_DEFAULT_EVERYONE`). Without this a server copied from a
 * template is the one place members cannot post a story.
 */
const EVERYONE_IMPORT_PQP_DEFAULTS = Permission.POST_STORIES;

export function mapImportedEveryonePermissions(discordBits: bigint): bigint {
  return (
    (clampEveryonePermissions(mapDiscordPermissions(discordBits)) &
      ~EVERYONE_IMPORT_DENIED) |
    EVERYONE_IMPORT_PQP_DEFAULTS
  );
}

export function mapImportedRolePermissions(discordBits: bigint): bigint {
  return mapDiscordPermissions(discordBits) & ~Permission.ADMINISTRATOR;
}

export function mapImportedOverwriteBits(discordBits: bigint): bigint {
  return mapDiscordPermissions(discordBits) & OVERWRITE_PQP_BITS;
}

const DISCORD_GUILD_ID_RE = /^\d{17,22}$/;
const DISCORD_ICON_HASH_RE = /^(a_)?[a-fA-F0-9]{32}$/;

export function discordGuildIconUrl(
  guildId: string,
  hash: string,
  size: 64 | 128 | 256 | 512 = 256,
): string | null {
  if (!DISCORD_GUILD_ID_RE.test(guildId) || !DISCORD_ICON_HASH_RE.test(hash)) {
    return null;
  }
  return `https://cdn.discordapp.com/icons/${guildId}/${hash}.png?size=${size}`;
}

export const MAX_IMPORT_CHANNELS = 200;
export const MAX_IMPORT_CATEGORIES = 30;
export const MAX_IMPORT_ROLES = 100;
export const IMPORT_CHANNEL_NAME_MAX = 100;
export const IMPORT_TOPIC_MAX = 200;

const DISCORD_ROLE_OVERWRITE = 0;
const DISCORD_EVERYONE_PLACEHOLDER_ID = 0;

export const discordImportSourceSchema = z.object({
  source: z.string().min(1).max(200),
});

export type DiscordImportSource = z.infer<typeof discordImportSourceSchema>;

export const NOT_IN_TEMPLATE_REASONS = [
  "members",
  "messages",
  "attachments",
  "customEmoji",
  "webhooks",
  "bans",
  "discordInvites",
] as const;

export type NotInTemplateReason = (typeof NOT_IN_TEMPLATE_REASONS)[number];

export const MAPPED_AWAY_REASONS = [
  "permissionBits",
  "overwrites",
  "nsfw",
  "slowmode",
  "bitrate",
  "forumTags",
  "forumTagsTrimmed",
  "forumSettings",
  "threads",
  "directory",
  "serverIcon",
  "unsanitisableRole",
  "roleCap",
  "flattenAnnouncement",
  "flattenForum",
  "flattenMedia",
  "flattenStage",
  "topicTruncated",
] as const;

export type MappedAwayReason = (typeof MAPPED_AWAY_REASONS)[number];

export type FlattenedChannelKind =
  | "announcement"
  | "forum"
  | "media"
  | "stage";

export type MappedImportChannelType = "text" | "voice" | "category" | "forum";

/** One imported forum tag, already inside the limits `forum_tags` enforces. */
export interface MappedImportForumTag {
  name: string;
  /** One unicode emoji, or null (a custom Discord emoji cannot come along). */
  emoji: string | null;
  moderated: boolean;
}

/** Options for `mapGuildTemplate`. Everything defaults to today's behaviour. */
export interface MapGuildTemplateOptions {
  /**
   * Keep Discord forums (type 15) as forums, with their tags. The server
   * passes its global `forum_channels` flag; off flattens a forum to a text
   * channel exactly as before.
   */
  forumChannels?: boolean;
}

export interface MappedAwayItem {
  reason: MappedAwayReason;
  name?: string;
}

export interface MappedImportChannel {
  templateId: number;
  parentTemplateId: number | null;
  type: MappedImportChannelType;
  name: string;
  topic: string | null;
  topicTruncated: boolean;
  position: number;
  isPrivate: boolean;
  flattenedFrom?: FlattenedChannelKind;
  /** Only on a `forum`: its tags, in Discord's order, at most 20. */
  tags?: MappedImportForumTag[];
}

export interface MappedImportRole {
  templateId: number;
  name: string;
  originalName: string;
  color: string | null;
  hoist: boolean;
  mentionable: boolean;
  /** pqp bitfield, decimal string. Administrator is never set. */
  permissions: string;
}

export interface MappedImportOverwrite {
  channelTemplateId: number;
  /** Discord placeholder id. `0` is `@everyone`. */
  roleTemplateId: number;
  allow: string;
  deny: string;
}

export interface DiscordImportPlan {
  serverName: string;
  templateUpdatedAt: string | null;
  isDirty: boolean;
  iconUrl: string | null;
  channels: MappedImportChannel[];
  roles: MappedImportRole[];
  /** Mapped pqp bits for `@everyone`, or null to keep the seeded default. */
  everyonePermissions: string | null;
  overwrites: MappedImportOverwrite[];
  privateChannelNames: string[];
  notInTemplate: NotInTemplateReason[];
  mappedAway: MappedAwayItem[];
}

export class DiscordImportCapError extends Error {
  readonly code = "overCap" as const;
  constructor(readonly kind: "channels" | "categories") {
    super(
      kind === "categories"
        ? "This template has too many categories to copy."
        : "This template has too many channels to copy.",
    );
    this.name = "DiscordImportCapError";
  }
}

export class DiscordImportParseError extends Error {
  readonly code = "invalidTemplate" as const;
  constructor(message = "That does not look like a Discord template.") {
    super(message);
    this.name = "DiscordImportParseError";
  }
}

const idSchema = z.union([z.number(), z.string()]);

const overwriteSchema = z
  .object({
    id: idSchema,
    type: z.union([z.number(), z.string()]).optional(),
    allow: z.union([z.string(), z.number()]).optional(),
    deny: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const templateChannelSchema = z
  .object({
    id: idSchema,
    type: z.number(),
    name: z.string(),
    position: z.number().optional(),
    topic: z.string().nullable().optional(),
    parent_id: idSchema.nullable().optional(),
    nsfw: z.boolean().optional(),
    rate_limit_per_user: z.number().optional(),
    bitrate: z.number().optional(),
    permission_overwrites: z.array(overwriteSchema).optional(),
    available_tags: z.array(z.unknown()).optional(),
    // Forum options. Read leniently below, so an odd value in one of them
    // never turns a whole template into "that is not a template".
    default_reaction_emoji: z.unknown().optional(),
    default_sort_order: z.unknown().optional(),
    default_forum_layout: z.unknown().optional(),
    default_thread_rate_limit_per_user: z.unknown().optional(),
    flags: z.unknown().optional(),
  })
  .passthrough();

const templateRoleSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    color: z.number().optional(),
    hoist: z.boolean().optional(),
    mentionable: z.boolean().optional(),
    permissions: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const guildTemplateSchema = z
  .object({
    updated_at: z.string().optional(),
    is_dirty: z.boolean().nullable().optional(),
    source_guild_id: idSchema.optional(),
    serialized_source_guild: z
      .object({
        id: idSchema.optional(),
        name: z.string().optional(),
        icon_hash: z.string().nullable().optional(),
        roles: z.array(templateRoleSchema).optional(),
        channels: z.array(templateChannelSchema).optional(),
      })
      .passthrough(),
  })
  .passthrough();

function toIntId(value: string | number | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBitfield(value: string | number | undefined): bigint {
  if (value == null) {
    return 0n;
  }
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function everyoneDeniedView(
  overwrites: z.infer<typeof overwriteSchema>[] | undefined,
): boolean {
  if (!overwrites) {
    return false;
  }
  const row = overwrites.find((entry) => {
    const id = toIntId(entry.id);
    const type = toIntId(entry.type ?? DISCORD_ROLE_OVERWRITE);
    return id === DISCORD_EVERYONE_PLACEHOLDER_ID && type === DISCORD_ROLE_OVERWRITE;
  });
  if (!row) {
    return false;
  }
  return (parseBitfield(row.deny) & DISCORD_VIEW_CHANNEL) === DISCORD_VIEW_CHANNEL;
}

function mapChannelType(
  type: number,
  keepForums: boolean,
): {
  type: MappedImportChannelType;
  flattenedFrom?: FlattenedChannelKind;
} | null {
  switch (type) {
    case 4:
      return { type: "category" };
    case 0:
      return { type: "text" };
    case 5:
      return { type: "text", flattenedFrom: "announcement" };
    case 15:
      return keepForums
        ? { type: "forum" }
        : { type: "text", flattenedFrom: "forum" };
    case 16:
      return { type: "text", flattenedFrom: "media" };
    case 2:
      return { type: "voice" };
    case 13:
      return { type: "voice", flattenedFrom: "stage" };
    default:
      return null;
  }
}

const DISCORD_REQUIRE_TAG_FLAG = 1 << 4;
const DISCORD_SORT_BY_CREATION = 1;
const DISCORD_LAYOUT_GALLERY = 2;
// eslint-disable-next-line no-control-regex
const IMPORT_CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const IMPORT_PLAIN_WORD = /^[A-Za-z0-9_ ]+$/;

function codePoints(value: string): string[] {
  return Array.from(value);
}

/**
 * A Discord tag name as a pqp one: control characters and runs of whitespace
 * folded to one space, trimmed, cut to the name limit by code point (never
 * through a surrogate pair). `null` when nothing is left. `clamped` says the
 * name had to be shortened.
 */
function importTagName(raw: string): { name: string; clamped: boolean } | null {
  const folded = raw
    .replace(new RegExp(IMPORT_CONTROL_CHARS.source, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!folded) {
    return null;
  }
  const points = codePoints(folded);
  if (points.length <= FORUM_TAG_NAME_MAX) {
    return { name: folded, clamped: false };
  }
  const cut = points.slice(0, FORUM_TAG_NAME_MAX).join("").trim();
  return cut ? { name: cut, clamped: true } : null;
}

interface ImportedTags {
  tags: MappedImportForumTag[];
  /** True when a tag, a name or a picture did not survive the trip. */
  lossy: boolean;
}

/**
 * Discord `available_tags` as pqp tags. Lenient on purpose: Discord's shape
 * is `{ id, name, moderated, emoji_id, emoji_name }`, but a template is
 * outside data, so every field is checked and a bad entry is skipped rather
 * than failing the import. Names are cut to 20, duplicates (by lower-case
 * name, which is the unique index) are dropped, the list stops at 20, and a
 * custom emoji keeps its tag and loses its picture.
 */
function parseImportedTags(available: unknown[] | undefined): ImportedTags {
  const tags: MappedImportForumTag[] = [];
  let lossy = false;
  const seen = new Set<string>();
  for (const entry of available ?? []) {
    if (typeof entry !== "object" || entry === null) {
      lossy = true;
      continue;
    }
    const row = entry as Record<string, unknown>;
    const named = typeof row.name === "string" ? importTagName(row.name) : null;
    if (!named) {
      lossy = true;
      continue;
    }
    const key = named.name.toLowerCase();
    if (seen.has(key) || tags.length >= FORUM_MAX_TAGS) {
      lossy = true;
      continue;
    }
    seen.add(key);
    if (named.clamped) {
      lossy = true;
    }
    let emoji: string | null = null;
    if (row.emoji_id != null) {
      // A custom emoji: `emoji_name` is its label, not a glyph.
      lossy = true;
    } else if (typeof row.emoji_name === "string" && row.emoji_name !== "") {
      const glyph = row.emoji_name.trim();
      if (
        glyph !== "" &&
        codePoints(glyph).length <= FORUM_TAG_EMOJI_MAX &&
        !IMPORT_PLAIN_WORD.test(glyph) &&
        !IMPORT_CONTROL_CHARS.test(glyph)
      ) {
        emoji = glyph;
      } else {
        lossy = true;
      }
    }
    tags.push({ name: named.name, emoji, moderated: row.moderated === true });
  }
  return { tags, lossy };
}

/**
 * True when the forum carries an option the import does not copy: a default
 * reaction, sort by creation date, gallery layout, a post slowmode, or the
 * require-a-tag switch. A template import writes tags and nothing else.
 */
function forumHasLostSettings(
  channel: z.infer<typeof templateChannelSchema>,
): boolean {
  if (channel.default_reaction_emoji != null) {
    return true;
  }
  if (channel.default_sort_order === DISCORD_SORT_BY_CREATION) {
    return true;
  }
  if (channel.default_forum_layout === DISCORD_LAYOUT_GALLERY) {
    return true;
  }
  const slow = channel.default_thread_rate_limit_per_user;
  if (typeof slow === "number" && slow > 0) {
    return true;
  }
  const flags = channel.flags;
  return typeof flags === "number" && (flags & DISCORD_REQUIRE_TAG_FLAG) !== 0;
}

function flattenReason(
  kind: FlattenedChannelKind,
): MappedAwayReason {
  switch (kind) {
    case "announcement":
      return "flattenAnnouncement";
    case "forum":
      return "flattenForum";
    case "media":
      return "flattenMedia";
    case "stage":
      return "flattenStage";
  }
}

function clampName(name: string): string {
  const trimmed = name.trim() || "channel";
  return trimmed.slice(0, IMPORT_CHANNEL_NAME_MAX);
}

function clampTopic(
  topic: string | null | undefined,
): { topic: string | null; truncated: boolean } {
  if (!topic) {
    return { topic: null, truncated: false };
  }
  if (topic.length <= IMPORT_TOPIC_MAX) {
    return { topic, truncated: false };
  }
  return { topic: topic.slice(0, IMPORT_TOPIC_MAX), truncated: true };
}

function discordColorToHex(color: number | undefined): string | null {
  if (!color) {
    return null;
  }
  return `#${color.toString(16).padStart(6, "0").toUpperCase()}`;
}

function foldLatin(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "");
}

function isSeededRoleName(name: string): boolean {
  if (isReservedMentionName(name)) {
    return true;
  }
  const lower = name.toLowerCase();
  return Object.values(STAFF_ROLE_NAMES).some(
    (seeded) => seeded.toLowerCase() === lower,
  );
}

export function sanitiseImportedRoleName(
  raw: string,
  usedLower: Set<string>,
): string | null {
  let slug = foldLatin(raw)
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  if (slug.length > 32) {
    slug = slug.slice(0, 32).replace(/_+$/g, "");
  }
  if (slug.length < 2) {
    return null;
  }
  if (isSeededRoleName(slug)) {
    return null;
  }
  let candidate = slug;
  let n = 2;
  while (usedLower.has(candidate.toLowerCase())) {
    const suffix = `_${n}`;
    const maxBase = 32 - suffix.length;
    if (maxBase < 2) {
      return null;
    }
    candidate = `${slug.slice(0, maxBase)}${suffix}`;
    n += 1;
    if (n > 99) {
      return null;
    }
  }
  if (!roleNameSchema.safeParse(candidate).success) {
    return null;
  }
  usedLower.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Parse a pasted link as a URL, adding `https://` when it has no scheme.
 * People type `discord.new/CODE` (the placeholder shows exactly that), and
 * `new URL()` throws on a string with no scheme.
 */
function parsePastedUrl(trimmed: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

/**
 * Pull a template code out of a paste. Accepts a bare code, discord.new/CODE,
 * or discord.com/template/CODE, with or without `https://`. Anything else is
 * null — the caller must not fetch the original string as a URL.
 */
export function parseDiscordTemplateCode(source: string): string | null {
  const trimmed = source.trim();
  if (DISCORD_TEMPLATE_CODE_RE.test(trimmed)) {
    return trimmed;
  }
  const url = parsePastedUrl(trimmed);
  if (!url) {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "discord.new") {
    const code = url.pathname.replace(/^\//, "").split("/")[0] ?? "";
    return DISCORD_TEMPLATE_CODE_RE.test(code) ? code : null;
  }
  if (host === "discord.com" || host === "discordapp.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "template" && parts[1] && DISCORD_TEMPLATE_CODE_RE.test(parts[1])) {
      return parts[1];
    }
  }
  return null;
}

/**
 * True when a paste is a Discord server invite (`discord.gg/x`,
 * `discord.com/invite/x`), the link people have at hand and the most common
 * wrong paste. An invite cannot be read as a template, so the import says so
 * instead of answering "not found".
 */
export function isDiscordInviteLink(source: string): boolean {
  const url = parsePastedUrl(source.trim());
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return false;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "discord.gg") {
    return parts.length > 0;
  }
  return (
    (host === "discord.com" || host === "discordapp.com") &&
    parts[0] === "invite" &&
    parts.length > 1
  );
}

/**
 * Why an import request failed, sent as `code` beside the English `error` so
 * the client can say it in the reader's language.
 */
export type DiscordImportErrorCode =
  | "notATemplate"
  | "inviteLink"
  | "notFound"
  | "tooMany"
  | "tooLarge"
  | "rateLimited"
  | "unavailable";

export function discordTemplateUrl(code: string): string {
  if (!DISCORD_TEMPLATE_CODE_RE.test(code)) {
    throw new Error("Refusing to build a Discord URL from an invalid code");
  }
  return `https://discord.com/api/v10/guilds/templates/${code}`;
}

function sortByDiscordPosition<T extends { position: number; templateId: number }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    if (a.position !== b.position) {
      return a.position - b.position;
    }
    return a.templateId - b.templateId;
  });
}

function renumberGroup<T extends { position: number; templateId: number }>(
  rows: T[],
): T[] {
  return sortByDiscordPosition(rows).map((row, index) => ({
    ...row,
    position: index,
  }));
}

function collectImportedOverwrites(
  channels: MappedImportChannel[],
  byId: Map<number, z.infer<typeof templateChannelSchema>>,
  importedRoleIds: Set<number>,
): MappedImportOverwrite[] {
  const imported = new Set(importedRoleIds);
  imported.add(DISCORD_EVERYONE_PLACEHOLDER_ID);
  const result: MappedImportOverwrite[] = [];

  for (const channel of channels) {
    if (channel.type === "category") {
      continue;
    }
    const own = byId.get(channel.templateId);
    const parent =
      channel.parentTemplateId != null
        ? byId.get(channel.parentTemplateId)
        : undefined;
    const merged = new Map<number, { allow: bigint; deny: bigint }>();
    for (const row of [
      ...(parent?.permission_overwrites ?? []),
      ...(own?.permission_overwrites ?? []),
    ]) {
      const type = toIntId(row.type ?? DISCORD_ROLE_OVERWRITE);
      if (type !== DISCORD_ROLE_OVERWRITE) {
        continue;
      }
      const roleTemplateId = toIntId(row.id);
      if (roleTemplateId == null || !imported.has(roleTemplateId)) {
        continue;
      }
      const allow = mapImportedOverwriteBits(parseBitfield(row.allow));
      const deny = mapImportedOverwriteBits(parseBitfield(row.deny));
      merged.set(roleTemplateId, { allow, deny });
    }
    for (const [roleTemplateId, bits] of merged) {
      if (bits.allow === 0n && bits.deny === 0n) {
        continue;
      }
      result.push({
        channelTemplateId: channel.templateId,
        roleTemplateId,
        allow: serializePermissions(bits.allow),
        deny: serializePermissions(bits.deny),
      });
    }
  }
  return result;
}

export function mapGuildTemplate(
  raw: unknown,
  options: MapGuildTemplateOptions = {},
): DiscordImportPlan {
  const keepForums = options.forumChannels === true;
  const parsed = guildTemplateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DiscordImportParseError();
  }

  const guild = parsed.data.serialized_source_guild;
  const mappedAway: MappedAwayItem[] = [];
  let droppedBitrate = false;

  const sourceChannels = guild.channels ?? [];
  const byId = new Map<number, z.infer<typeof templateChannelSchema>>();
  for (const channel of sourceChannels) {
    const id = toIntId(channel.id);
    if (id != null) {
      byId.set(id, channel);
    }
  }

  const draft: MappedImportChannel[] = [];

  for (const channel of sourceChannels) {
    const templateId = toIntId(channel.id);
    if (templateId == null) {
      continue;
    }
    const mapped = mapChannelType(channel.type, keepForums);
    if (!mapped) {
      if (channel.type === 10 || channel.type === 11 || channel.type === 12) {
        mappedAway.push({ reason: "threads", name: channel.name });
      } else if (channel.type === 14) {
        mappedAway.push({ reason: "directory", name: channel.name });
      }
      continue;
    }

    const parentTemplateId = toIntId(channel.parent_id ?? null);
    const { topic, truncated } = clampTopic(channel.topic);
    if (truncated) {
      mappedAway.push({ reason: "topicTruncated", name: channel.name });
    }
    if (channel.nsfw) {
      mappedAway.push({ reason: "nsfw", name: channel.name });
    }
    if ((channel.rate_limit_per_user ?? 0) > 0) {
      mappedAway.push({ reason: "slowmode", name: channel.name });
    }
    if (mapped.type === "voice" && channel.bitrate && !droppedBitrate) {
      mappedAway.push({ reason: "bitrate" });
      droppedBitrate = true;
    }
    let tags: MappedImportForumTag[] | undefined;
    if (mapped.type === "forum") {
      const imported = parseImportedTags(channel.available_tags);
      tags = imported.tags;
      if (imported.lossy) {
        mappedAway.push({ reason: "forumTagsTrimmed", name: channel.name });
      }
      if (forumHasLostSettings(channel)) {
        mappedAway.push({ reason: "forumSettings", name: channel.name });
      }
    } else if ((channel.available_tags?.length ?? 0) > 0) {
      mappedAway.push({ reason: "forumTags", name: channel.name });
    }
    if (mapped.flattenedFrom) {
      mappedAway.push({
        reason: flattenReason(mapped.flattenedFrom),
        name: channel.name,
      });
    }

    draft.push({
      templateId,
      parentTemplateId,
      type: mapped.type,
      name: clampName(channel.name),
      topic,
      topicTruncated: truncated,
      position: channel.position ?? 0,
      isPrivate: false,
      flattenedFrom: mapped.flattenedFrom,
      ...(tags ? { tags } : {}),
    });
  }

  const categoryIds = new Set(
    draft.filter((row) => row.type === "category").map((row) => row.templateId),
  );

  const withPrivacy = draft.map((row) => {
    if (row.type === "category") {
      return { ...row, parentTemplateId: null, isPrivate: false };
    }
    const own = byId.get(row.templateId);
    const parent =
      row.parentTemplateId != null && categoryIds.has(row.parentTemplateId)
        ? byId.get(row.parentTemplateId)
        : undefined;
    const isPrivate =
      everyoneDeniedView(own?.permission_overwrites) ||
      everyoneDeniedView(parent?.permission_overwrites);
    const parentTemplateId =
      row.parentTemplateId != null && categoryIds.has(row.parentTemplateId)
        ? row.parentTemplateId
        : null;
    return { ...row, parentTemplateId, isPrivate };
  });

  const categories = withPrivacy.filter((row) => row.type === "category");
  if (categories.length > MAX_IMPORT_CATEGORIES) {
    throw new DiscordImportCapError("categories");
  }
  if (withPrivacy.length > MAX_IMPORT_CHANNELS) {
    throw new DiscordImportCapError("channels");
  }

  const topText = withPrivacy.filter(
    (row) =>
      (row.type === "text" || row.type === "forum") &&
      row.parentTemplateId == null,
  );
  const topVoice = withPrivacy.filter(
    (row) => row.type === "voice" && row.parentTemplateId == null,
  );
  const nested = withPrivacy.filter((row) => row.parentTemplateId != null);

  const nestedByParent = new Map<number, typeof nested>();
  for (const row of nested) {
    const list = nestedByParent.get(row.parentTemplateId!) ?? [];
    list.push(row);
    nestedByParent.set(row.parentTemplateId!, list);
  }

  // Loose channels are one sequence in pqp (any type, one order per parent),
  // in the order Discord draws them: text and forums first, then voice, each
  // by Discord's own position.
  const channels: MappedImportChannel[] = [
    ...renumberGroup(categories),
    ...[...sortByDiscordPosition(topText), ...sortByDiscordPosition(topVoice)].map(
      (row, index) => ({ ...row, position: index }),
    ),
  ];
  for (const group of nestedByParent.values()) {
    channels.push(...renumberGroup(group));
  }

  const usedRoleNames = new Set<string>();
  const roles: MappedImportRole[] = [];
  let everyonePermissions: string | null = null;
  const importedRoleIds = new Set<number>();
  for (const role of guild.roles ?? []) {
    const id = toIntId(role.id);
    if (id === DISCORD_EVERYONE_PLACEHOLDER_ID) {
      everyonePermissions = serializePermissions(
        mapImportedEveryonePermissions(parseBitfield(role.permissions)),
      );
      continue;
    }
    if (id == null) {
      continue;
    }
    if (roles.length >= MAX_IMPORT_ROLES) {
      mappedAway.push({ reason: "roleCap", name: role.name });
      continue;
    }
    const name = sanitiseImportedRoleName(role.name, usedRoleNames);
    if (!name) {
      mappedAway.push({ reason: "unsanitisableRole", name: role.name });
      continue;
    }
    importedRoleIds.add(id);
    roles.push({
      templateId: id,
      name,
      originalName: role.name,
      color: discordColorToHex(role.color),
      hoist: role.hoist ?? false,
      mentionable: role.mentionable ?? false,
      permissions: serializePermissions(
        mapImportedRolePermissions(parseBitfield(role.permissions)),
      ),
    });
  }

  const overwrites = collectImportedOverwrites(
    channels,
    byId,
    importedRoleIds,
  );

  const guildIdRaw =
    parsed.data.source_guild_id ?? guild.id ?? null;
  const guildId =
    guildIdRaw == null ? "" : String(guildIdRaw);
  const iconHash = guild.icon_hash?.trim() || "";
  let iconUrl: string | null = null;
  if (iconHash) {
    iconUrl = discordGuildIconUrl(guildId, iconHash);
    if (!iconUrl) {
      mappedAway.push({ reason: "serverIcon" });
    }
  }

  const serverName = (guild.name ?? "Imported server").trim().slice(0, 100) ||
    "Imported server";

  const uniqueAway: MappedAwayItem[] = [];
  const seen = new Set<string>();
  for (const item of mappedAway) {
    const key = `${item.reason}:${item.name ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueAway.push(item);
  }

  return {
    serverName,
    templateUpdatedAt: parsed.data.updated_at ?? null,
    isDirty: parsed.data.is_dirty === true,
    iconUrl,
    channels,
    roles,
    everyonePermissions,
    overwrites,
    privateChannelNames: channels
      .filter((channel) => channel.isPrivate)
      .map((channel) => channel.name),
    notInTemplate: [...NOT_IN_TEMPLATE_REASONS],
    mappedAway: uniqueAway,
  };
}
