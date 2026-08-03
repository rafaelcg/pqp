import { createHash } from "node:crypto";
import {
  EMBED_DESCRIPTION_MAX_LENGTH,
  EMBED_SITE_NAME_MAX_LENGTH,
  EMBED_TITLE_MAX_LENGTH,
  type Embed,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { FetchTooLargeError, safeFetch, UnsafeUrlError } from "../lib/safe-fetch.js";

/**
 * Link unfurling: pull the first URL out of a message body, fetch it through
 * the SSRF-guarded path in `safe-fetch.ts`, and cache the result by URL so
 * the same link shared in ten channels costs one fetch rather than ten.
 */

/** A page this stale is worth re-fetching — titles and thumbnails do change,
 * and a week is long enough that re-fetching every read would be wasteful. */
const SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A page that just failed is worth trying again sooner than a working one is
 * worth re-fetching — most failures are the origin being briefly down. */
const FAILURE_TTL_MS = 60 * 60 * 1000;

const FETCH_ACCEPT = "text/html,application/xhtml+xml,image/*;q=0.8";

/**
 * Canonicalizes a URL so that `https://Example.com:443/a` and
 * `https://example.com/a#ignored` cache and fetch as the same link instead of
 * two separate rows and two separate outbound requests. `URL` already does
 * the bulk of this for free (lowercases scheme/host, drops a default port,
 * resolves `.`/`..` segments); the fragment is stripped on top since it is
 * never sent to the origin and never affects what gets unfurled. Deliberately
 * not touching query order or a trailing slash on a non-root path — both can
 * be meaningfully different resources on some servers, so this stays a
 * conservative normalization rather than a lossy one.
 */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * The first `http`/`https` URL in a message, or null. Only ever the first:
 * unfurling every link in a message that pastes ten of them would mean ten
 * outbound fetches per message, and Discord and Slack both draw the same
 * line for the same reason.
 *
 * Returned already normalized — this is the single point every URL this
 * module handles passes through, so every other function here can assume its
 * input is already canonical.
 */
export function extractFirstUrl(body: string): string | null {
  const match = /https?:\/\/[^\s<>"']+/.exec(body);
  return match ? normalizeUrl(match[0]) : null;
}

/**
 * A stable cache key that is never itself an unbounded string. `url_hash` is
 * the primary key, so a pathologically long URL (a real thing — query strings
 * with megabytes of base64 in them exist) cannot become the row that trips a
 * btree index entry size limit.
 */
function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

interface EmbedRow {
  url_hash: string;
  url: string;
  kind: "link" | "image";
  title: string | null;
  description: string | null;
  site_name: string | null;
  image_url: string | null;
  image_width: number | null;
  image_height: number | null;
  failed: boolean;
  fetched_at: Date;
}

/**
 * The wire shape. `imageUrl` is never the row's own `image_url` (the origin
 * site's URL) — it is rewritten to this server's own proxy route, so that
 * rendering the embed never sends a viewer's IP to a host they did not choose
 * to visit. The proxy re-fetches through the same SSRF-guarded path as the
 * unfurl itself; see `GET /api/embeds/:urlHash/image` in api/index.ts.
 */
export function toPublicEmbed(row: EmbedRow): Embed {
  return {
    url: row.url,
    kind: row.kind,
    title: row.title,
    description: row.description,
    siteName: row.site_name,
    imageUrl: row.image_url ? `/api/embeds/${row.url_hash}/image` : null,
    imageWidth: row.image_width,
    imageHeight: row.image_height,
  };
}

function isFresh(row: EmbedRow): boolean {
  const age = Date.now() - row.fetched_at.getTime();
  return row.failed ? age < FAILURE_TTL_MS : age < SUCCESS_TTL_MS;
}

/** Read-only: never fetches. Used both by history hydration (which must never
 * block a page load on a network fetch) and by the create path to decide
 * whether a fresh fetch is even needed. */
async function readCachedRow(url: string): Promise<EmbedRow | null> {
  const result = await getPool().query<EmbedRow>(
    `SELECT * FROM link_embeds WHERE url_hash = $1`,
    [hashUrl(url)],
  );
  const row = result.rows[0];
  return row && isFresh(row) ? row : null;
}

export async function getCachedEmbed(url: string): Promise<Embed | null> {
  const row = await readCachedRow(url);
  return row && !row.failed ? toPublicEmbed(row) : null;
}

export interface EmbedCacheState {
  embed: Embed | null;
  /**
   * True whenever a fresh row already exists, success or failed. The create
   * and edit paths must key their "should I fetch this in the background?"
   * decision off this rather than off `embed` alone — `embed` is null both
   * for "nothing cached yet" and for "cached, and it failed a moment ago,"
   * and only the first of those should trigger another outbound fetch.
   * Without this distinction a link that just failed gets re-fetched on
   * every single message that repeats it, defeating `FAILURE_TTL_MS`.
   */
  fresh: boolean;
}

export async function getEmbedCacheState(url: string): Promise<EmbedCacheState> {
  const row = await readCachedRow(url);
  if (!row) {
    return { embed: null, fresh: false };
  }
  return { embed: row.failed ? null : toPublicEmbed(row), fresh: true };
}

/**
 * Batched for a page of messages the same way `listAttachmentsForMessages`
 * and `listReactionsForMessages` already are — one query for the whole page,
 * not one per row, and this table's key is a hash of a URL rather than a
 * message id, so the join is done in application code rather than SQL.
 */
export async function listEmbedsForMessages(
  messages: Array<{ id: string; body: string }>,
): Promise<Map<string, Embed[]>> {
  const byMessage = new Map<string, Embed[]>();
  const urlByMessage = new Map<string, string>();
  const hashes = new Set<string>();
  for (const message of messages) {
    const url = extractFirstUrl(message.body);
    if (url) {
      urlByMessage.set(message.id, url);
      hashes.add(hashUrl(url));
    }
  }
  if (hashes.size === 0) {
    return byMessage;
  }

  const result = await getPool().query<EmbedRow>(
    `SELECT * FROM link_embeds WHERE url_hash = ANY($1::text[])`,
    [[...hashes]],
  );
  const byHash = new Map(result.rows.map((row) => [row.url_hash, row]));

  for (const [messageId, url] of urlByMessage) {
    const row = byHash.get(hashUrl(url));
    if (row && isFresh(row) && !row.failed) {
      byMessage.set(messageId, [toPublicEmbed(row)]);
    }
  }
  return byMessage;
}

const HEAD_SCAN_LIMIT = 200_000;
const META_TAG_PATTERN = /<meta\b[^>]*>/gi;
const ATTR_PATTERN = /([a-zA-Z:_-]+)\s*=\s*"([^"]*)"|([a-zA-Z:_-]+)\s*=\s*'([^']*)'/g;

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
};

