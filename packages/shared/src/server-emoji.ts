import { z } from "zod";
import { AVATAR_MIME_ALLOWLIST } from "./avatars.js";

/**
 * Custom server emoji: a small picture a server's staff upload under a name,
 * which members then use as `:name:` in their own messages.
 *
 * Storage rides the server-image machinery (`server-images.ts`): same bucket,
 * same presign-then-HEAD claim, same Manage Server gate. The one new thing is
 * a row per emoji (`server_emoji`), because a server has many of them and a
 * message must keep pointing at the same one across a rename.
 *
 * WIRE FORMAT. A message body stores `<:name:id>`, never a bare `:name:`. The
 * composer turns what a person typed or picked into the token at send time,
 * the way it already turns `:fire:` into 🔥. The id is what resolves; the name
 * is only the fallback text a reader sees when the emoji is gone or belongs to
 * another server.
 */

/** Static only. No GIF, no SVG, for the reasons `AVATAR_MIME_ALLOWLIST` gives. */
export const SERVER_EMOJI_MIME_ALLOWLIST = AVATAR_MIME_ALLOWLIST;

export const serverEmojiContentTypeSchema = z.enum(SERVER_EMOJI_MIME_ALLOWLIST);
export type ServerEmojiContentType = z.infer<typeof serverEmojiContentTypeSchema>;

/**
 * The byte ceiling on one emoji. The client re-encodes to a 128×128 PNG, which
 * lands far below this, so the cap only bounds a client that ignores that.
 */
export const MAX_SERVER_EMOJI_BYTES = 256 * 1024;

/** The square an emoji is scaled to before upload. */
export const SERVER_EMOJI_SIZE = 128;

/**
 * How many emoji one server may hold.
 *
 * A default rather than a constant the routes read directly: the server asks
 * `serverEmojiLimit(serverId)` and reports the answer on the list response,
 * so a per-server limit can replace this without touching a client.
 */
export const SERVER_EMOJI_DEFAULT_LIMIT = 50;

export const SERVER_EMOJI_NAME_MIN = 2;
export const SERVER_EMOJI_NAME_MAX = 32;

/** Lowercase letters, digits and underscore. Mirrored by a CHECK in schema.sql. */
export const SERVER_EMOJI_NAME_PATTERN = /^[a-z0-9_]{2,32}$/;

export const serverEmojiNameSchema = z
  .string()
  .regex(SERVER_EMOJI_NAME_PATTERN, "Use 2 to 32 lowercase letters, digits or _");

/**
 * Turn what somebody typed, or a file name, into a valid name when that is
 * possible. Lowercases, turns spaces, dots and hyphens into `_`, drops anything
 * else and trims to the maximum. May still return something too short; the
 * caller checks with `isValidServerEmojiName`.
 */
export function normalizeServerEmojiName(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, "")
    .replace(/[\s.\-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, SERVER_EMOJI_NAME_MAX);
}

export function isValidServerEmojiName(name: string): boolean {
  return SERVER_EMOJI_NAME_PATTERN.test(name);
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** `<:name:id>` anywhere in a body. Global: use with `matchAll` or `replace`. */
export const CUSTOM_EMOJI_TOKEN_PATTERN = new RegExp(
  `<:([a-z0-9_]{2,32}):(${UUID})>`,
  "g",
);

export function customEmojiToken(name: string, id: string): string {
  return `<:${name}:${id}>`;
}

/** Where an emoji's bytes are served from, relative to the API origin. */
export function serverEmojiPath(emojiId: string, version: string): string {
  return `/api/emoji/${emojiId}?v=${version}`;
}

export const serverEmojiSchema = z.object({
  id: z.string().uuid(),
  serverId: z.string().uuid(),
  name: serverEmojiNameSchema,
  /** Root-relative; each client prefixes its own API base. */
  url: z.string(),
  createdBy: z.string().uuid().nullable(),
  /** ISO 8601. */
  createdAt: z.string(),
});
export type ServerEmoji = z.infer<typeof serverEmojiSchema>;

/** `GET /api/servers/:id/emoji`. */
export const serverEmojiListSchema = z.object({
  emoji: z.array(serverEmojiSchema),
  /** How many this server may hold. Read it, never assume the default. */
  limit: z.number().int().nonnegative(),
  /** False on a deployment with no `S3_*`: listing works, uploading does not. */
  uploadEnabled: z.boolean(),
  maxBytes: z.number().int().positive(),
  size: z.number().int().positive(),
});
export type ServerEmojiList = z.infer<typeof serverEmojiListSchema>;

/** `POST /api/servers/:id/emoji/uploads`: ask for somewhere to put the bytes. */
export const createServerEmojiUploadSchema = z.object({
  name: serverEmojiNameSchema,
  contentType: serverEmojiContentTypeSchema,
  byteSize: z.number().int().positive(),
});
export type CreateServerEmojiUploadRequest = z.infer<
  typeof createServerEmojiUploadSchema
>;

export const createServerEmojiUploadResponseSchema = z.object({
  key: z.string(),
  uploadUrl: z.string(),
  /** ISO 8601. */
  expiresAt: z.string(),
});
export type CreateServerEmojiUploadResponse = z.infer<
  typeof createServerEmojiUploadResponseSchema
>;

/** `POST /api/servers/:id/emoji`: the bytes are up, make them an emoji. */
export const createServerEmojiSchema = z.object({
  key: z.string().min(1).max(200),
  name: serverEmojiNameSchema,
});
export type CreateServerEmojiRequest = z.infer<typeof createServerEmojiSchema>;

/** `PATCH /api/servers/:id/emoji/:emojiId`. */
export const updateServerEmojiSchema = z.object({
  name: serverEmojiNameSchema,
});
export type UpdateServerEmojiRequest = z.infer<typeof updateServerEmojiSchema>;

/**
 * The `code` on a refused emoji write, so a client can say it in the reader's
 * language instead of showing the English sentence.
 */
export const SERVER_EMOJI_ERROR_CODES = [
  "emoji_name_taken",
  "emoji_limit_reached",
  "emoji_too_large",
  "emoji_upload_unverified",
  "emoji_storage_off",
] as const;
export type ServerEmojiErrorCode = (typeof SERVER_EMOJI_ERROR_CODES)[number];
