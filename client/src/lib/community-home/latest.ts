import type {
  CommunityHomeLatestCard,
  CommunityHomeLatestResponse,
} from "@pqp/shared";
import {
  ApiError,
  fetchCommunityHomeLatest,
  fetchCommunityHomeUnread,
} from "@/lib/api";

/**
 * The Baú preview in the channel list (`GET …/home/latest`).
 *
 * One read answers both the badge and the card: `unread` is the number the
 * row has always shown, and each post says whether it is new by the same rule.
 * While the server has the preview off (runtime flag `bau_latest_preview`,
 * per server) the route is 404 and this falls back to `…/home/unread`, so the
 * row looks exactly as it did before the preview existed.
 */

/** One post of the preview: the chat card (cover in `posterUrl`) plus `isNew`. */
export type LatestCard = CommunityHomeLatestCard;

export type LatestPreview = CommunityHomeLatestResponse;

/** After a 404, how long to ask `…/home/unread` instead before trying again. */
export const LATEST_OFF_RETRY_MS = 5 * 60_000;

const offUntil = new Map<string, number>();

export function __resetLatestPreviewCache(): void {
  offUntil.clear();
}

export type BauRowRead = {
  count: number;
  /** When the newest unread post went live, for the 24 h "New" chip. */
  newestAt: string | null;
  /** Null: the preview is off (or this API predates it); draw the plain row. */
  latest: LatestPreview | null;
};

/** When the newest post that counts as unread went live, or null. */
export function newestUnreadAt(latest: LatestPreview): string | null {
  return latest.posts.find((post) => post.isNew)?.publishedAt ?? null;
}

/**
 * The read behind the Baú row: the preview when the server has it, the bare
 * count otherwise. Throws what the unread read throws (the Baú off, a blip).
 */
export async function readBauRow(
  serverId: string,
  lang?: string,
  now: () => number = Date.now,
): Promise<BauRowRead> {
  const until = offUntil.get(serverId);
  if (until === undefined || now() >= until) {
    try {
      const latest = await fetchCommunityHomeLatest(serverId, lang);
      offUntil.delete(serverId);
      return { count: latest.unread, newestAt: newestUnreadAt(latest), latest };
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) {
        throw error;
      }
      offUntil.set(serverId, now() + LATEST_OFF_RETRY_MS);
    }
  }
  const { count, newestAt } = await fetchCommunityHomeUnread(serverId);
  return { count, newestAt: newestAt ?? null, latest: null };
}

/**
 * The preview as it is once the person has opened the Baú: nothing is new any
 * more, the posts stay (the row keeps showing the last one). Same object when
 * there was nothing to change, so React skips the render.
 */
export function markLatestSeen(latest: LatestPreview | null): LatestPreview | null {
  if (!latest || (latest.unread === 0 && latest.posts.every((post) => !post.isNew))) {
    return latest;
  }
  return {
    ...latest,
    unread: 0,
    lastSeenAt: new Date().toISOString(),
    posts: latest.posts.map((post) => (post.isNew ? { ...post, isNew: false } : post)),
  };
}

export type BauPreviewMode =
  /** Something new: the card with the cover. */
  | "card"
  /** Seen: the slim row with the last post's thumbnail. */
  | "row"
  /** Nothing posted yet, and this person can post: the invite. */
  | "empty-staff"
  /** Nothing posted yet: the quiet row. */
  | "empty";

export function bauPreviewMode(
  latest: Pick<LatestPreview, "posts">,
  canPost: boolean,
): BauPreviewMode {
  const lead = latest.posts[0];
  if (!lead) {
    return canPost ? "empty-staff" : "empty";
  }
  return latest.posts.some((post) => post.isNew) ? "card" : "row";
}

/**
 * The post the card leads with: the newest one that is new. The newest post
 * overall can be the viewer's own, which is never new, and leading with it
 * would hide the post the badge is counting.
 */
export function leadPost(latest: Pick<LatestPreview, "posts">): LatestCard | null {
  return latest.posts.find((post) => post.isNew) ?? latest.posts[0] ?? null;
}

/** The other new posts, for the card's "+N new" footer. */
export function otherNewPosts(
  latest: Pick<LatestPreview, "posts" | "unread">,
  lead: LatestCard | null,
): { first: LatestCard | null; count: number } {
  const others = latest.posts.filter((post) => post.isNew && post !== lead);
  // `unread` counts past the LIMIT; the posts only go as far as it.
  const count = Math.max(others.length, latest.unread - (lead?.isNew ? 1 : 0));
  return { first: others[0] ?? null, count };
}

export type CoverSource =
  | { kind: "image"; url: string }
  /** No picture we may load cheaply: a plate in the server's colour. */
  | { kind: "plate" };

/**
 * What goes in the cover slot. An image post is its own picture, YouTube its
 * public poster, an uploaded video its chosen cover. A video without one, and
 * Twitch / TikTok / Instagram, get the plate: the sidebar must never download
 * video bytes (`<video preload>`) just to paint a thumbnail.
 */
export function coverSource(card: LatestCard): CoverSource {
  if (card.mediaKind === "image" && card.mediaUrl) {
    return { kind: "image", url: card.mediaUrl };
  }
  if (card.mediaKind === "youtube" && card.mediaUrl) {
    return { kind: "image", url: card.mediaUrl };
  }
  if (card.mediaKind === "video" && card.posterUrl) {
    return { kind: "image", url: card.posterUrl };
  }
  return { kind: "plate" };
}

const PLAYABLE = new Set(["video", "youtube", "twitch", "tiktok", "instagram"]);

export function isPlayable(card: Pick<LatestCard, "mediaKind">): boolean {
  return card.mediaKind !== null && PLAYABLE.has(card.mediaKind);
}