/** Minimal, non-throwing entity decoder — OG content is routinely
 * entity-encoded, and rendering `&amp;` literally in a title reads as broken
 * to every viewer for something that is not actually an error. */
function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1]?.toLowerCase() === "x"
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return HTML_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * A tolerant Open Graph / Twitter Card reader, not an HTML parser. Every
 * pattern here is bounded to the text of a single already-matched `<meta>`
 * tag (via `META_TAG_PATTERN`'s `[^>]*`, which cannot backtrack
 * pathologically since it is one character class with no nested
 * quantifiers) rather than run once against the whole document, which is
 * what keeps this safe to run against HTML a stranger controls without a
 * real HTML parser or a headless browser.
 */
function parseMetaTags(html: string): Map<string, string> {
  const found = new Map<string, string>();
  const head = html.slice(0, HEAD_SCAN_LIMIT);
  META_TAG_PATTERN.lastIndex = 0;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = META_TAG_PATTERN.exec(head))) {
    const tag = tagMatch[0];
    const attrs = new Map<string, string>();
    ATTR_PATTERN.lastIndex = 0;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = ATTR_PATTERN.exec(tag))) {
      const name = (attrMatch[1] ?? attrMatch[3])?.toLowerCase();
      const value = attrMatch[2] ?? attrMatch[4] ?? "";
      if (name) {
        attrs.set(name, value);
      }
    }
    const key = (attrs.get("property") ?? attrs.get("name"))?.toLowerCase();
    const content = attrs.get("content");
    // First one wins: a page occasionally repeats a tag (once for Facebook's
    // crawler quirks, once for everyone else) and the first is conventionally
    // the canonical one.
    if (key && content !== undefined && !found.has(key)) {
      found.set(key, decodeEntities(content));
    }
  }
  return found;
}

function truncate(value: string | undefined, max: number): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

interface ParsedPage {
  title: string | null;
  description: string | null;
  siteName: string | null;
  imageUrl: string | null;
}

