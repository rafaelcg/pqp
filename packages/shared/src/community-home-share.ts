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
  author: z.object({
    id: z.string().uuid(),
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
  }),
  mediaKind: communityHomeMediaKindSchema.nullable(),
  /**
   * An image or a video file URL the viewer may load (a signed GET), or a
   * public YouTube poster. Null for a text post, a locked upload, and an
   * embed with no poster.
   */
  mediaUrl: z.string().nullable(),
  visibility: communityHomeVisibilitySchema,
  locked: z.boolean(),
  pinned: z.boolean(),
  likeCount: z.number().int().nonnegative(),
  commentCount: z.number().int().nonnegative(),
  publishedAt: z.string().nullable(),
});

export type CommunityHomePostCard = z.infer<typeof communityHomePostCardSchema>;

/** `POST /api/servers/:id/home/posts/:postId/share` */
export const shareCommunityHomePostSchema = z.object({
  channelId: z.string().uuid(),
  /** Optional words above the link. */
  message: z.string().max(1500).optional().nullable(),
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
