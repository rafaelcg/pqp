import {
  BAU_PUBLIC_MEDIA_TTL_SECONDS,
  BAU_PUBLIC_REDACTED_CHANNEL_ID,
  CHANNEL_REF_PATTERN,
  youtubePosterUrl,
  type PublicBauPost,
  type PublicBauPostResponse,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { isStorageConfigured } from "../lib/s3.js";
import { toPublicCommunity, type PublicCommunityRow } from "./communities.js";
import {
  bauPublicUrlFor,
  buildMedia,
  postSelectSql,
  type PostRow,
} from "./community-home.js";
import { peekCoverInfo } from "./community-home-cover-info.js";
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
 *   - CHANNEL MENTIONS NAME ONLY WHAT EVERYBODY CAN SEE. A body may hold
 *     `<#channelId>` references. One to a channel `@everyone` can view (the
 *     usual #geral) keeps its id and travels with its name in `channels`; any
 *     other is swapped for an id that resolves to nothing, so a staff-only
 *     channel's name is never published and every client still draws "a
 *     channel" instead of an error.
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
): Promise<(PostRow & PublicCommunityRow) | null> {
  // `$3` is the viewer slot the shared select asks for (liked-by-me, blocked
  // authors). Nobody is viewing, so it is NULL and both read as "no".
  //
  // THE POSTER RIDES THE SAME STATEMENT (the `pc_` aliases, put back under
  // their own names below): a shared link and an unfurl fetch both land here,
  // and a second serial query on every cache miss is latency for nothing. The
  // post's own columns keep their names; only the ones that collide are aliased.
  const result = await getPool().query<
    PostRow & Record<`pc_${string}`, unknown>
  >(
    `SELECT ${postSelectSql(
      "$3",
      `s.name AS pc_name, s.community_tagline AS pc_tagline,
       s.community_about AS pc_about, s.community_links AS pc_links,
       s.community_featured_kind AS pc_featured_kind,
       s.community_featured_embed_url AS pc_featured_embed_url,
       s.community_featured_url AS pc_featured_url,
       s.community_category AS pc_category, s.member_count AS pc_member_count,
       s.icon_url AS pc_icon_url, s.banner_url AS pc_banner_url,
       s.created_at AS pc_created_at`,
    )}
      WHERE s.community_slug = $1 AND p.id = $2`,
    [slug, postId, null],
  );
  const row = result.rows[0];
  if (!row || bauPublicUrlFor(row) === null) {
    return null;
  }
  return {
    ...row,
    // `row.id` is the POST's; the community's id is the post's `server_id`.
    id: row.id,
    name: row.pc_name as string,
    community_slug: row.community_slug as string,
    community_tagline: row.pc_tagline as string | null,
    community_about: row.pc_about as string | null,
    community_links: row.pc_links,
    community_featured_kind: row.pc_featured_kind as string | null,
    community_featured_embed_url: row.pc_featured_embed_url as string | null,
    community_featured_url: row.pc_featured_url as string | null,
    community_category: row.pc_category as PublicCommunityRow["community_category"],
    member_count: row.pc_member_count as number,
    icon_url: row.pc_icon_url as string | null,
    banner_url: row.pc_banner_url as string | null,
    created_at: row.pc_created_at as Date,
  };
}

/**
 * A fresh, GLOBAL, case-insensitive copy of the reference pattern: `matchAll`
 * refuses a non-global one, and a shared global regex carries `lastIndex`
 * between uses. Spelled out rather than cloned from `CHANNEL_REF_PATTERN`'s
 * flags so the property is on this line.
 */
function refPattern(): RegExp {
  return new RegExp(CHANNEL_REF_PATTERN.source, "gi");
}

/**
 * `<#id>` references of a body: kept for a channel everybody can see, swapped
 * for `BAU_PUBLIC_REDACTED_CHANNEL_ID` for every other.
 */
export function redactChannelRefs(
  text: string,
  visible: ReadonlyMap<string, string> = new Map(),
): string {
  return text.replace(refPattern(), (_all, id: string) => {
    const lower = id.toLowerCase();
    return `<#${visible.has(lower) ? lower : BAU_PUBLIC_REDACTED_CHANNEL_ID}>`;
  });
}

/** Every channel id a set of texts mentions. */
function mentionedChannelIds(texts: ReadonlyArray<string | null>): string[] {
  const ids = new Set<string>();
  for (const text of texts) {
    for (const match of (text ?? "").matchAll(refPattern())) {
      ids.add(match[1]!.toLowerCase());
    }
  }
  return [...ids];
}

/**
 * Of the channels a post mentions, the ones EVERYBODY in the community can see
 * (id to name). The question a stranger's page has to ask is not "may this
 * viewer see it" (there is no viewer) but "could the most ordinary member", so
 * it is `@everyone`'s own permissions with the channel's `@everyone` overwrite
 * applied, the same arithmetic as `channel_viewable` without a person in it:
 * a private channel carries a deny overwrite for `@everyone`, so it fails here
 * with no special case. Only real server channels count (not threads or DMs),
 * and only ones of THIS server, so an id from elsewhere resolves to nothing.
 */
async function everyoneVisibleChannels(
  serverId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const visible = new Map<string, string>();
  if (ids.length === 0) {
    return visible;
  }
  const { rows } = await getPool().query<{ id: string; name: string }>(
    `SELECT c.id, c.name
       FROM channels c
       JOIN roles er ON er.server_id = c.server_id AND er.is_everyone
       LEFT JOIN channel_overwrites o
              ON o.channel_id = c.id
             AND o.target_type = 'role'
             AND o.target_id = er.id
      WHERE c.id = ANY($1::uuid[])
        AND c.server_id = $2
        AND c.kind = 'server'
        AND (
          (er.permissions & 8) <> 0
          OR (((er.permissions & ~COALESCE(o.deny, 0)) | COALESCE(o.allow, 0)) & 64) <> 0
        )`,
    [ids, serverId],
  );
  for (const row of rows) {
    visible.set(row.id.toLowerCase(), row.name);
  }
  return visible;
}

/**
 * Text for a card (teaser, Open Graph): `#name` where the channel is visible to
 * everybody, "um canal" where it is not, so the sentence still reads. A
 * private-use marker carries the mention through `teaserFromBody`, whose
 * markdown stripping would otherwise eat the `#` (and the brackets of the
 * reference, leaving the id behind as `<id`).
 */
const MARK_OPEN = "\uE000";
const MARK_CLOSE = "\uE001";

function markMentions(text: string, ids: string[]): string {
  return text.replace(
    refPattern(),
    (_all, id: string) => `${MARK_OPEN}${ids.indexOf(id.toLowerCase())}${MARK_CLOSE}`,
  );
}

function resolveMarks(
  text: string,
  ids: string[],
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
    // A cut that landed inside a marker leaves half of one.
    .replace(new RegExp(`${MARK_OPEN}\\d*(?:${MARK_CLOSE})?`, "g"), "");
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
  // The community's id (what the live-preview flag is asked about) is the
  // post's `server_id`; the row's own `id` is the post's.
  const community = toPublicCommunity({ ...row, id: row.server_id });

  // `unlocked = true` is the whole point of the free-only rule above: the one
  // thing `buildMedia` withholds is members-only media, and none can be here.
  const media = buildMedia(row, true, BAU_PUBLIC_MEDIA_TTL_SECONDS);
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

  // What the share card needs to know about our own cover before it is asked
  // to fetch it. Never blocks the page: see `coverFacts`.
  const facts = await coverFacts(row, media);

  // Which of the mentioned channels everybody can see. One query, and only when
  // a mention exists at all.
  const ids = mentionedChannelIds([row.title, row.body, row.teaser]);
  // FAIL CLOSED, NOT DOWN: if the lookup fails, every mention is redacted (the
  // safe answer for a page that publishes names) and the post is still served.
  // A mention is garnish; a transient error on a second query must not turn a
  // shared link into an API failure.
  let visible = new Map<string, string>();
  try {
    visible = await everyoneVisibleChannels(row.server_id, ids);
  } catch (error) {
    console.error(
      "[bau-public] channel lookup failed, redacting mentions:",
      error instanceof Error ? error.message : error,
    );
  }

  // The teaser is cut from the body with markdown stripped, which eats the
  // brackets of a channel reference and the `#` of its name. So mentions are
  // marked first and resolved after the cut (`markMentions`), and an author's
  // own teaser, which is shown as written, is resolved directly.
  const authorTeaser = row.teaser?.trim();
  const teaser = authorTeaser
    ? resolveMarks(markMentions(authorTeaser, ids), ids, visible)
    : (() => {
        const cut = teaserFromBody(row.body ? markMentions(row.body, ids) : null);
        return cut ? resolveMarks(cut, ids, visible) : null;
      })();
  const redact = (text: string | null): string | null =>
    text ? redactChannelRefs(text, visible) : null;
  const post: PublicBauPost = {
    id: row.id,
    title: redact(row.title),
    body: redact(row.body),
    teaser,
    media,
    posterUrl,
    coverUrl,
    coverType: facts?.type ?? null,
    coverWidth: facts?.width ?? null,
    coverHeight: facts?.height ?? null,
    coverBytes: facts?.bytes ?? null,
    likeCount: Number(row.like_count),
    commentCount: Number(row.comment_count),
    publishedAt: row.published_at?.toISOString() ?? null,
    channels: ids
      .filter((id) => visible.has(id))
      .map((id) => ({ id, name: visible.get(id)! })),
    publicUrl: bauPublicUrlFor(row),
  };
  return { post, community };
}

/**
 * The object a post's cover is, and where a signed copy of it lives. Null (a
 * 404) for a post that does not qualify AND for one that qualifies but has no
 * picture of its own, so the two cannot be told apart either.
 *
 * `key` is the bucket key, which is IMMUTABLE: a replaced picture is a new
 * upload with a new key (both columns are unique per claimed upload), so a
 * validator derived from it can never name two different pictures. `signedUrl`
 * is what the route redirects to when it will not serve the bytes itself.
 */
export interface PublicBauCover {
  key: string;
  signedUrl: string;
}

function coverOf(
  row: PostRow,
  media: ReturnType<typeof buildMedia>,
): PublicBauCover | null {
  // `buildMedia` is what decides a cover exists (storage configured, the
  // custom-cover flag for a video's poster); the key is read from the row only
  // once it has said so, so this cannot disagree with `coverUrl` above.
  if (media?.kind === "image" && media.url && row.media_storage_key) {
    return { key: row.media_storage_key, signedUrl: media.url };
  }
  if (media?.kind === "video" && media.posterUrl && row.poster_storage_key) {
    return { key: row.poster_storage_key, signedUrl: media.posterUrl };
  }
  return null;
}

export async function getPublicBauPostCover(
  slug: string,
  postId: string,
): Promise<PublicBauCover | null> {
  if (!isStorageConfigured()) {
    return null;
  }
  const row = await loadQualifyingRow(slug, postId);
  if (!row) {
    return null;
  }
  return coverOf(row, buildMedia(row, true, BAU_PUBLIC_MEDIA_TTL_SECONDS));
}

/**
 * How long the post page waits for the bucket to describe its cover. The page
 * is the product and the dimensions are a hint for an unfurler: past this the
 * card is built without them, exactly as before this existed. Only a COLD cover
 * pays it (the answer is remembered per storage key, see
 * `community-home-cover-info.ts`), and it is the first scrape of a link that
 * the hint exists for, so a wait on a miss is deliberate and a short one.
 */
const COVER_FACTS_BUDGET_MS = 1000;

interface CoverFacts {
  type: string | null;
  width: number | null;
  height: number | null;
  bytes: number;
}

/**
 * The size, format and pixels of this post's own cover, for `og:image:width`,
 * `height` and `type` and for the decision between a large card and a small one.
 * Null for a cover that is not ours (a YouTube poster), for a post with none,
 * and for ANY failure or a slow bucket: it fails OPEN, because a share card
 * without dimensions is what every card was until now, and a post page that
 * errors or stalls over a hint is worse than a card with no hint. Giving up
 * also cancels the bucket requests (see `peekCoverInfo`).
 */
async function coverFacts(
  row: PostRow,
  media: ReturnType<typeof buildMedia>,
): Promise<CoverFacts | null> {
  const cover = coverOf(row, media);
  if (!cover) {
    return null;
  }
  const info = await peekCoverInfo(cover.key, COVER_FACTS_BUDGET_MS);
  if (!info) {
    return null;
  }
  return {
    type: info.image?.type ?? null,
    width: info.image?.width ?? null,
    height: info.image?.height ?? null,
    bytes: info.length,
  };
}

/**
 * The public address of a post BY ID, or null when it has none: the helper for
 * anything that wants to LINK the public page from the server side (a followed
 * Baú's delivery card, a forward card) without reading the post's body. It asks
 * the one predicate (`bauPublicUrlFor`) about the post as it is NOW, so a
 * delivery made while the flag is on links the page and one made after a post
 * went members-only, was unpublished or deleted does not. Null for every
 * reason there is not to link, a failed query included (logged): it never
 * throws, so the caller's fallback is always reachable.
 *
 * A caller that already holds the post row should call `bauPublicUrlFor`
 * directly and skip the query.
 */
export async function getBauPublicUrl(
  serverId: string,
  postId: string,
): Promise<string | null> {
  // Ids from callers are uuids; anything else is "no page", not a database error.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(serverId) || !uuid.test(postId)) {
    return null;
  }
  try {
    const { rows } = await getPool().query<
      Pick<
        PostRow,
        | "id"
        | "server_id"
        | "status"
        | "visibility"
        | "is_community"
        | "is_community_suspended"
        | "community_slug"
        | "community_home_enabled"
      >
    >(
      `SELECT p.id, p.server_id, p.status, p.visibility,
              s.is_community, s.is_community_suspended, s.community_slug,
              s.community_home_enabled
         FROM community_home_posts p
         JOIN servers s ON s.id = p.server_id
        WHERE p.id = $1 AND p.server_id = $2`,
      [postId, serverId],
    );
    const row = rows[0];
    return row ? bauPublicUrlFor(row) : null;
  } catch (error) {
    // A transient database failure is "no page" to the caller, who then links
    // the in-app permalink: a delivery must never fail over a nicety.
    console.error(
      "[bau-public] could not resolve the public url:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
