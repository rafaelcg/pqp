import { z } from "zod";
import { publicUserSchema, safeTextSchema } from "./api.js";
import {
  ATTACHMENT_FILENAME_MAX_LENGTH,
  attachmentFilenameSchema,
} from "./attachments.js";

/**
 * Community Home (Baú) — durable media feed per server.
 *
 * Not a channel type. Posts live in Postgres; media bytes go through the same
 * S3/R2 mint → PUT → claim dance as attachments. Visibility is enforced on the
 * API: members-only body/media are omitted unless the viewer has MANAGE_SERVER
 * or the VIP cargo. Drafts and scheduled posts are never returned to members.
 *
 * `VITE_COMMUNITY_HOME_ENABLED` is a separate client latch from
 * `COMMUNITIES_ENABLED` (legal Art. 19). This module is the wire contract only.
 */

/**
 * Per-file ceiling for Baú media. 100 MiB, not the attachments' 10 MiB: a
 * phone records 1080p at 8 to 12 Mbps, so 10 MiB is under ten seconds of
 * clip, and "upload it to YouTube instead" is the wrong answer for the one
 * surface whose job is to keep the clip. R2 charges nothing for egress and
 * cents per GB-month for storage, and the bytes go browser to bucket, so the
 * API never sees them. Signed into the presigned PUT and re-checked by HEAD
 * on claim, same as attachments.
 */
export const COMMUNITY_HOME_MAX_BYTES = 100 * 1024 * 1024;

/**
 * How many posts one feed read returns. The Baú is a durable archive, so
 * "every post since the server was made" is a page that only grows; the
 * client asks for the newest page and the pinned post always rides along.
 */
export const COMMUNITY_HOME_FEED_LIMIT = 50;

/** Comments returned for one post. The newest, read oldest-first. */
export const COMMUNITY_HOME_COMMENTS_LIMIT = 200;

export const COMMUNITY_HOME_TITLE_MAX = 200;
export const COMMUNITY_HOME_BODY_MAX = 4000;
export const COMMUNITY_HOME_TEASER_MAX = 500;
export const COMMUNITY_HOME_COMMENT_MAX = 1000;

/** Free for everyone in the server, or members-only (VIP / staff unlock). */
export const communityHomeVisibilitySchema = z.enum(["free", "members"]);
export type CommunityHomeVisibility = z.infer<
  typeof communityHomeVisibilitySchema
>;

export const communityHomePostStatusSchema = z.enum([
  "draft",
  "published",
  "scheduled",
]);
export type CommunityHomePostStatus = z.infer<
  typeof communityHomePostStatusSchema
>;

export const communityHomeMediaKindSchema = z.enum([
  "image",
  "video",
  "youtube",
  "twitch",
  "tiktok",
  "instagram",
  "file",
]);
export type CommunityHomeMediaKind = z.infer<
  typeof communityHomeMediaKindSchema
>;

/** Chip on the card. VIP is never shown this pass; staff = MANAGE_SERVER. */
export const communityHomeAuthorBadgeSchema = z.enum(["owner", "staff"]);
export type CommunityHomeAuthorBadge = z.infer<
  typeof communityHomeAuthorBadgeSchema
>;

/**
 * MIME types Home will mint an upload for. Subset of attachment allowlist —
 * no audio; video capped at `COMMUNITY_HOME_MAX_BYTES`.
 */
export const COMMUNITY_HOME_MIME_ALLOWLIST = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "application/pdf",
] as const;

export type CommunityHomeContentType =
  (typeof COMMUNITY_HOME_MIME_ALLOWLIST)[number];

export const communityHomeContentTypeSchema = z.enum(
  COMMUNITY_HOME_MIME_ALLOWLIST,
);

/** Bytes of a file's start that `sniffCommunityHomeImageType` needs. */
export const COMMUNITY_HOME_IMAGE_SNIFF_BYTES = 12;

/**
 * Which allowlisted image type these leading bytes really are, or null.
 *
 * Storage keeps whatever `Content-Type` the upload was signed with, and the
 * browser takes that from the file's name, so a text file called `x.png` looks
 * like a PNG to every check except the bytes. Shared so the composer can refuse
 * it before uploading and the claim can refuse it again on the stored object.
 */
