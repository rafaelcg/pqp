import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ifNoneMatchSatisfiedBy } from "../lib/etag.js";
import { openObject, StorageError } from "../lib/s3.js";
import {
  getCoverInfo,
  isServableCoverType,
  PUBLIC_COVER_MAX_BYTES,
} from "../services/community-home-cover-info.js";
import type { PublicBauCover } from "../services/community-home-public.js";

/**
 * `GET|HEAD /api/public/communities/:slug/posts/:postId/cover`: the picture of
 * a public Baú post, served from OUR origin.
 *
 * WHY NOT THE REDIRECT IT USED TO BE. The address is the post's `og:image`, and
 * a link crawler is a stricter client than a browser. The old answer was a 302
 * to a presigned URL on another domain, ten minutes long and a few hundred
 * characters of query string; X showed a small card with a placeholder for it.
 * Crawlers commonly validate an image with a HEAD or a ranged GET and treat
 * anything but a 200 with an image content type as "no image". So this answers
 * the way a file on a plain web server would: 200 with `Content-Type` and
 * `Content-Length`, an `ETag`, `Accept-Ranges`, byte ranges (206 / 416) and
 * conditional requests (304), and HEAD is the same answer without the body.
 *
 * STREAMED, NOT BUFFERED. The bytes go bucket to socket through a pipe, never
 * all in this process at once, and a viewer that hangs up cancels the bucket
 * read. The size is capped (`PUBLIC_COVER_MAX_BYTES`) and anything bigger, or
 * of a format that is not an inert image, falls back to the redirect, which is
 * what every cover did before: nothing that worked stops working.
 *
 * THE VALIDATOR NEEDS NO STORAGE CALL. The `ETag` is a hash of the object's
 * key, which is immutable (a replaced picture is a new key), so a revalidation
 * costs the one row read the route already needs to prove the post is still
 * public, and a 304 is never answered for a post that is not.
 */

/**
 * An hour at the edge and in a browser. Longer than the page's minute (see
 * `PUBLIC_BAU_CACHE_MISS` in index.ts), and on purpose: the picture of a post
 * is immutable under its address, the card is fetched by crawlers that
 * revalidate rarely, and a hot link should cost the bucket one read an hour,
 * not one a minute. The price is the one this header names: a post taken down
 * keeps its CACHED picture for up to an hour at a shared cache, while the page
 * and every refusal go dark within two minutes.
 */
export const PUBLIC_COVER_CACHE = "public, max-age=3600, s-maxage=3600";

/** A strong validator for a cover, from its key and nothing else. */
export function coverEtag(key: string): string {
  return `"${createHash("sha256").update(key).digest("hex").slice(0, 32)}"`;
}

export interface ByteRange {
  start: number;
  /** Inclusive, as in the header. */
  end: number;
}

/**
 * RFC 9110 section 14.1.2, for the one shape that matters here. A single range
 * is honoured; a list of ranges, a unit other than bytes, or a header that does
 * not parse is IGNORED (the caller answers 200 with the whole body, which the
 * RFC allows for any of them). Only a well-formed single range that starts past
 * the end is `unsatisfiable` (416).
 */
export function parseRange(
  header: string | undefined,
  length: number,
): ByteRange | "unsatisfiable" | null {
  if (!header) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) {
    return null;
  }
  if (match[1] === "") {
    // A suffix: the last N bytes.
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix)) {
      return null;
    }
    if (suffix === 0 || length === 0) {
      return "unsatisfiable";
    }
    return { start: Math.max(0, length - suffix), end: length - 1 };
  }
  const start = Number(match[1]);
  const explicitEnd = match[2] === "" ? null : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    (explicitEnd !== null &&
      (!Number.isSafeInteger(explicitEnd) || explicitEnd < start))
  ) {
    // `bytes=5-2` is not a range at all, so it is ignored rather than refused.
    return null;
  }
  if (start >= length) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(explicitEnd ?? length - 1, length - 1) };
}

export interface CoverResponders {
  /** The headers every public post answer carries (CORS, security, cache). */
  headers: (cacheControl: string) => Record<string, string>;
  /** The one 404 every refusal sends. */
  notFound: () => void;
  /** A 503 for a storage failure. */
  unavailable: () => void;
  /** The refusal-cache header, for the redirect fallback. */
  missCacheControl: string;
  /** What a served (200, 206, 304) picture may be cached for. Defaults to `PUBLIC_COVER_CACHE`. */
  cacheControl?: string;
}

