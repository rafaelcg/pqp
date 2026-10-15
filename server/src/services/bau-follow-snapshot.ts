import { createHash } from "node:crypto";
import {
  FORWARD_VERSION,
  bauPostPath,
  forwardFallbackBody,
  messageForwardSchema,
  youtubePosterUrl,
  type MessageForward,
} from "@pqp/shared";
import { forwardExcerpt } from "./forwards.js";

/**
 * The forward card a followed Baú post is delivered as: a SNAPSHOT of the post
 * at delivery time, stored on the message (`messages.forward`), never a live
 * read. This is the `bau_post` kind of the shared forward contract; the shape
 * is `messageForwardSchema` in `@pqp/shared` (Part 1, Encaminhar).
 *
 * Mentions inside the post are plain text in the excerpt and are never
 * re-resolved: nothing here can ping anybody. The only ping a delivery ever
 * carries is the follow's own role ping, recorded separately.
 */

export interface PostForSnapshot {
  id: string;
  server_id: string;
  title: string | null;
  body: string;
  teaser: string | null;
  media_kind:
    | "image"
    | "video"
    | "youtube"
    | "twitch"
    | "tiktok"
    | "instagram"
    | "file"
    | null;
  media_youtube_url: string | null;
  published_at: Date | null;
  created_at: Date;
}

export interface SourceForSnapshot {
  id: string;
  name: string;
  icon_url: string | null;
}

/** The `bau_post` snapshot of the shared forward contract (`messageForwardSchema`). */
export type BauPostSnapshot = MessageForward;

/** Where a card's link points. The hosted app unless the deployment says otherwise. */
export function bauFollowAppOrigin(): string {
  const configured = process.env.PUBLIC_APP_URL?.split(",")[0]?.trim();
  return (configured || "https://pqp.gg").replace(/\/+$/, "");
}

function mediaKindFor(post: PostForSnapshot): BauPostSnapshot["mediaKind"] | undefined {
  switch (post.media_kind) {
    case "image":
    case "video":
    case "youtube":
      return post.media_kind;
    case "twitch":
    case "tiktok":
    case "instagram":
      return "embed";
    default:
      // A file (a PDF) has no picture to show.
      return undefined;
  }
}

/**
 * The picture on the card. Only a URL that outlives the delivery: a YouTube
 * poster is public and permanent, an uploaded file is a signed link that
 * expires, so it is never copied into a snapshot (the card is a text card with
 * the kind of media it leads to).
 */
function thumbFor(post: PostForSnapshot): string | undefined {
  if (post.media_kind === "youtube" && post.media_youtube_url) {
    return youtubePosterUrl(post.media_youtube_url) ?? undefined;
  }
  return undefined;
}

export function buildBauPostSnapshot(
  post: PostForSnapshot,
  source: SourceForSnapshot,
  options: {
    origin?: string;
    /**
     * The post's public page (`getBauPublicUrl`, Part 2), when it has one: a
     * follower who is not a member of the source opens a real page instead of
     * an in-app address that is a dead end for them. Null keeps the in-app one.
     */
    publicUrl?: string | null;
  } = {},
): BauPostSnapshot {
  const origin = options.origin ?? bauFollowAppOrigin();
  const title = post.title?.trim() || undefined;
  const excerptSource = post.teaser?.trim() || post.body;
  const excerpt = forwardExcerpt(excerptSource);
  const mediaKind = mediaKindFor(post);
  const thumb = thumbFor(post);
  // Parsed through the contract: a card this build cannot read back is a bug
  // here, not a message nobody can render.
  return messageForwardSchema.parse({
    v: FORWARD_VERSION,
    kind: "bau_post",
    sourceServerId: source.id,
    sourceServerName: source.name,
    sourceServerIconUrl: source.icon_url,
    sourceId: post.id,
    ...(title ? { title } : {}),
    excerpt,
    ...(thumb ? { mediaThumbUrl: thumb } : {}),
    ...(mediaKind ? { mediaKind } : {}),
    url: options.publicUrl ?? `${origin}${bauPostPath(post.server_id, post.id)}`,
    createdAt: (post.published_at ?? post.created_at).toISOString(),
  });
}

/** Stable across key order, so an unchanged post never reads as edited. */
export function snapshotHash(snapshot: BauPostSnapshot): string {
  const ordered = Object.fromEntries(
    Object.entries(snapshot).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

/**
 * What an old client, which knows nothing of `forward`, shows for the message,
 * and what a new one hides: the contract's own fallback line.
 */
export function followFallbackBody(snapshot: BauPostSnapshot): string {
  return forwardFallbackBody(snapshot);
}

/**
 * The message body of a delivery: the fallback line, and when the follow pings a
 * role, the mention alone on the line above it. A client that draws the card
 * strips the fallback (`forwardBodyComment` in `@pqp/shared`) and keeps the
 * mention; an old client reads a mention, then a title and a link.
 */
export function followBody(snapshot: BauPostSnapshot, rolePingName: string | null): string {
  const fallback = followFallbackBody(snapshot);
  return rolePingName ? `@${rolePingName.replace(/\s+/g, "")}\n${fallback}` : fallback;
}

/** A card with nothing to show (no title, no text, no media) is not delivered. */
export function snapshotIsEmpty(snapshot: BauPostSnapshot): boolean {
  return !snapshot.title && !snapshot.excerpt && !snapshot.mediaKind;
}