export function sniffCommunityHomeImageType(
  bytes: Uint8Array,
): CommunityHomeContentType | null {
  const startsWith = (signature: number[], offset = 0) =>
    bytes.length >= offset + signature.length &&
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith([0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  // "GIF87a" and "GIF89a".
  if (
    startsWith([0x47, 0x49, 0x46, 0x38]) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  // "RIFF", four size bytes, "WEBP".
  if (
    startsWith([0x52, 0x49, 0x46, 0x46]) &&
    startsWith([0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  return null;
}

export function communityHomeMediaKindFromContentType(
  contentType: CommunityHomeContentType,
): "image" | "video" | "file" {
  if (contentType.startsWith("image/")) {
    return "image";
  }
  if (contentType.startsWith("video/")) {
    return "video";
  }
  return "file";
}

/**
 * Extract a YouTube video id from watch / youtu.be / shorts / embed / live URLs.
 */
export function parseYoutubeVideoId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com"
    ) {
      if (url.pathname === "/watch") {
        const id = url.searchParams.get("v");
        return id && /^[\w-]{11}$/.test(id) ? id : null;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (
        (parts[0] === "shorts" ||
          parts[0] === "embed" ||
          parts[0] === "live") &&
        parts[1] &&
        /^[\w-]{11}$/.test(parts[1])
      ) {
        return parts[1];
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function youtubeEmbedSrc(youtubeUrl: string): string | null {
  const id = parseYoutubeVideoId(youtubeUrl);
  return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
}

/**
 * Public YouTube poster. Safe to show on a locked card: it is the same
 * image youtube.com already serves. It does name the video id, so an
 * unlisted clip in a VIP post is findable from the thumb. That is the
 * Geowizard/Patreon trade: a poster, not the player.
 */
export function youtubePosterUrl(youtubeUrl: string | null | undefined): string | null {
  if (!youtubeUrl) {
    return null;
  }
  const id = parseYoutubeVideoId(youtubeUrl);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

function parseHttpUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/** TikTok snowflake on `/@user/video/{id}`. Short `vm.` / `vt.` links need a redirect and are refused. */
const TIKTOK_VIDEO_ID = /^\d{10,32}$/;

/**
 * Extract a TikTok video id from a canonical watch, embed, or player URL.
 *
 * Accepted: `tiktok.com/@user/video/{id}`, `m.tiktok.com/v/{id}`, and the
 * embed/player URLs themselves. `vm.tiktok.com` / `vt.tiktok.com` / `/t/`
 * short links only resolve after a redirect, so they are refused rather than
 * fetched. Profiles, tags, and discover are not a player.
 */
export function parseTikTokVideoId(raw: string): string | null {
  const url = parseHttpUrl(raw);
  if (!url) {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (host !== "tiktok.com" && host !== "m.tiktok.com") {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  const last = parts[parts.length - 1]!.replace(/\.html$/i, "");

  if (parts[0] === "embed") {
    const id = parts[1] === "v2" ? parts[2] : parts[1];
    return id && TIKTOK_VIDEO_ID.test(id) ? id : null;
  }
  if (parts[0] === "player" && parts[1] === "v1") {
    return parts[2] && TIKTOK_VIDEO_ID.test(parts[2]) ? parts[2] : null;
  }
  if (parts[0] === "v" && TIKTOK_VIDEO_ID.test(last)) {
    return last;
  }
  if (parts[0]?.startsWith("@") && parts[1] === "video" && parts[2]) {
    return TIKTOK_VIDEO_ID.test(parts[2]) ? parts[2] : null;
  }
  return null;
}

/**
 * Official iframe as of TikTok's Embed Player docs (2026-08): player/v1.
 * `embed/v2/{id}` is the older oEmbed iframe and 504s from some edges.
 */
export function tiktokEmbedSrc(tiktokUrl: string): string | null {
  const id = parseTikTokVideoId(tiktokUrl);
  return id ? `https://www.tiktok.com/player/v1/${id}` : null;
}

/** Canonical https watch URL from a parsed TikTok id — never the raw paste. */
export function tiktokCanonicalUrl(raw: string): string | null {
  const id = parseTikTokVideoId(raw);
  return id ? `https://www.tiktok.com/video/${id}` : null;
}

/** Instagram shortcode on `/p/`, `/reel/`, `/reels/`. */
const INSTAGRAM_SHORTCODE = /^[A-Za-z0-9_-]{5,32}$/;

export type InstagramEmbedTarget = {
  kind: "post" | "reel";
  shortcode: string;
};

/**
 * Extract an Instagram post or reel shortcode. Stories, profiles, and
 * explore are refused. Share /s/ and login-wall URLs that need a redirect
 * are refused too.
 */
export function parseInstagramEmbed(raw: string): InstagramEmbedTarget | null {
  const url = parseHttpUrl(raw);
  if (!url) {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (
    host !== "instagram.com" &&
    host !== "m.instagram.com" &&
    host !== "instagr.am"
  ) {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  const head = parts[0]!.toLowerCase();
  const shortcode = parts[1]!;
  if (!INSTAGRAM_SHORTCODE.test(shortcode)) {
    return null;
  }
  if (head === "p") {
    return { kind: "post", shortcode };
  }
  if (head === "reel" || head === "reels") {
    return { kind: "reel", shortcode };
  }
  return null;
}

/**
 * Instagram's `/p/{code}/embed/` (and `/reel/…/embed/`) answers 200 with no
 * X-Frame-Options, unlike the watch page which sends DENY. That is the
 * official iframe path embed.js uses.
 */
export function instagramEmbedSrc(instagramUrl: string): string | null {
  const target = parseInstagramEmbed(instagramUrl);
  if (!target) {
    return null;
  }
  const path = target.kind === "reel" ? "reel" : "p";
  return `https://www.instagram.com/${path}/${target.shortcode}/embed/`;
}

/** Canonical https watch URL from a parsed Instagram target — never the raw paste. */
export function instagramCanonicalUrl(raw: string): string | null {
  const target = parseInstagramEmbed(raw);
  if (!target) {
    return null;
  }
  const path = target.kind === "reel" ? "reel" : "p";
  return `https://www.instagram.com/${path}/${target.shortcode}/`;
}

/**
 * Twitch player target extracted from a channel, VOD, or clip URL.
 * Directory / search / settings paths are refused — those are not a player.
 */
export type TwitchEmbedTarget =
  | { kind: "channel"; id: string }
  | { kind: "video"; id: string }
  | { kind: "clip"; id: string };

const TWITCH_CHANNEL = /^[a-zA-Z0-9_]{3,25}$/;
const TWITCH_VIDEO_ID = /^\d{1,15}$/;
const TWITCH_CLIP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,99}$/;

/** First path segments on twitch.tv that are site chrome, not a channel. */
const TWITCH_RESERVED_CHANNELS = new Set([
  "about",
  "ads",
  "bits",
  "blog",
  "broadcast",
  "clips",
  "communities",
  "creatorcamp",
  "dashboard",
  "directory",
  "downloads",
  "drops",
  "embed",
  "following",
  "friends",
  "inventory",
  "jobs",
  "login",
  "messages",
  "moderation",
  "notifications",
  "p",
  "partners",
  "popout",
  "prime",
  "search",
  "settings",
  "signup",
  "store",
  "stream",
  "streammanager",
  "subs",
  "subscriptions",
  "team",
  "teams",
  "turbo",
  "v",
  "video",
  "videos",
  "wallet",
]);

function twitchVideoId(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const id = raw.replace(/^v/i, "");
  return TWITCH_VIDEO_ID.test(id) ? id : null;
}

function twitchChannelId(raw: string | null | undefined): string | null {
  if (
    !raw ||
    !TWITCH_CHANNEL.test(raw) ||
    TWITCH_RESERVED_CHANNELS.has(raw.toLowerCase())
  ) {
    return null;
  }
  return raw.toLowerCase();
}

export function parseTwitchEmbed(raw: string): TwitchEmbedTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    const host = url.hostname.replace(/^www\./, "").toLowerCase();

    if (host === "clips.twitch.tv") {
      if (url.pathname === "/embed") {
        const clip = url.searchParams.get("clip");
        return clip && TWITCH_CLIP_ID.test(clip)
          ? { kind: "clip", id: clip }
          : null;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      const slug = parts.length === 1 ? parts[0] : undefined;
      return slug && TWITCH_CLIP_ID.test(slug)
        ? { kind: "clip", id: slug }
        : null;
    }

    if (host === "player.twitch.tv") {
      const channel = twitchChannelId(url.searchParams.get("channel"));
      if (channel) {
        return { kind: "channel", id: channel };
      }
      const video = twitchVideoId(url.searchParams.get("video"));
      return video ? { kind: "video", id: video } : null;
    }

    if (host !== "twitch.tv" && host !== "m.twitch.tv") {
      return null;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 0) {
      return null;
    }

    if (parts[0] === "videos" || parts[0] === "video" || parts[0] === "v") {
      if (parts.length !== 2) {
        return null;
      }
      const id = twitchVideoId(parts[1]);
      return id ? { kind: "video", id } : null;
    }

    if (parts.length === 1) {
      const channel = twitchChannelId(parts[0]);
      return channel ? { kind: "channel", id: channel } : null;
    }

    if (
      parts.length === 3 &&
      parts[1] === "clip" &&
      parts[2] &&
      TWITCH_CLIP_ID.test(parts[2])
    ) {
      const channel = twitchChannelId(parts[0]);
      return channel ? { kind: "clip", id: parts[2] } : null;
    }

    if (
      parts.length === 3 &&
      (parts[1] === "video" || parts[1] === "videos" || parts[1] === "v") &&
      parts[2]
    ) {
      const id = twitchVideoId(parts[2]);
      const channel = twitchChannelId(parts[0]);
      if (id && channel) {
        return { kind: "video", id };
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Twitch's player refuses to render unless `parent` is the embedding page's
 * hostname. The original URL is stored; this is built at render time so a
 * post written on localhost still plays on pqp.gg.
 */
export function twitchEmbedSrc(
  twitchUrl: string,
  parentHost: string,
): string | null {
  const target = parseTwitchEmbed(twitchUrl);
  if (!target) {
    return null;
  }
  const parent = parentHost.trim().toLowerCase();
  if (!isSafeTwitchParent(parent)) {
    return null;
  }
  const parentQuery = `parent=${encodeURIComponent(parent)}&autoplay=false`;
  if (target.kind === "channel") {
    return `https://player.twitch.tv/?channel=${encodeURIComponent(target.id)}&${parentQuery}`;
  }
  if (target.kind === "video") {
    return `https://player.twitch.tv/?video=${encodeURIComponent(target.id)}&${parentQuery}`;
  }
  return `https://clips.twitch.tv/embed?clip=${encodeURIComponent(target.id)}&${parentQuery}`;
}

function isSafeTwitchParent(host: string): boolean {
  if (host === "localhost") {
    return true;
  }
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    return true;
  }
  return (
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(host) ||
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)
  );
}

export type CommunityHomeEmbedKind =
  | "youtube"
  | "twitch"
  | "tiktok"
  | "instagram";

/** YouTube, Twitch, TikTok, or Instagram watch URL. */
export function parseCommunityHomeEmbed(
  raw: string,
): CommunityHomeEmbedKind | null {
  if (parseYoutubeVideoId(raw)) {
    return "youtube";
  }
  if (parseTwitchEmbed(raw)) {
    return "twitch";
  }
  if (parseTikTokVideoId(raw)) {
    return "tiktok";
  }
  if (parseInstagramEmbed(raw)) {
    return "instagram";
  }
  return null;
}

export function isCommunityHomeEmbedKind(
  kind: string | null | undefined,
): kind is CommunityHomeEmbedKind {
  return (
    kind === "youtube" ||
    kind === "twitch" ||
    kind === "tiktok" ||
    kind === "instagram"
  );
}

export const communityHomeYoutubeUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => parseYoutubeVideoId(value) != null, "Invalid YouTube URL");

export const communityHomeEmbedUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) => parseCommunityHomeEmbed(value) != null,
    "Invalid YouTube, Twitch, TikTok or Instagram URL",
  );

/**
 * The second cut of an uploaded video: the vertical (9:16) edit a phone plays
 * instead of the landscape one. Always a stored video, uploaded through the
 * same mint / PUT / claim as the main media, and only ever carried by a media
 * whose own kind is `video`. It rides inside `media`, so a locked viewer, who
 * gets no media at all, never gets this either.
 */
export const communityHomeMobileRenditionSchema = z.object({
  name: z.string(),
  contentType: z.string().nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
  /** Presigned GET; null when storage is not readable right now. */
  url: z.string().nullable(),
});

export type CommunityHomeMobileRendition = z.infer<
  typeof communityHomeMobileRenditionSchema
>;

/** Media as returned to a viewer who may see it. Locked viewers get null. */
export const communityHomeMediaSchema = z.object({
  kind: communityHomeMediaKindSchema,
  name: z.string(),
  contentType: z.string().nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
  /** Presigned GET when storage-backed; null for YouTube / Twitch / TikTok / Instagram. */
  url: z.string().nullable(),
  /** Original paste URL for YouTube, TikTok, and Instagram. Twitch uses twitchUrl. */
  youtubeUrl: z.string().nullable(),
  /**
   * Absent on an older API during a rolling deploy. Treat missing as null
   * so a YouTube or file card still parses instead of taking the whole feed
   * down.
   */
  twitchUrl: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  /**
   * The phone cut of a `video`, when the author attached one and the
   * `bau_mobile_rendition` flag is on for the server. Absent on an older API
   * and on every other kind; missing reads as null, and a client that ignores
   * it plays the main video, which is the whole compatibility story.
   * Optional in the type too, so a media built by hand (an embed preview, a
   * fixture) never has to name it.
   */
  mobile: communityHomeMobileRenditionSchema.nullable().optional(),
});

export type CommunityHomeMedia = z.infer<typeof communityHomeMediaSchema>;

/** Original paste URL when the media is a YouTube, Twitch, TikTok, or Instagram embed. */
export function communityHomeEmbedUrl(
  media: CommunityHomeMedia,
): string | null {
  if (media.kind === "youtube" || media.kind === "tiktok" || media.kind === "instagram") {
    return media.youtubeUrl;
  }
  if (media.kind === "twitch") {
    return media.twitchUrl;
  }
  return null;
}

export const communityHomeCommentSchema = z.object({
  id: z.string().uuid(),
  author: publicUserSchema,
  body: z.string(),
  createdAt: z.string(),
});

export type CommunityHomeComment = z.infer<typeof communityHomeCommentSchema>;

/**
 * The languages a Baú post is translated into: one per UI locale (`en`,
 * `pt-BR`, `es`), as ISO-639-1 codes. `pt-BR` and `pt` are one language here,
 * and every `es-*` is the one Spanish the UI catalogue is written in.
 */
export const COMMUNITY_HOME_TRANSLATION_LANGS = ["en", "pt", "es"] as const;

export type CommunityHomeTranslationLang =
  (typeof COMMUNITY_HOME_TRANSLATION_LANGS)[number];

export const communityHomeTranslationLangSchema = z.enum(
  COMMUNITY_HOME_TRANSLATION_LANGS,
);

/**
 * A UI locale or a bare language tag (`pt-BR`, `pt`, `en-US`, `es-MX`) to the
 * language a translation is stored under, or null for one we do not translate
 * into. The reader's `?lang=` goes through this, so nothing outside the list
 * can name a translation row.
 */
export function normalizeCommunityHomeLang(
  raw: string | null | undefined,
): CommunityHomeTranslationLang | null {
  if (!raw) {
    return null;
  }
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  return (COMMUNITY_HOME_TRANSLATION_LANGS as readonly string[]).includes(
    base ?? "",
  )
    ? (base as CommunityHomeTranslationLang)
    : null;
}

/**
 * What the reader sees is the translation; `original` is the author's own
 * words, so the card can flip back without a second request. `original` goes
 * through the same lock as the top-level fields: for a members-only post the
 * viewer cannot open, its `body` is null here too.
 */
export const communityHomePostTranslationSchema = z.object({
  lang: communityHomeTranslationLangSchema,
  /** Always true today; a field so a reviewed human translation can say false. */
  auto: z.boolean(),
  /** The language the post was written in, when it could be told. */
  sourceLang: z.string().nullable(),
  original: z.object({
    title: z.string().nullable(),
    body: z.string().nullable(),
    teaser: z.string().nullable(),
  }),
});

export type CommunityHomePostTranslation = z.infer<
  typeof communityHomePostTranslationSchema
>;

/** Staff read-only view: one stored translation, with whether it is current. */
export const communityHomePostTranslationRowSchema = z.object({
  lang: communityHomeTranslationLangSchema,
  title: z.string().nullable(),
  body: z.string(),
  teaser: z.string().nullable(),
  sourceLang: z.string().nullable(),
  /** The post's own language already is `lang`: there is nothing to show. */
  sameLanguage: z.boolean(),
  /** The post was edited after this was made; readers get the original. */
  stale: z.boolean(),
  model: z.string(),
  createdAt: z.string(),
});

export type CommunityHomePostTranslationRow = z.infer<
  typeof communityHomePostTranslationRowSchema
>;

export const communityHomePostTranslationsResponseSchema = z.object({
  /** The flag is on for this server and a key is configured on the API. */
  enabled: z.boolean(),
  translations: z.array(communityHomePostTranslationRowSchema),
});

export type CommunityHomePostTranslationsResponse = z.infer<
  typeof communityHomePostTranslationsResponseSchema
>;

export const communityHomePostSchema = z.object({
  id: z.string().uuid(),
  serverId: z.string().uuid(),
  author: publicUserSchema,
  authorBadge: communityHomeAuthorBadgeSchema.nullable(),
  title: z.string().nullable(),
  /**
   * Omitted (null) for members-only posts when the viewer cannot unlock —
   * the API strips it; the client must not invent body from teaser.
   */
  body: z.string().nullable(),
  teaser: z.string().nullable(),
  visibility: communityHomeVisibilitySchema,
  status: communityHomePostStatusSchema,
  commentsEnabled: z.boolean(),
  media: communityHomeMediaSchema.nullable(),
  /**
   * Whether this post has media, even when `media` is null for a locked
   * viewer. Defaulted so a payload from an API that predates the field still
   * parses; the lock plate then stays off rather than inventing a thumbnail.
   */
  hasMedia: z.boolean().default(false),
  /**
   * Public poster for a locked YouTube card. Null for uploads and other
   * embeds: those pixels are the secret, and the API must not sign them
   * for a locked viewer. Defaulted so an older payload still parses.
   */
  posterUrl: z.string().nullable().default(null),
  /** True when body/media were stripped for this viewer. */
  locked: z.boolean(),
  likeCount: z.number().int().nonnegative(),
  likedByMe: z.boolean(),
  commentCount: z.number().int().nonnegative(),
  /** Up to two newest comments for the card teaser. */
  commentTeaser: z.array(communityHomeCommentSchema).max(2),
  /**
   * Kept at the top of the feed. At most one per server: the welcome post,
   * the house rules, the video that explains what this Baú is for.
   */
  pinned: z.boolean(),
  scheduledAt: z.string().nullable(),
  /** IANA timezone the author picked when scheduling (display + compose). */
  scheduleTimezone: z.string().nullable(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * Set when `title` / `body` / `teaser` above are an automatic translation
   * into the reader's language. Null (and defaulted, so an older API still
   * parses) when the reader sees the author's own words.
   */
  translation: communityHomePostTranslationSchema.nullable().default(null),
});

export type CommunityHomePost = z.infer<typeof communityHomePostSchema>;

const titleSchema = z
  .string()
  .trim()
  .max(COMMUNITY_HOME_TITLE_MAX)
  .pipe(safeTextSchema);

const bodySchema = z
  .string()
  .trim()
  .max(COMMUNITY_HOME_BODY_MAX)
  .pipe(safeTextSchema);

const teaserSchema = z
  .string()
  .trim()
  .max(COMMUNITY_HOME_TEASER_MAX)
  .pipe(safeTextSchema);

/**
 * Create / save a post. Title required for publish/schedule at the route;
 * drafts may omit title. At least body or media is required to leave draft
 * toward publish — enforced in the service.
 */
export const createCommunityHomePostSchema = z.object({
  title: z.string().max(COMMUNITY_HOME_TITLE_MAX).optional().nullable(),
  body: z.string().max(COMMUNITY_HOME_BODY_MAX).optional().nullable(),
  teaser: z.string().max(COMMUNITY_HOME_TEASER_MAX).optional().nullable(),
  visibility: communityHomeVisibilitySchema.default("free"),
  commentsEnabled: z.boolean().optional(),
  /** Claimed media upload id, or omit / null for text-only / a paste URL. */
  mediaUploadId: z.string().uuid().optional().nullable(),
  /**
   * A second claimed upload: the vertical cut phones play. Only with a
   * `mediaUploadId` that is a video, and must be a video itself. Behind the
   * `bau_mobile_rendition` flag.
   */
  mobileMediaUploadId: z.string().uuid().optional().nullable(),
  /**
   * A YouTube, Twitch, TikTok, or Instagram watch URL. The service
   * classifies which; one field so the composer stays one paste box.
   */
  youtubeUrl: z.string().max(500).optional().nullable(),
  /**
   * Intent on create. `published` / `scheduled` require title + (body|media).
   * Dirty-close from compose uses `draft`.
   */
  status: communityHomePostStatusSchema.default("draft"),
  scheduledAt: z.string().datetime({ offset: true }).optional().nullable(),
  scheduleTimezone: z.string().min(1).max(64).optional().nullable(),
  /**
   * With `status: "published"`: also post the card into this channel of the
   * same server. Best effort; a channel the author cannot send in is skipped
   * and the post still publishes.
   */
  announceChannelId: z.string().uuid().optional().nullable(),
});

export type CreateCommunityHomePostRequest = z.infer<
  typeof createCommunityHomePostSchema
>;

export const updateCommunityHomePostSchema = z.object({
  title: z.string().max(COMMUNITY_HOME_TITLE_MAX).optional().nullable(),
  body: z.string().max(COMMUNITY_HOME_BODY_MAX).optional().nullable(),
  teaser: z.string().max(COMMUNITY_HOME_TEASER_MAX).optional().nullable(),
  visibility: communityHomeVisibilitySchema.optional(),
  commentsEnabled: z.boolean().optional(),
  mediaUploadId: z.string().uuid().optional().nullable(),
  youtubeUrl: z.string().max(500).optional().nullable(),
  /** Pass null to clear media (including a paste-URL embed). */
  clearMedia: z.boolean().optional(),
  /**
   * The phone cut. Omitted keeps the one on the post (and it goes with the
   * main media when that is replaced by something that is not a video or
   * cleared); a claimed upload id replaces it; `null` removes it.
   */
  mobileMediaUploadId: z.string().uuid().optional().nullable(),
});

export type UpdateCommunityHomePostRequest = z.infer<
  typeof updateCommunityHomePostSchema
>;

export const scheduleCommunityHomePostSchema = z.object({
  scheduledAt: z.string().datetime({ offset: true }),
  /** IANA tz name for display (e.g. America/Sao_Paulo). */
  scheduleTimezone: z.string().min(1).max(64),
});

export type ScheduleCommunityHomePostRequest = z.infer<
  typeof scheduleCommunityHomePostSchema
>;

/** Pin or unpin. Pinning replaces whatever was pinned before. */
export const pinCommunityHomePostSchema = z.object({
  pinned: z.boolean(),
});

export type PinCommunityHomePostRequest = z.infer<
  typeof pinCommunityHomePostSchema
>;

/** `GET /api/servers/:id/home/unread`: published posts since this person last
 * opened the feed, their own excluded. */
export const communityHomeUnreadResponseSchema = z.object({
  count: z.number().int().nonnegative(),
});

export type CommunityHomeUnreadResponse = z.infer<
  typeof communityHomeUnreadResponseSchema
>;

export const createCommunityHomeCommentSchema = z.object({
  body: z.string().max(COMMUNITY_HOME_COMMENT_MAX * 2),
});

export type CreateCommunityHomeCommentRequest = z.infer<
  typeof createCommunityHomeCommentSchema
>;

export const communityHomeCommentBodySchema = z
  .string()
  .trim()
  .min(1)
  .max(COMMUNITY_HOME_COMMENT_MAX)
  .pipe(safeTextSchema);

export const createCommunityHomeMediaUploadSchema = z.object({
  contentType: communityHomeContentTypeSchema,
  byteSize: z.number().int().positive().max(COMMUNITY_HOME_MAX_BYTES),
  filename: attachmentFilenameSchema,
});

export type CreateCommunityHomeMediaUploadRequest = z.infer<
  typeof createCommunityHomeMediaUploadSchema
>;

export const createCommunityHomeMediaUploadResponseSchema = z.object({
  uploadId: z.string().uuid(),
  key: z.string(),
  uploadUrl: z.string(),
  expiresAt: z.string(),
  kind: z.enum(["image", "video", "file"]),
});

export type CreateCommunityHomeMediaUploadResponse = z.infer<
  typeof createCommunityHomeMediaUploadResponseSchema
>;

export const claimCommunityHomeMediaSchema = z.object({
  uploadId: z.string().uuid(),
});

export type ClaimCommunityHomeMediaRequest = z.infer<
  typeof claimCommunityHomeMediaSchema
>;

export const claimCommunityHomeMediaResponseSchema = z.object({
  uploadId: z.string().uuid(),
  kind: z.enum(["image", "video", "file"]),
  name: z.string().max(ATTACHMENT_FILENAME_MAX_LENGTH),
  contentType: communityHomeContentTypeSchema,
  byteSize: z.number().int().positive(),
});

export type ClaimCommunityHomeMediaResponse = z.infer<
  typeof claimCommunityHomeMediaResponseSchema
>;

export const communityHomePostsResponseSchema = z.object({
  posts: z.array(communityHomePostSchema),
  /**
   * `community_home_translation` is on for this server, so readers in other
   * languages are served an automatic translation. The staff composer says so.
   * Defaulted: an older API never sends it.
   */
  translationEnabled: z.boolean().default(false),
  /**
   * `bau_mobile_rendition` is on for this server: the staff composer offers
   * a second, vertical cut of an uploaded video. Defaulted: an older API
   * never sends it.
   */
  mobileRenditionEnabled: z.boolean().default(false),
});

export type CommunityHomePostsResponse = z.infer<
  typeof communityHomePostsResponseSchema
>;

export const communityHomePostResponseSchema = z.object({
  post: communityHomePostSchema,
});

export type CommunityHomePostResponse = z.infer<
  typeof communityHomePostResponseSchema
>;

export const communityHomeCommentsResponseSchema = z.object({
  comments: z.array(communityHomeCommentSchema),
});

export type CommunityHomeCommentsResponse = z.infer<
  typeof communityHomeCommentsResponseSchema
>;

export const communityHomeLikeResponseSchema = z.object({
  liked: z.boolean(),
  likeCount: z.number().int().nonnegative(),
});

export type CommunityHomeLikeResponse = z.infer<
  typeof communityHomeLikeResponseSchema
>;

/**
 * `GET /api/community-home/config`. `enabled` is the instance flag
 * (`COMMUNITY_HOME_ENABLED`); `vipEnabled` the separate VIP switch
 * (`COMMUNITY_HOME_VIP_ENABLED`, meaningless without the first);
 * `mediaEnabled` whether object storage is configured, so the composer can
 * hide the file picker and offer YouTube / Twitch / TikTok / Instagram only.
 */
export const communityHomeConfigSchema = z.object({
  enabled: z.boolean(),
  vipEnabled: z.boolean(),
  mediaEnabled: z.boolean(),
});

export type CommunityHomeConfig = z.infer<typeof communityHomeConfigSchema>;

/**
 * WS nudge: clients refetch Home for this server. Not a channel broadcast.
 *
 * `enabled` and `version` are present only when the owner flipped this
 * server's Baú switch: the new value and its `servers.community_home_version`.
 * A member's open app applies the value only when the version is higher than
 * the one its copy of the server holds, so frames that arrive late, twice or
 * out of order cannot leave it on an older setting. Publish, pin and delete
 * frames leave both out.
 */
export const communityHomeUpdateSchema = z.object({
  type: z.literal("community-home-update"),
  serverId: z.string().uuid(),
  enabled: z.boolean().optional(),
  version: z.number().int().nonnegative().optional(),
});

export type CommunityHomeUpdate = z.infer<typeof communityHomeUpdateSchema>;

/** Parsed create fields after route-level safeText application. */
export type ParsedCommunityHomePostFields = {
  title: string | null;
  body: string;
  teaser: string | null;
  visibility: CommunityHomeVisibility;
  commentsEnabled: boolean;
  mediaUploadId: string | null;
  mobileMediaUploadId: string | null;
  youtubeUrl: string | null;
  status: CommunityHomePostStatus;
  scheduledAt: string | null;
  scheduleTimezone: string | null;
};

export function parseCommunityHomeTitle(
  value: string | null | undefined,
): string | null {
  if (value == null || value.trim() === "") {
    return null;
  }
  return titleSchema.parse(value);
}

export function parseCommunityHomeBody(
  value: string | null | undefined,
): string {
  if (value == null || value.trim() === "") {
    return "";
  }
  return bodySchema.parse(value);
}

export function parseCommunityHomeTeaser(
  value: string | null | undefined,
): string | null {
  if (value == null || value.trim() === "") {
    return null;
  }
  return teaserSchema.parse(value);
}