function parsePage(html: string, pageUrl: string): ParsedPage {
  const tags = parseMetaTags(html);
  const image =
    tags.get("og:image") ?? tags.get("og:image:url") ?? tags.get("twitter:image");
  let imageUrl: string | null = null;
  if (image) {
    try {
      // OG image URLs are frequently relative to the page rather than
      // absolute; resolving against the page's own URL is what a browser
      // does and what the safe-fetch proxy route needs to actually fetch it.
      imageUrl = new URL(image, pageUrl).toString();
    } catch {
      imageUrl = null;
    }
  }
  return {
    title: truncate(
      tags.get("og:title") ?? tags.get("twitter:title"),
      EMBED_TITLE_MAX_LENGTH,
    ),
    description: truncate(
      tags.get("og:description") ?? tags.get("twitter:description"),
      EMBED_DESCRIPTION_MAX_LENGTH,
    ),
    siteName: truncate(tags.get("og:site_name"), EMBED_SITE_NAME_MAX_LENGTH),
    imageUrl,
  };
}

async function upsert(
  url: string,
  fields: Omit<EmbedRow, "url_hash" | "url" | "fetched_at">,
): Promise<EmbedRow> {
  const result = await getPool().query<EmbedRow>(
    `INSERT INTO link_embeds
       (url_hash, url, kind, title, description, site_name, image_url,
        image_width, image_height, failed, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (url_hash) DO UPDATE SET
       kind = EXCLUDED.kind, title = EXCLUDED.title,
       description = EXCLUDED.description, site_name = EXCLUDED.site_name,
       image_url = EXCLUDED.image_url, image_width = EXCLUDED.image_width,
       image_height = EXCLUDED.image_height, failed = EXCLUDED.failed,
       fetched_at = NOW()
     RETURNING *`,
    [
      hashUrl(url),
      url,
      fields.kind,
      fields.title,
      fields.description,
      fields.site_name,
      fields.image_url,
      fields.image_width,
      fields.image_height,
      fields.failed,
    ],
  );
  return result.rows[0]!;
}

async function markFailed(url: string): Promise<null> {
  await upsert(url, {
    kind: "link",
    title: null,
    description: null,
    site_name: null,
    image_url: null,
    image_width: null,
    image_height: null,
    failed: true,
  });
  return null;
}

/**
 * Fetch, parse, and cache one URL. Never throws — every failure mode (a
 * blocked address, a timeout, an oversized body, an unparseable page) ends
 * the same way: a `failed` row, so the same URL is not retried on every
 * message that repeats it inside `FAILURE_TTL_MS`.
 *
 * Deliberately not called from a history read — only from the create/edit
 * path in ws/chat.ts and api/index.ts — so viewing old messages never
 * triggers a network fetch on someone else's behalf.
 */
export async function fetchAndCacheEmbed(url: string): Promise<Embed | null> {
  let response;
  try {
    response = await safeFetch(url, { accept: FETCH_ACCEPT });
  } catch (error) {
    if (!(error instanceof UnsafeUrlError) && !(error instanceof FetchTooLargeError)) {
      console.error(`[embeds] fetch failed for ${url}:`, (error as Error).message);
    }
    return markFailed(url);
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    return markFailed(url);
  }

  const contentType = (response.headers["content-type"] ?? "").split(";")[0]!.trim();

  if (contentType.startsWith("image/")) {
    const row = await upsert(url, {
      kind: "image",
      title: null,
      description: null,
      site_name: null,
      image_url: url,
      image_width: null,
      image_height: null,
      failed: false,
    });
    return toPublicEmbed(row);
  }

  if (!contentType.startsWith("text/html") && !contentType.startsWith("application/xhtml")) {
    // A PDF, a JSON API response, a video — nothing here is unfurlable
    // without a decoder this server does not have, and guessing at the
    // bytes would be the wrong kind of clever.
    return markFailed(url);
  }

  const parsed = parsePage(response.body.toString("utf8"), response.finalUrl);
  if (!parsed.title && !parsed.description && !parsed.imageUrl) {
    // A page with no OG tags at all is not a failure to retry sooner — it is
    // an honest "this page does not describe itself," and re-fetching it
    // every hour would not change that.
    const row = await upsert(url, {
      kind: "link",
      title: null,
      description: null,
      site_name: null,
      image_url: null,
      image_width: null,
      image_height: null,
      failed: false,
    });
    return toPublicEmbed(row);
  }

  const row = await upsert(url, {
    kind: "link",
    title: parsed.title,
    description: parsed.description,
    site_name: parsed.siteName,
    image_url: parsed.imageUrl,
    image_width: null,
    image_height: null,
    failed: false,
  });
  return toPublicEmbed(row);
}

/** For the image-proxy route: the origin URL behind one cached embed, or null
 * if this deployment never cached that hash or has no image for it. */
export async function getEmbedImageUrl(urlHash: string): Promise<string | null> {
  const result = await getPool().query<{ image_url: string | null }>(
    `SELECT image_url FROM link_embeds WHERE url_hash = $1`,
    [urlHash],
  );
  return result.rows[0]?.image_url ?? null;
}
