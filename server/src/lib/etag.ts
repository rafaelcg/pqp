import { createHash } from "node:crypto";

/**
 * Conditional GETs for the handful of reads a client hits on every screen
 * change (a channel's message page, the server list, a server's channels, the
 * DM list). The mobile client keeps the last response per key on disk and
 * sends it back as `If-None-Match`; an unchanged read then costs a 304 with no
 * body instead of re-shipping and re-decoding the page.
 *
 * Two rules this file exists to keep honest:
 *
 * 1. **No `Cache-Control: max-age`.** Every one of these responses is
 *    Bearer-authed and viewer-specific (`me` on reactions, unread counts,
 *    which private channels you can see). A shared proxy holding one and
 *    handing it to the next caller is a privacy hole, so responses stay
 *    `no-store` and only the *client that made them* may revalidate.
 * 2. **The ETag is computed from the body the route already produced.** It is
 *    therefore impossible to answer 304 to a caller who would not have been
 *    given the 200 — see `handleApi`, where authentication, the age gate and
 *    the route's own access checks have all already run by the time an
 *    `Etagged` result comes back to be compared.
 */

/**
 * Marks a route's return value as conditionally cacheable. `handleApi`
 * serializes it once, hashes that, and answers 304 or 200 accordingly.
 */
export class Etagged {
  constructor(public readonly body: unknown) {}
}

export function etagged(body: unknown): Etagged {
  return new Etagged(body);
}

/**
 * A strong validator over the exact bytes that would have been sent.
 *
 * Hashing the serialized payload rather than a hand-picked watermark (newest
 * id + count) on purpose: a watermark misses edits, deletes that keep the
 * count, reactions, resolved embeds and thread chips — all of which change
 * what the page should look like without moving the newest id. The page is at
 * most a hundred rows, so the hash costs microseconds next to the query that
 * produced it, and it cannot go stale by construction.
 */
export function computeEtag(serialized: string): string {
  const digest = createHash("sha1").update(serialized).digest("base64url");
  return `"${serialized.length.toString(36)}-${digest}"`;
}

/**
 * RFC 9110 §13.1.2, in the shape this API needs: `*` matches anything, and a
 * list is compared with the weak comparison function (which for our strong
 * tags means "ignore any `W/` prefix the client put back on").
 *
 * The split is a plain comma split, which is safe here because every tag this
 * server mints is base64url + base36 inside quotes — no commas can appear
 * inside one. A malformed header from some other client simply fails to match
 * and gets the full 200 it would have got anyway.
 */
export function ifNoneMatchSatisfiedBy(
  header: string | string[] | undefined,
  etag: string,
): boolean {
  if (!header) {
    return false;
  }
  const raw = Array.isArray(header) ? header.join(",") : header;
  const trimmed = raw.trim();
  if (trimmed === "") {
    return false;
  }
  if (trimmed === "*") {
    return true;
  }
  const wanted = stripWeak(etag);
  return trimmed
    .split(",")
    .map((candidate) => stripWeak(candidate.trim()))
    .some((candidate) => candidate !== "" && candidate === wanted);
}

function stripWeak(value: string): string {
  return value.startsWith("W/") ? value.slice(2) : value;
}
