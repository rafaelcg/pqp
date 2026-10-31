import {
  BAU_CARD_TEASER_MAX,
  bauPostPath,
  CHANNEL_REF_PATTERN,
  type CommunityHomeLatestResponse,
  type CommunityHomePost,
  type CommunityHomePostCard,
} from "@pqp/shared";
import type { DbUser } from "../db.js";
import { getPool } from "../db.js";
import { postChannelMessage } from "../ws/chat.js";
import {
  CommunityHomeError,
  getCommunityHomePost,
  listLatestCommunityHomePosts,
} from "./community-home.js";
import { getChannel } from "./servers.js";
import { channelVisibleSql } from "./users.js";

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

/**
 * `<#channelId>` references in a card's words.
 *
 * A post stores a channel link as `<#uuid>`, and `teaserFromBody` strips
 * markdown, which eats the `#` and the closing `>` and leaves the id behind
 * (`no <ed0870d1-...`). So a reference is swapped for a private-use marker
 * BEFORE the cut and resolved AFTER it (`markChannelRefs`,
 * `resolveChannelMarks`); the name is the channel's current one, and a channel
 * the reader cannot see is "um canal", so the sentence still reads and a
 * private name never travels. A cut that lands inside a marker drops the half.
 * The public Baú page uses the same two functions.
 */
const MARK_OPEN = "";
const MARK_CLOSE = "";

/** A fresh global copy: `matchAll` refuses a non-global one, `lastIndex` is shared state. */
export function channelRefPattern(): RegExp {
  return new RegExp(CHANNEL_REF_PATTERN.source, "gi");
}

/** Every channel id a set of texts mentions, lowercased, once each. */
export function mentionedChannelIds(
  texts: ReadonlyArray<string | null | undefined>,
): string[] {
  const ids = new Set<string>();
  for (const text of texts) {
    for (const match of (text ?? "").matchAll(channelRefPattern())) {
      ids.add(match[1]!.toLowerCase());
    }
  }
  return [...ids];
}

export function markChannelRefs(text: string, ids: readonly string[]): string {
  return text.replace(
    channelRefPattern(),
    (_all, id: string) => `${MARK_OPEN}${ids.indexOf(id.toLowerCase())}${MARK_CLOSE}`,
  );
}

export function resolveChannelMarks(
  text: string,
  ids: readonly string[],
  visible: ReadonlyMap<string, string>,
): string {
  return text
    .replace(
      new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, "g"),
      (_all, index: string) => {
        const name = visible.get(ids[Number(index)] ?? "");
        return name ? `#${name}` : "um canal";
      },
    )
    .replace(new RegExp(`${MARK_OPEN}\\d*(?:${MARK_CLOSE})?`, "g"), "");
}

/**
 * Of the channels a post mentions, the ones THIS VIEWER may see (id to name).
 * The viewer's own `channelVisibleSql`, the predicate chat uses, so a private
 * channel they are not in resolves to nothing. Only real server channels of
 * this server count. Never cached: a card is built per viewer, and a shared
 * value would bake one person's permissions into another's card.
 */
export async function viewerVisibleChannelNames(
  serverId: string,
  viewerId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const visible = new Map<string, string>();
  if (ids.length === 0) {
    return visible;
  }
  try {
    const { rows } = await getPool().query<{ id: string; name: string }>(
      `SELECT c.id, c.name
         FROM channels c
         LEFT JOIN server_members sm
           ON sm.server_id = c.server_id AND sm.user_id = $3
        WHERE c.id = ANY($1::uuid[])
          AND c.server_id = $2
          AND c.kind = 'server'
          AND c.type <> 'thread'
          AND ${channelVisibleSql("$3")}`,
      [[...ids], serverId, viewerId],
    );
    for (const row of rows) {
      visible.set(row.id.toLowerCase(), row.name);
    }
  } catch (error) {
    // A mention is garnish: when the lookup fails every one reads "um canal"
    // (the safe answer) and the card is still served.
    console.error(
      "[bau-card] channel lookup failed, hiding mentions:",
      error instanceof Error ? error.message : error,
    );
  }
  return visible;
}