/**
 * Answer for a cover that has already been proved public. Always ends the
 * response.
 */
export async function serveCover(
  req: IncomingMessage,
  res: ServerResponse,
  cover: Pick<PublicBauCover, "key" | "signedUrl">,
  out: CoverResponders,
): Promise<void> {
  const head = req.method === "HEAD";
  const etag = coverEtag(cover.key);
  const validators = {
    ...out.headers(out.cacheControl ?? PUBLIC_COVER_CACHE),
    ETag: etag,
    "Accept-Ranges": "bytes",
  };

  // A 304 first, and with no storage call at all: the validator is derived from
  // the key, and the caller has just re-checked that the post is still public.
  if (ifNoneMatchSatisfiedBy(req.headers["if-none-match"], etag)) {
    res.writeHead(304, validators);
    res.end();
    return;
  }

  let info;
  try {
    info = await getCoverInfo(cover.key);
  } catch (error) {
    console.error(
      "[bau-public] cover storage failed:",
      error instanceof Error ? error.message : error,
    );
    out.unavailable();
    return;
  }
  if (!info) {
    out.notFound();
    return;
  }

  if (!isServableCoverType(info.contentType) || info.length > PUBLIC_COVER_MAX_BYTES) {
    // Too big, or not an inert image: what this route did before it served
    // bytes. Cached for the redirect's short window, which is also how long the
    // signature it points at is trusted.
    res.writeHead(302, {
      location: cover.signedUrl,
      ...out.headers(out.missCacheControl),
    });
    res.end();
    return;
  }

  // `If-Range` says "this range only if I still hold this exact version". The
  // version is the ETag; a mismatch (or a date, which we do not issue) means
  // the client's copy is not ours, so it gets the whole picture.
  const ifRange = req.headers["if-range"];
  const rangeAllowed = ifRange === undefined || ifRange === etag;
  const range = rangeAllowed ? parseRange(req.headers.range, info.length) : null;

  if (range === "unsatisfiable") {
    res.writeHead(416, {
      ...validators,
      "Content-Range": `bytes */${info.length}`,
      "Content-Length": "0",
    });
    res.end();
    return;
  }

  const partial = range !== null;
  const start = partial ? range.start : 0;
  const end = partial ? range.end : info.length - 1;
  const length = info.length === 0 ? 0 : end - start + 1;
  const headers = {
    ...validators,
    "Content-Type": info.contentType,
    "Content-Length": String(length),
    ...(partial ? { "Content-Range": `bytes ${start}-${end}/${info.length}` } : {}),
  };

  if (head || length === 0) {
    res.writeHead(partial ? 206 : 200, headers);
    res.end();
    return;
  }

  let upstream: Response | null;
  try {
    upstream = await openObject(cover.key, partial ? { start, end } : undefined);
  } catch (error) {
    console.error(
      "[bau-public] cover read failed:",
      error instanceof StorageError ? error.message : error,
    );
    out.unavailable();
    return;
  }
  if (!upstream) {
    out.notFound();
    return;
  }

  let body: ReadableStream<Uint8Array> = upstream.body!;
  if (partial && upstream.status !== 206) {
    // A store that ignored `Range` and sent the whole object. Bounded by the
    // size cap above, so slicing it in memory is safe, and it is the only way
    // to honour the `Content-Length` already promised.
    let whole: Uint8Array<ArrayBuffer>;
    try {
      whole = new Uint8Array(await upstream.arrayBuffer());
    } catch (error) {
      // The store failed mid-body, before a byte went to the viewer: the same
      // controlled answer as a store that fails to open.
      await upstream.body?.cancel().catch(() => undefined);
      console.error(
        "[bau-public] cover read failed:",
        error instanceof Error ? error.message : error,
      );
      out.unavailable();
      return;
    }
    body = new Response(whole.subarray(start, end + 1)).body!;
  }

  res.writeHead(partial ? 206 : 200, headers);
  try {
    // `pipeline` tears both sides down on either failure: a viewer that hangs
    // up cancels the bucket read, and a bucket that dies mid-body destroys the
    // socket (the headers are out, so a truncated body is all that is left to
    // say, and `Content-Length` makes that visible to the client).
    await pipeline(Readable.fromWeb(body as never), res);
  } catch (error) {
    if (!res.destroyed) {
      res.destroy();
    }
    const code = (error as { code?: string }).code;
    if (code !== "ERR_STREAM_PREMATURE_CLOSE") {
      console.error(
        "[bau-public] cover stream failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }
}
