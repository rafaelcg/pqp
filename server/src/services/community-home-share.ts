import {
  BAU_CARD_TEASER_MAX,
  bauPostPath,
  type CommunityHomePost,
  type CommunityHomePostCard,
} from "@pqp/shared";
import type { DbUser } from "../db.js";
import { getPool } from "../db.js";
import { postChannelMessage } from "../ws/chat.js";
import {
  CommunityHomeError,
  getCommunityHomePost,
} from "./community-home.js";
import { getChannel } from "./servers.js";

/**
 * Baú posts in chat: the card a message with a permalink is drawn as, and the
 * share action that puts such a message into a channel.
 *
 * Authorization is the feed's own. The card is built from
 * `getCommunityHomePost`, the same read the feed uses, so a members-only post
 * a viewer cannot open comes back already stripped (title and teaser, a public
 * YouTube poster, nothing else), and a draft is a 404 here even for staff.
 */

/** Markdown noise out, whitespace collapsed, cut at a word where it can be. */
export function teaserFromBody(body: string | null): string | null {
  if (!body) {
    return null;
  }
  const plain = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`>#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) {
    return null;
  }
  if (plain.length <= BAU_CARD_TEASER_MAX) {
    return plain;
  }
  const cut = plain.slice(0, BAU_CARD_TEASER_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > BAU_CARD_TEASER_MAX * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.replace(/[\s.,;:!?-]+$/, "")}...`;
}

/** Pure projection of a feed post into the small card. Exported for tests. */
export function toPostCard(
  post: CommunityHomePost,
  serverName: string,
): CommunityHomePostCard {
  let mediaKind: CommunityHomePostCard["mediaKind"] = null;
  let mediaUrl: string | null = null;
  if (post.locked) {
    // Only the public YouTube poster ever reaches a locked reader.
    if (post.posterUrl) {
      mediaKind = "youtube";
      mediaUrl = post.posterUrl;
    }
  } else if (post.media) {
    mediaKind = post.media.kind;
    if (post.media.kind === "image" || post.media.kind === "video") {
      mediaUrl = post.media.url;
    } else if (post.media.kind === "youtube") {
      mediaUrl = post.posterUrl;
    }
  }
  const teaser = post.locked
    ? post.teaser
    : (post.teaser?.trim() || teaserFromBody(post.body));
  return {
    postId: post.id,
    serverId: post.serverId,
    serverName,
    title: post.title,
    teaser: teaser ? teaserFromBody(teaser) : null,
    author: post.locked
      ? null
      : {
          id: post.author.id,
          displayName: post.author.displayName,
          avatarUrl: post.author.avatarUrl,
        },
    mediaKind,
    mediaUrl,
    visibility: post.visibility,
    locked: post.locked,
    pinned: post.pinned,
    likeCount: post.likeCount,
    commentCount: post.commentCount,
    publishedAt: post.publishedAt,
  };
}

export async function getCommunityHomePostCard(
  serverId: string,
  postId: string,
  viewerId: string,
  lang?: string | null,
): Promise<CommunityHomePostCard> {
  const server = await getPool().query<{
    name: string;
    community_home_enabled: boolean | null;
  }>(`SELECT name, community_home_enabled FROM servers WHERE id = $1`, [
    serverId,
  ]);
  const row = server.rows[0];
  // Baú switched off for this server: the CTA would land on nothing.
  if (!row || row.community_home_enabled !== true) {
    throw new CommunityHomeError("not_found", "Post not found");
  }
  const post = await getCommunityHomePost(serverId, postId, viewerId, lang);
  if (post.status !== "published") {
    throw new CommunityHomeError("not_found", "Post not found");
  }
  return toPostCard(post, row.name);
}

export type ShareFailure =
  | "no-post"
  | "bad-channel"
  | "no-access"
  | "cannot-send"
  | "slow-mode"
  | "blocked"
  | "unavailable";

export type ShareResult = { ok: true } | { ok: false; reason: ShareFailure };

/** Strips anything that is not a plain http(s) origin; falls back to pqp.gg. */
export function safeShareOrigin(origin: string | null | undefined): string {
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.protocol === "https:" || url.protocol === "http:") {
        return url.origin;
      }
    } catch {
      // fall through
    }
  }
  return "https://pqp.gg";
}

/**
 * Post a normal chat message that carries the post's permalink, as `author`.
 * It goes through `postChannelMessage`, so SEND_MESSAGES, slow mode, AutoMod
 * and the broadcast are the chat's own, not a copy of them.
 */
export async function shareCommunityHomePost(input: {
  author: DbUser;
  serverId: string;
  postId: string;
  channelId: string;
  message?: string | null;
  origin: string;
  /** Chat de-duplicates on it: a retried share returns the first message. */
  nonce?: string;
}): Promise<ShareResult> {
  // Readable and published, by the author's own eyes.
  try {
    await getCommunityHomePostCard(input.serverId, input.postId, input.author.id);
  } catch (error) {
    if (error instanceof CommunityHomeError) {
      return { ok: false, reason: "no-post" };
    }
    throw error;
  }
  const channel = await getChannel(input.channelId);
  if (
    !channel ||
    channel.kind !== "server" ||
    channel.server_id !== input.serverId ||
    channel.type !== "text"
  ) {
    return { ok: false, reason: "bad-channel" };
  }
  const link = `${safeShareOrigin(input.origin)}${bauPostPath(
    input.serverId,
    input.postId,
  )}`;
  const note = input.message?.trim();
  const body = note ? `${note}\n${link}` : link;
  const posted = await postChannelMessage({
    author: input.author,
    channelId: input.channelId,
    body,
    ...(input.nonce ? { nonce: input.nonce } : {}),
  });
  if (posted.ok) {
    return { ok: true };
  }
  switch (posted.reason) {
    case "no-access":
      return { ok: false, reason: "no-access" };
    case "cannot-send":
      return { ok: false, reason: "cannot-send" };
    case "slow-mode":
    case "rate-limited":
      return { ok: false, reason: "slow-mode" };
    case "automod":
      return { ok: false, reason: "blocked" };
    default:
      return { ok: false, reason: "unavailable" };
  }
}
