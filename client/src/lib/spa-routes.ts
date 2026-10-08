import { blogTargetFromMetaPath } from "./blog-meta";
import { marketingPageFromMetaPath } from "./marketing-meta";

/**
 * Whether a path is one the single-page app has NO route for, so the edge can
 * answer it with a real 404 instead of the SPA shell with a 200.
 *
 * THE PROBLEM. Every path on the site returns the same `index.html` with a
 * 200 (`_redirects`: `/* /index.html 200`). The router then redirects an
 * unknown path to `/` in the browser. A crawler sees a 200 page with the
 * home's title and canonical for `/nao-existe`, `/en`, `/blog/nao-existe`, an
 * invented `/images/x.png`: a soft 404 that duplicates the home page under
 * every address anyone ever mistyped.
 *
 * WHAT THE EDGE DOES WITH THIS. Only for a GET that would have been answered
 * with HTML, on a path this says is unknown, the middleware keeps the body
 * (the SPA still loads and still redirects a person to `/`, exactly as before)
 * and changes the status to 404 with `X-Robots-Tag: noindex`. A file that
 * really exists is never HTML and never reaches this. A path that is known
 * is never touched.
 *
 * DRIFT. The list below mirrors the `<Route path>` table in `main.tsx`, and
 * `spa-routes.test.ts` reads that file and fails when a route is added there
 * without being recognised here. That test is the whole reason this is safe:
 * a missed route would otherwise answer 404 (and render fine, but drop out of
 * search) until somebody noticed.
 *
 * Dependency-free apart from the two pure parsers the middleware already uses,
 * like its siblings, because wrangler bundles the middleware outside the pnpm
 * workspace.
 */

/** Exact single-segment paths with a route (or a redirect) of their own. */
const STATIC_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/apoie",
  "/support",
  "/desktop-login",
  "/discord",
  "/ven",
  // Redirected to `/vem` by `_redirects` and by the router.
  "/vem/gratis",
  "/blog",
  "/qa/ui",
  // Pages itself redirects this to `/`; a monitor may also request it.
  "/index.html",
  // Probes a monitor may point at the site. They answer with the shell today
  // and an existing check must keep passing.
  "/health",
  "/up",
]);

export function isUnknownSpaPath(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

  if (STATIC_PATHS.has(path)) return false;
  if (marketingPageFromMetaPath(path) !== null) return false;

  // `/app` and everything under it, including `/app/invite/<code>`.
  if (path === "/app" || path.startsWith("/app/")) return false;

  // The blog index is static; a post is known only when its slug is.
  if (path.startsWith("/blog/")) return blogTargetFromMetaPath(path) === null;

  // `/c/<slug>`: a community. The API says whether it exists; the shell is the
  // right answer for any slug, so one segment after `/c/` is a route.
  if (/^\/c\/[^/]+$/.test(path)) return false;

  // `/@handle`: a person. Same reasoning.
  if (/^\/@[^/]+$/.test(path)) return false;

  // Referral short links, redirected by `_redirects`.
  if (path.startsWith("/r/")) return false;

  return true;
}