/** The channel ids a card's words (title, teaser, and the body it is cut from) mention. */
function cardChannelIds(post: CommunityHomePost): string[] {
  return mentionedChannelIds([
    post.title,
    post.teaser,
    post.locked ? null : post.body,
  ]);
}

/** The viewer's visible names for every channel these posts' cards mention. One query. */
async function channelsForCards(
  serverId: string,
  viewerId: string,
  posts: readonly CommunityHomePost[],
): Promise<Map<string, string>> {
  const ids = [...new Set(posts.flatMap(cardChannelIds))];
  return viewerVisibleChannelNames(serverId, viewerId, ids);
}

/** Pure projection of a feed post into the small card. Exported for tests. */
export function toPostCard(
  post: CommunityHomePost,
  serverName: string,
  /** Channels the viewer can see (id to name); absent means none, so every mention reads "um canal". */
  channels: ReadonlyMap<string, string> = new Map(),
): CommunityHomePostCard {
  let mediaKind: CommunityHomePostCard["mediaKind"] = null;
  let mediaUrl: string | null = null;
  // The author's cover of an uploaded video. It lives inside `media`, so a
  // locked reader, who gets no media, never gets it here either.
  let posterUrl: string | null = null;
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
    }
    if (post.media.kind === "video") {
      posterUrl = post.media.posterUrl ?? null;
    } else if (post.media.kind === "youtube") {
      mediaUrl = post.posterUrl;
    }
  }
  const ids = cardChannelIds(post);
  // Marked before the cut, resolved after (see `markChannelRefs`).
  const marked = (text: string | null | undefined) =>
    text ? markChannelRefs(text, ids) : null;
  const rawTeaser = post.locked
    ? marked(post.teaser)
    : (marked(post.teaser?.trim()) || teaserFromBody(marked(post.body)));
  const cutTeaser = rawTeaser ? teaserFromBody(rawTeaser) : null;
  const teaser = cutTeaser ? resolveChannelMarks(cutTeaser, ids, channels) : null;
  const title = post.title
    ? resolveChannelMarks(markChannelRefs(post.title, ids), ids, channels)
    : post.title;
  return {
    postId: post.id,
    serverId: post.serverId,
    serverName,
    title,
    teaser: teaser || null,
    author: post.locked
      ? null
      : {
          id: post.author.id,
          displayName: post.author.displayName,
          avatarUrl: post.author.avatarUrl,
        },
    mediaKind,
    mediaUrl,
    posterUrl,
    visibility: post.visibility,
    locked: post.locked,
    pinned: post.pinned,
    likeCount: post.likeCount,
    commentCount: post.commentCount,
    publishedAt: post.publishedAt,
    publicUrl: post.publicUrl ?? null,
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
  return toPostCard(
    post,
    row.name,
    await channelsForCards(serverId, viewerId, [post]),
  );
}

/**
 * `GET …/home/latest`: the newest published posts as cards, each with `isNew`,
 * plus the unread count and the read stamp. Same gate as the single card (a
 * server whose owner switched the Baú off is a 404), and every card is built
 * by `toPostCard`, so a locked post comes back without author or media exactly
 * as it does in chat.
 */
export async function listLatestCommunityHomeCards(
  serverId: string,
  viewerId: string,
  limit: number,
  lang?: string | null,
): Promise<CommunityHomeLatestResponse> {
  const server = await getPool().query<{
    name: string;
    community_home_enabled: boolean | null;
  }>(`SELECT name, community_home_enabled FROM servers WHERE id = $1`, [
    serverId,
  ]);
  const row = server.rows[0];
  if (!row || row.community_home_enabled !== true) {
    throw new CommunityHomeError("not_found", "Not found");
  }
  const latest = await listLatestCommunityHomePosts(
    serverId,
    viewerId,
    limit,
    lang,
  );
  const channels = await channelsForCards(
    serverId,
    viewerId,
    latest.posts.map(({ post }) => post),
  );
  return {
    unread: latest.unread,
    lastSeenAt: latest.lastSeenAt,
    posts: latest.posts.map(({ post, isNew }) => ({
      ...toPostCard(post, row.name, channels),
      isNew,
    })),
  };
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
