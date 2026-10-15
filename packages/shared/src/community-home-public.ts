import { z } from "zod";
import { communityHomeMediaSchema } from "./community-home.js";
import { COMMUNITY_SLUG_PATTERN, publicCommunitySchema } from "./communities.js";

/**
 * A Baú post's public page: `pqp.gg/c/<slug>/p/<postId>`.
 *
 * The one place a post leaves the members. Everything about WHO may be shown
 * is decided server-side in `services/community-home-public.ts`; this file is
 * the shape the answer is held to and the address it lives at, shared so the
 * web page, the edge middleware's tests and the two phone apps agree on both.
 *
 * What a public post is NOT: it has no author (the Baú has no member-facing
 * author row either; the page is the creator), no comments, no likers, no
 * translation, no subtitles. Counts only, because a count is a fact about the
 * post and a comment is words by a member.
 */

const UUID_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const PUBLIC_POST_PATH_RE = new RegExp(
  `^/c/([^/?#]+)/p/(${UUID_SOURCE})/?$`,
  "i",
);

/** The public address of a post. Always relative; callers add an origin. */
export function bauPublicPostPath(slug: string, postId: string): string {
  return `/c/${slug}/p/${postId.toLowerCase()}`;
}

export type BauPublicPostRef = { slug: string; postId: string };

/**
 * The post a `/c/<slug>/p/<postId>` path names, or null.
 *
 * Shape only. Whether the post is public is the API's answer, and a path that
 * parses here can still be a 404 there. Lowercases both halves: a link typed
 * in capitals must still find the row.
 */
export function parseBauPublicPostPath(pathname: string): BauPublicPostRef | null {
  const match = PUBLIC_POST_PATH_RE.exec(pathname);
  if (!match) {
    return null;
  }
  let slug: string;
  try {
    slug = decodeURIComponent(match[1]!).toLowerCase();
  } catch {
    return null;
  }
  if (!COMMUNITY_SLUG_PATTERN.test(slug)) {
    return null;
  }
  return { slug, postId: match[2]!.toLowerCase() };
}

/**
 * A channel reference no reader can resolve. A public body carries the id of a
 * channel only when everybody in the community can see it (`channels` below);
 * any other is swapped for this one, which the reference grammar still reads as
 * "a channel", so no client has to special-case it and nothing is cut out of the
 * sentence.
 */
export const BAU_PUBLIC_REDACTED_CHANNEL_ID =
  "00000000-0000-0000-0000-000000000000";

/**
 * What a signed-out reader gets of one post.
 *
 * Built from `communityHomeMediaSchema` rather than a second media shape so
 * every client that already draws a Baú card draws this one with the same
 * component. `media.url` and `media.posterUrl` are short-lived signed GETs of
 * the bucket; `coverUrl` is the one STABLE image address, for places that keep
 * a URL longer than a signature lasts (an unfurl card).
 */
export const publicBauPostSchema = z.object({
  id: z.string().uuid(),
  title: z.string().nullable(),
  /** Channel references redacted, see `BAU_PUBLIC_REDACTED_CHANNEL_ID`. */
  body: z.string().nullable(),
  teaser: z.string().nullable(),
  media: communityHomeMediaSchema.nullable(),
  /** The public YouTube poster for a YouTube post, as in the feed. */
  posterUrl: z.string().nullable().default(null),
  /**
   * A stable picture of the post for an unfurl: this API's own
   * `/api/public/communities/<slug>/posts/<id>/cover` path (an image post, or
   * a video with a chosen cover), a YouTube poster, or null.
   */
  coverUrl: z.string().nullable().default(null),
  /**
   * What the API's own cover is, for an unfurl card that wants to say so
   * (`og:image:type` / `width` / `height`) and to choose a large card or a small
   * one. Each is null when it is not known, and all four are null for a cover
   * that is not ours (a YouTube poster) or when the bucket was slow to answer:
   * a consumer must treat null as "unknown", never as "wrong".
   * `coverType` and the two sizes are read from the picture's own header, not
   * from what the uploader declared; `coverBytes` is the object's size.
   */
  coverType: z.string().nullable().default(null),
  coverWidth: z.number().int().positive().nullable().default(null),
  coverHeight: z.number().int().positive().nullable().default(null),
  coverBytes: z.number().int().nonnegative().nullable().default(null),
  likeCount: z.number().int().nonnegative(),
  commentCount: z.number().int().nonnegative(),
  publishedAt: z.string().nullable(),
  /**
   * The channels a body mentions that EVERYBODY in the community can see
   * (`@everyone` has VIEW_CHANNEL there), by the id the body carries. A mention
   * of any other channel is redacted to `BAU_PUBLIC_REDACTED_CHANNEL_ID` and is
   * absent here, so a staff-only channel's name is never published.
   */
  channels: z
    .array(z.object({ id: z.string().uuid(), name: z.string() }))
    .default([]),
  /**
   * This post's own address, from the same function that hands `publicUrl` to
   * members, so the page shares the canonical origin and not whichever host it
   * happens to be opened on.
   */
  publicUrl: z.string().nullable().default(null),
});

export type PublicBauPost = z.infer<typeof publicBauPostSchema>;

/** `GET /api/public/communities/:slug/posts/:postId` */
export const publicBauPostResponseSchema = z.object({
  post: publicBauPostSchema,
  /** The community poster for the CTA block. Same shape as the community page. */
  community: publicCommunitySchema,
});

export type PublicBauPostResponse = z.infer<typeof publicBauPostResponseSchema>;

/**
 * How long a signed media GET on the public page lives. Short on purpose: a
 * post that stops being public (made members-only, unpublished) leaves the
 * page and the cover redirect at once, and a signature minted a moment before
 * must not keep serving it for the 12 hours a member's feed gets. The cost is
 * that a tab left open longer than this cannot seek in a video until reloaded.
 */
export const BAU_PUBLIC_MEDIA_TTL_SECONDS = 10 * 60;

/** The networks the Compartilhar menu offers, plus the two that are not one. */
export const BAU_SHARE_SOURCES = [
  "x",
  "reddit",
  "whatsapp",
  "telegram",
  "copy",
  "native",
] as const;

export type BauShareSource = (typeof BAU_SHARE_SOURCES)[number];

/**
 * The public link with the campaign the acquisition capture reads
 * (`?utm_source=<network>&utm_medium=share&utm_campaign=bau`). `copy` is the
 * copy-link button and `native` the OS share sheet, where the app that was
 * picked is not ours to know.
 */
export function bauShareUrl(publicUrl: string, source: BauShareSource): string {
  const url = new URL(publicUrl);
  url.searchParams.set("utm_source", source);
  url.searchParams.set("utm_medium", "share");
  url.searchParams.set("utm_campaign", "bau");
  return url.toString();
}
