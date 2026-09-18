/**
 * Whether a path under `/app` should tell a crawler not to index it.
 *
 * THE BUG THIS FIXES. `robots.txt` used to carry `Disallow: /app`, on the
 * theory that a crawler kept out of a login-gated tree cannot index it. That
 * is only true for a crawler that discovers the URL by crawling. One that is
 * handed the URL directly, an old share, an imported Discord invite pasted
 * somewhere, a link in a chat log, indexes it anyway with no title and no
 * description, because `Disallow` stops the fetch and a directive a crawler
 * never fetches is a directive it never reads. Search Console's own name for
 * the result is "Indexed, though blocked by robots.txt": `/app/server/<id>`
 * and `/app/server/<id>/channel/<id>` sitting in the index with nothing
 * behind them, forever, because Google is never let close enough to notice
 * they are empty.
 *
 * THE FIX IS THE OTHER WAY AROUND. Let the crawl through, and say `noindex`
 * from the response itself, in a header a crawler reads before it parses a
 * single byte of the body. `robots.txt` drops `Disallow: /app`, and this
 * module is what the Pages middleware asks before writing
 * `X-Robots-Tag: noindex, nofollow` onto the response.
 *
 * `/app/invite/<code>` IS THE ONE EXCEPTION. It already carries its own
 * `noindex` through `injectInviteHead`'s meta tag (see `invite-meta.ts`), and
 * unlike the rest of `/app` it has to stay crawlable on purpose: an unfurler
 * has to fetch the page to draw a card for a link somebody pasted into a
 * group chat. A second `noindex` on top of the header would not change the
 * outcome (both mean the same thing to Google), but it is the header's job
 * to say nothing about a path invite-meta already owns, so it is excluded
 * here rather than doubly asserted.
 */
export function isNoIndexAppPath(pathname: string): boolean {
  if (pathname !== "/app" && !pathname.startsWith("/app/")) {
    return false;
  }
  return !pathname.startsWith("/app/invite/");
}
