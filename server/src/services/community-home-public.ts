import {
  BAU_PUBLIC_REDACTED_CHANNEL_ID,
  CHANNEL_REF_PATTERN,
  youtubePosterUrl,
  type PublicBauPost,
  type PublicBauPostResponse,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { isStorageConfigured } from "../lib/s3.js";
import { getPublicCommunity } from "./communities.js";
import {
  bauPublicUrlFor,
  buildMedia,
  postSelectSql,
  type PostRow,
} from "./community-home.js";
import { teaserFromBody } from "./community-home-share.js";

/**
 * A Baú post, read by somebody with no account: `pqp.gg/c/<slug>/p/<postId>`.
 *
 * THE SECOND PUBLIC READ OF A COMMUNITY, and it inherits the first one's
 * posture (`getPublicCommunity`, `servePublicCommunity`): the caller must hold
 * the exact address, nothing here is browsable, and the shape is the defence.
 * What a stranger gets is the post as the feed draws it for a member who has no
 * VIP, minus everything that is a member:
 *
 *   - NO AUTHOR. The row is joined for the shared select and never read. The
 *     Baú has no member-facing author row anyway; the page is the creator.
 *   - NO COMMENTS, NO LIKERS. Counts, which are a fact about the post.
 *   - NO CHANNEL ID. A body may hold `<#channelId>` references; they are
 *     swapped for one that resolves to nothing, so every client still draws
 *     the muted placeholder and nobody is handed an identifier.
 *   - NO LOCKED CONTENT. `bauPublicUrlFor` is the single definition of what
 *     qualifies and it refuses anything that is not published and free.
 *
 * EVERY REFUSAL IS ONE ANSWER. Unknown slug, malformed id, a post of another
 * community under this slug, draft, scheduled, unpublished, deleted,
 * members-only, a server with no public address, a suspended one, Baú off,
 * communities off, the flag off: all of them return `null` from here, and the
 * route turns every `null` into the same 404. A refusal that said which of
 * them it was would tell a stranger holding a guessed id which posts exist and
 * which are VIP.
 */

/**
 * The row behind a public post, or null for every reason there is to refuse.
 * One query keyed on the pair the URL carries, then the shared predicate.
 */
async function loadQualifyingRow(
  slug: string,
  postId: string,
): Promise<PostRow | null> {
  // `$3` is the viewer slot the shared select asks for (liked-by-me, blocked
  // authors). Nobody is viewing, so it is NULL and both read as "no".
  const result = await getPool().query<PostRow>(
    `SELECT ${postSelectSql("$3")}
      WHERE s.community_slug = $1 AND p.id = $2`,
    [slug, postId, null],
  );
  const row = result.rows[0];
  if (!row || bauPublicUrlFor(row) === null) {
    return null;
  }
  return row;
}

/** `<#id>` references out of a body, see the note on `BAU_PUBLIC_REDACTED_CHANNEL_ID`. */
export function redactChannelRefs(text: string): string {
  return text.replace(
    new RegExp(CHANNEL_REF_PATTERN),
    `<#${BAU_PUBLIC_REDACTED_CHANNEL_ID}>`,
  );
}

/** This API's own stable address for a post's picture. Relative, like an icon's. */
function coverPath(slug: string, postId: string): string {
  return `/api/public/communities/${slug}/posts/${postId}/cover`;
}

export async function getPublicBauPost(
  slug: string,
  postId: string,
): Promise<PublicBauPostResponse | null> {
  const row = await loadQualifyingRow(slug, postId);
  if (!row) {
    return null;
  }
  const community = await getPublicCommunity(slug);
  if (!community) {
    return null;
  }

  // `unlocked = true` is the whole point of the free-only rule above: the one
  // thing `buildMedia` withholds is members-only media, and none can be here.
  const media = buildMedia(row, true);
  const posterUrl =
    row.media_kind === "youtube" ? youtubePosterUrl(row.media_youtube_url) : null;

  // A stable picture, for the places that keep a URL longer than a signature
  // lasts. An uploaded image or a video's chosen cover go through the redirect
  // below; a YouTube post already has a public, permanent poster.
  let coverUrl: string | null = null;
  if (posterUrl) {
    coverUrl = posterUrl;
  } else if (
    (media?.kind === "image" && media.url) ||
    (media?.kind === "video" && media.posterUrl)
  ) {
    coverUrl = coverPath(slug, row.id);
  }

  // The teaser is cut from the body with markdown stripped, and the stripping
  // eats the angle brackets of a channel reference and leaves its id behind
  // (`<#id>` becomes `<id`). So it is never cut from the original: channel
  // references are dropped first, in the author's teaser too. A teaser is a
  // summary for a card, and a summary can do without a mention.
  const plain = (text: string | null): string | null =>
    text ? text.replace(new RegExp(CHANNEL_REF_PATTERN), "") : null;
  const teaser = row.teaser?.trim()
    ? plain(row.teaser.trim())
    : teaserFromBody(plain(row.body));
  const post: PublicBauPost = {
    id: row.id,
    title: row.title ? redactChannelRefs(row.title) : null,
    body: row.body ? redactChannelRefs(row.body) : null,
    teaser,
    media,
    posterUrl,
    coverUrl,
    likeCount: Number(row.like_count),
    commentCount: Number(row.comment_count),
    publishedAt: row.published_at?.toISOString() ?? null,
  };
  return { post, community };
}

/**
 * Where `GET …/posts/:postId/cover` sends the browser: a fresh signed GET of
 * the post's picture. Null (a 404) for a post that does not qualify AND for one
 * that qualifies but has no picture of its own, so the two cannot be told
 * apart either.
 */
export async function getPublicBauPostCoverTarget(
  slug: string,
  postId: string,
): Promise<string | null> {
  if (!isStorageConfigured()) {
    return null;
  }
  const row = await loadQualifyingRow(slug, postId);
  if (!row) {
    return null;
  }
  const media = buildMedia(row, true);
  if (media?.kind === "image") {
    return media.url;
  }
  if (media?.kind === "video") {
    return media.posterUrl ?? null;
  }
  return null;
}
