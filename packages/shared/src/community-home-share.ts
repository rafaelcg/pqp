import { z } from "zod";
import {
  communityHomeMediaKindSchema,
  communityHomeVisibilitySchema,
} from "./community-home.js";

/**
 * Sharing a Baú post into chat.
 *
 * A post has one stable address, `/app/server/<serverId>/bau/<postId>`. A chat
 * message that contains that address (on this instance) is drawn as a rich
 * card instead of a bare link. The card data comes from an authorized
 * endpoint, so a reader who may not see the post just sees the link.
 */

const UUID =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

const BAU_PATH_RE = new RegExp(`^/app/server/(${UUID})/bau/(${UUID})/?$`);

/** Where a post lives inside the app. Always relative; callers add an origin. */
export function bauPostPath(serverId: string, postId: string): string {
  return `/app/server/${serverId}/bau/${postId}`;
}

export type BauPostRef = { serverId: string; postId: string };

/** The post a `/app/server/<id>/bau/<id>` path names, or null. */
export function parseBauPostPath(pathname: string): BauPostRef | null {
  const match = BAU_PATH_RE.exec(pathname);
  if (!match) {
    return null;
  }
  return { serverId: match[1]!.toLowerCase(), postId: match[2]!.toLowerCase() };
}

export type BauPostLink = BauPostRef & {
  /** The URL exactly as it appears in the text. */
  url: string;
  /** Its origin, e.g. `https://pqp.gg`. */
  origin: string;
  /** Offsets into the scanned text, `end` exclusive. */
  start: number;
  end: number;
};

const URL_RE = /https?:\/\/[^\s<>()[\]]+/gi;
const TRAILING_PUNCTUATION_RE = /[.,;:!?'"]+$/;

/**
 * Every Baú post permalink in a message body, in order. Origin policy is the
 * caller's: this only says that the path is a Baú post. Query strings and
 * fragments are allowed and ignored, a trailing sentence mark is not part of
 * the link.
 */
export function findBauPostLinks(text: string): BauPostLink[] {
  const found: BauPostLink[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0].replace(TRAILING_PUNCTUATION_RE, "");
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    const ref = parseBauPostPath(parsed.pathname);
    if (!ref) {
      continue;
    }
    const start = match.index ?? 0;
    found.push({
      ...ref,
      url: raw,
      origin: parsed.origin,
      start,
      end: start + raw.length,
    });
  }
  return found;
}

/** The longest teaser a card shows, in characters. */
export const BAU_CARD_TEASER_MAX = 220;

/**
 * What a chat card shows of a post. Deliberately small: no comments, no body
 * beyond a teaser, and for a post the viewer cannot open (`locked`) only what
 * the feed itself shows a locked reader.
 */
export const communityHomePostCardSchema = z.object({
  postId: z.string().uuid(),
  serverId: z.string().uuid(),
  serverName: z.string(),
  title: z.string().nullable(),
  teaser: z.string().nullable(),
  /**
   * Null on a locked card: who wrote a members-only post is part of what the
   * lock withholds, exactly as the feed shows a locked reader no author.
   */
  author: z
    .object({
      id: z.string().uuid(),
      displayName: z.string(),
      avatarUrl: z.string().nullable(),
    })
    .nullable(),
  mediaKind: communityHomeMediaKindSchema.nullable(),
  /**
   * An image or a video file URL the viewer may load (a signed GET), or a
   * public YouTube poster. Null for a text post, a locked upload, and an
   * embed with no poster.
   */
  mediaUrl: z.string().nullable(),
  /**
   * The cover the author chose for a video (`media.posterUrl`), a signed GET of
   * an image. Null for anything else, for a video on its automatic cover and
   * for a locked card. Defaulted, so a card from an older API still parses; a
   * client that ignores it paints the video's first frame from `mediaUrl`.
   */
  posterUrl: z.string().nullable().optional().transform((value) => value ?? null),
  visibility: communityHomeVisibilitySchema,
  locked: z.boolean(),
  pinned: z.boolean(),
  likeCount: z.number().int().nonnegative(),
  commentCount: z.number().int().nonnegative(),
  publishedAt: z.string().nullable(),
});

export type CommunityHomePostCard = z.infer<typeof communityHomePostCardSchema>;

/** How many posts `GET …/home/latest` returns when `?limit=` is absent. */
export const COMMUNITY_HOME_LATEST_DEFAULT = 3;
/** The most `?limit=` may ask for. A preview, not a second feed. */
export const COMMUNITY_HOME_LATEST_MAX = 10;

/**
 * `?limit=` of `GET …/home/latest`, clamped: absent or not a number is the
 * default, anything else is pulled into 1..max. Never a 400, because the
 * caller is a sidebar that should draw something rather than nothing.
 */
export function parseCommunityHomeLatestLimit(raw: string | null | undefined): number {
  const n = raw == null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    return COMMUNITY_HOME_LATEST_DEFAULT;
  }
  return Math.min(COMMUNITY_HOME_LATEST_MAX, Math.max(1, n));
}

/**
 * One post of `GET …/home/latest`: the chat card, plus whether it counts
 * toward `unread`. `isNew` is the unread rule itself (published after the
 * viewer last opened the Baú, and not their own post), computed in the same
 * statement as the count, so the preview and the badge never disagree.
 */
export const communityHomeLatestCardSchema = communityHomePostCardSchema.extend({
  isNew: z.boolean(),
});

export type CommunityHomeLatestCard = z.infer<typeof communityHomeLatestCardSchema>;

/**
 * `GET /api/servers/:serverId/home/latest?limit=3&lang=`: the sidebar preview.
 * The newest published posts (newest first, the pinned post NOT moved to the
 * front), the unread count the badge shows, and when the viewer last opened
 * the Baú (null: never). 404 while the runtime flag `bau_latest_preview` is
 * off for the server; the client then falls back to `…/home/unread`.
 */
export const communityHomeLatestResponseSchema = z.object({
  unread: z.number().int().nonnegative(),
  lastSeenAt: z.string().nullable(),
  posts: z.array(communityHomeLatestCardSchema),
});

export type CommunityHomeLatestResponse = z.infer<
  typeof communityHomeLatestResponseSchema
>;

/** `POST /api/servers/:id/home/posts/:postId/share` */
export const shareCommunityHomePostSchema = z.object({
  channelId: z.string().uuid(),
  /** Optional words above the link. */
  message: z.string().max(1500).optional().nullable(),
  /**
   * One per dialog attempt. The chat's own send de-duplicates on it, so a
   * retry after a lost response returns the message that already went out
   * instead of posting a second card.
   */
  nonce: z.string().min(1).max(64).optional(),
});

export type ShareCommunityHomePostRequest = z.infer<
  typeof shareCommunityHomePostSchema
>;

/** Optional body of `POST …/home/posts/:postId/publish`. */
export const publishCommunityHomePostSchema = z.object({
  /** Also post the card into this channel of the same server. */
  announceChannelId: z.string().uuid().optional().nullable(),
});

/** Whether a message body is nothing but the link (so the card can stand alone). */
export function bodyIsOnlyBauLink(text: string, link: BauPostLink): boolean {
  return (
    text.slice(0, link.start).trim() === "" &&
    text.slice(link.end).trim().replace(TRAILING_PUNCTUATION_RE, "") === ""
  );
}
