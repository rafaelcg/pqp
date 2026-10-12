import { stripPrerenderHero } from "../src/lib/prerender-hero";
import { isNoIndexAppPath } from "../src/lib/app-robots";
import { isUnknownSpaPath } from "../src/lib/spa-routes";
import {
  blogTargetFromMetaPath,
  injectBlogHead,
  type BlogTarget,
} from "../src/lib/blog-meta";
import {
  communitySlugFromMetaPath,
  injectCommunityHead,
  type CommunityMeta,
} from "../src/lib/community-meta";
import {
  injectInviteHead,
  inviteCodeFromMetaPath,
} from "../src/lib/invite-meta";
import {
  injectMarketingHead,
  marketingPageFromMetaPath,
} from "../src/lib/marketing-meta";
import {
  injectMarketingBody,
  PRERENDERED_MARKETING_PAGES,
  type MarketingChrome,
} from "../src/lib/marketing-prerender";
import type { EdgeConfig } from "../src/lib/edge-config";
import {
  markdownTwinFor,
  prefersMarkdown,
} from "../src/lib/markdown-negotiation";
import {
  handleFromMetaPath,
  injectProfileHead,
  preferredLocale,
  type ProfileMeta,
} from "../src/lib/profile-meta";

/**
 * Cloudflare Pages middleware: real Open Graph tags for `/@handle` and `/c/…`.
 *
 * WHY THIS FILE EXISTS. The site is a static SPA — every route is the same
 * `index.html`, and the head is fixed up in the browser by `Seo`. Crawlers and
 * chat-app unfurlers never run that script, so a profile link pasted into a
 * WhatsApp group renders the generic product card. That is fatal for a feature
 * whose entire growth loop is somebody sharing their own page. This runs at the
 * edge, in front of the asset, and rewrites the bytes.
 *
 * SEVERAL SURFACES, ONE MIDDLEWARE. `/@rafa` is a person, `/c/valorant` is a
 * room, `/vs-discord` is the product arguing for itself, `/blog/…` is a release
 * note, and `/app/invite/<code>` is a door — and they get different cards: a
 * square avatar with `summary` for the first, a 3:1 banner with
 * `summary_large_image` for the second, and static per-locale copy for the rest.
 * The head builders live in `src/lib/profile-meta.ts`,
 * `src/lib/community-meta.ts`, `src/lib/marketing-meta.ts`,
 * `src/lib/blog-meta.ts` and `src/lib/invite-meta.ts` and are deliberately not
 * one parameterised builder; see the file comment on the community one for the
 * argument. The marketing, blog and invite branches fetch nothing — their copy
 * is constant, so they run before the API origin is even resolved. What is
 * shared is everything below: the API origin, the timeout, the locale, and the
 * rule that every failure path serves the page unchanged.
 *
 * THE INVITE BRANCH IS THE ONLY ONE THAT NAMES NOTHING, and it is the only one
 * that must not: an invite link is semi-public, so its card is written to leak
 * no more than the closed door already does. `src/lib/invite-meta.ts` carries
 * the argument, and the fact that it fetches nothing is the mechanism.
 *
 * WHAT IT DOES NOT DO. It does not render the page. The SPA still fetches and
 * draws it; this only fixes the head. Two fetches of the same JSON (one at the
 * edge, one in the browser) is the deliberate trade against server-rendering a
 * React tree in a Worker — both endpoints are cached for a minute and the
 * payloads are a few hundred bytes.
 *
 * EVERY FAILURE PATH SERVES THE PAGE UNCHANGED. No API origin configured, the
 * API down, a 404, a timeout, a malformed body, an asset with no `<head>`: all
 * of them fall through to `context.next()`. A page that unfurls badly is a bad
 * day; a page that 500s at the edge is a dead link, and this middleware sits in
 * front of the whole site.
 */

interface PagesContext {
  request: Request;
  env: {
    /**
     * Where the API lives. Optional — see `resolveApiOrigin`, which falls back
     * to the build-time config asset so a standard deploy needs no extra
     * variable at all. Set this in the Pages project only to point a deploy at
     * a different API without rebuilding.
     */
    PQP_API_URL?: string;
    /** Pages' own static-asset binding. Absent in some runtimes; handled. */
    ASSETS?: { fetch: (input: Request | string | URL) => Promise<Response> };
  };
  next: () => Promise<Response>;
  /** Keeps background work alive after the response. Absent in tests. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** The edge has no patience and neither does WhatsApp's unfurler. */
const API_TIMEOUT_MS = 2_000;

/**
 * Where to ask for the profile JSON.
 *
 * Two sources, in order. `PQP_API_URL` on the Pages project wins, for the
 * operator who wants to repoint a deploy without a rebuild. Otherwise
 * `/edge-config.json`, which the Vite build writes from the same `VITE_API_URL`
 * the client bundle was built against — so the ordinary deploy path needs no
 * new secret, no dashboard setting, and cannot drift from what the SPA uses.
 */
async function resolveApiOrigin(context: PagesContext): Promise<string | null> {
  const fromEnv = context.env.PQP_API_URL?.trim();
  if (fromEnv) {
    return fromEnv.replace(/\/+$/, "");
  }
  const apiUrl = (await readEdgeConfig(context))?.apiUrl;
  const trimmed = typeof apiUrl === "string" ? apiUrl.trim() : "";
  return trimmed ? trimmed.replace(/\/+$/, "") : null;
}

/** How long one isolate trusts what it read for the marketing chrome. */
const CHROME_MEMO_MS = 60_000;
/**
 * The communities flag sits on the path of five marketing pages. The API
 * answers it `no-store`, and from a colo far from São Paulo it takes most of a
 * second, so the answer is kept in the colo's cache and served stale while a
 * background request refreshes it. Only a colo with no copy at all waits, and
 * at most this long; the request keeps running (up to `API_TIMEOUT_MS`) to
 * fill the cache for the next reader.
 */
const COMMUNITIES_WAIT_MS = 1_000;
const COMMUNITIES_FRESH_MS = 5 * 60_000;
const COMMUNITIES_CACHE_KEY = "https://pqp-edge.internal/communities-config";

// Only settled answers are remembered across requests. A request never waits
// on another request's unsettled work without a timer of its own: on Workers,
// work a cancelled request started may never settle.
let edgeConfigMemo: { at: number; value: Partial<EdgeConfig> } | null = null;

/** `/edge-config.json` (`src/lib/edge-config.ts`), or null when it cannot be read. */
async function readEdgeConfig(context: PagesContext): Promise<Partial<EdgeConfig> | null> {
  if (edgeConfigMemo && Date.now() - edgeConfigMemo.at < CHROME_MEMO_MS) {
    return edgeConfigMemo.value;
  }
  const assets = context.env.ASSETS;
  if (!assets) {
    return null;
  }
  try {
    const url = new URL("/edge-config.json", context.request.url);
    const response = await assets.fetch(new Request(url.toString()));
    if (!response.ok) {
      return null;
    }
    const value = (await response.json()) as Partial<EdgeConfig> | null;
    if (!value || typeof value !== "object") {
      return null;
    }
    // A failed read is not remembered: profile unfurls read the same file.
    edgeConfigMemo = { at: Date.now(), value };
    return value;
  } catch {
    return null;
  }
}

let communitiesMemo: { at: number; enabled: boolean } | null = null;
/**
 * The API request this isolate has on the way, shared until it settles. It is
 * trusted no longer than the request's own timeout, so one that never settles
 * cannot stop the next.
 */
let communitiesInFlight: { at: number; request: Promise<boolean | null> } | null = null;

function coloCache(): Cache | null {
  return (globalThis as { caches?: { default?: Cache } }).caches?.default ?? null;
}

/** The API's answer, stored in the colo cache. Null when it did not answer. Never rejects. */
async function fetchCommunities(context: PagesContext): Promise<boolean | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const apiOrigin = await resolveApiOrigin(context);
    if (!apiOrigin) {
      return null;
    }
    const response = await fetch(`${apiOrigin}/api/public/communities/config`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return null;
    }
    const enabled = ((await response.json()) as { enabled?: unknown }).enabled === true;
    await coloCache()
      ?.put(
        COMMUNITIES_CACHE_KEY,
        new Response(JSON.stringify({ enabled, at: Date.now() }), {
          headers: { "cache-control": "max-age=86400" },
        }),
      )
      .catch(() => undefined);
    return enabled;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks the API, or joins the request this isolate already has on the way, so
 * a slow API gets one request per isolate and not one per page. The request
 * outlives the page that started it (`waitUntil`).
 */
function refreshCommunities(context: PagesContext): Promise<boolean | null> {
  if (communitiesInFlight && Date.now() - communitiesInFlight.at < API_TIMEOUT_MS) {
    return communitiesInFlight.request;
  }
  const request = fetchCommunities(context);
  const inFlight = { at: Date.now(), request };
  communitiesInFlight = inFlight;
  context.waitUntil?.(request);
  void request.then((enabled) => {
    if (communitiesInFlight === inFlight) {
      communitiesInFlight = null;
    }
    // No answer reads as off for a minute, so a down API is not asked on
    // every page; an answer already remembered is kept instead.
    communitiesMemo =
      enabled === null
        ? (communitiesMemo ?? { at: Date.now(), enabled: false })
        : { at: Date.now(), enabled };
  });
  return request;
}

/** The API's `COMMUNITIES_ENABLED`, from the public config the landing reads. False when unknown. */
async function communitiesEnabled(context: PagesContext): Promise<boolean> {
  if (communitiesMemo && Date.now() - communitiesMemo.at < CHROME_MEMO_MS) {
    return communitiesMemo.enabled;
  }
  const cached = await coloCache()
    ?.match(COMMUNITIES_CACHE_KEY)
    .catch(() => undefined);
  if (cached) {
    try {
      const { enabled, at } = (await cached.json()) as { enabled?: unknown; at?: number };
      if (typeof at !== "number" || Date.now() - at > COMMUNITIES_FRESH_MS) {
        void refreshCommunities(context);
      }
      communitiesMemo = { at: Date.now(), enabled: enabled === true };
      return enabled === true;
    } catch {
      // An unreadable entry is a miss.
    }
  }
  // Each page stops waiting on its own timer; the request keeps going.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = await Promise.race([
    refreshCommunities(context),
    new Promise<"waited">((resolve) => {
      timer = setTimeout(() => resolve("waited"), COMMUNITIES_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  return answer === true;
}

/** What the live nav and footer would show, as far as the edge can tell. */
async function marketingChrome(context: PagesContext): Promise<MarketingChrome> {
  const [config, communities] = await Promise.all([
    readEdgeConfig(context),
    communitiesEnabled(context),
  ]);
  return {
    communities,
    supportPage: config?.supportPage === true,
    playStore: config?.playStore === true,
  };
}

async function fetchProfile(
  apiOrigin: string,
  handle: string,
): Promise<ProfileMeta | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${apiOrigin}/api/public/profiles/${encodeURIComponent(handle)}`,
      { signal: controller.signal, headers: { accept: "application/json" } },
    );
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { profile?: ProfileMeta };
    const profile = body.profile;
    // Shape-checked rather than trusted: this string is interpolated into a
    // document, and `injectProfileHead` escapes it, but a missing field would
    // put "undefined" on the card.
    if (
      !profile ||
      typeof profile.handle !== "string" ||
      typeof profile.displayName !== "string"
    ) {
      return null;
    }
    return {
      handle: profile.handle,
      displayName: profile.displayName,
      avatarUrl:
        typeof profile.avatarUrl === "string" ? profile.avatarUrl : null,
      badges: Array.isArray(profile.badges)
        ? profile.badges.filter(
            (badge): badge is { name: string } =>
              !!badge && typeof badge.name === "string",
          )
        : [],
      depoimentoCount:
        typeof profile.depoimentoCount === "number"
          ? profile.depoimentoCount
          : 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The community behind a slug, or null.
 *
 * Shape-checked rather than trusted, exactly as `fetchProfile` is: these
 * strings are interpolated into a document, `injectCommunityHead` escapes them,
 * but a missing field would put "undefined" on the card. `memberCount` is
 * coerced to a number rather than defaulted, because a card that says "NaN
 * membros" is worse than one that says zero.
 */
async function fetchCommunity(
  apiOrigin: string,
  slug: string,
): Promise<CommunityMeta | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${apiOrigin}/api/public/communities/${encodeURIComponent(slug)}`,
      { signal: controller.signal, headers: { accept: "application/json" } },
    );
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { community?: CommunityMeta };
    const community = body.community;
    if (
      !community ||
      typeof community.slug !== "string" ||
      typeof community.name !== "string"
    ) {
      return null;
    }
    return {
      slug: community.slug,
      name: community.name,
      tagline:
        typeof community.tagline === "string" ? community.tagline : null,
      category:
        typeof community.category === "string" ? community.category : "geral",
      memberCount:
        typeof community.memberCount === "number" &&
        Number.isFinite(community.memberCount)
          ? community.memberCount
          : 0,
      iconUrl: typeof community.iconUrl === "string" ? community.iconUrl : null,
      bannerUrl:
        typeof community.bannerUrl === "string" ? community.bannerUrl : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The rewritten response, with the caching a per-URL, per-language document
 * needs. Shared by both surfaces because the answer is the same for both:
 * anything in front of this must not reuse one page's bytes for another's URL.
 */
function rewritten(response: Response, html: string): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "public, max-age=60");
  headers.append("vary", "accept-language");
  headers.delete("content-length");
  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Build-output namespaces where every file is content-hashed. A request here
 * can only legitimately be answered with the asset itself — never with HTML.
 */
function isHashedAssetPath(pathname: string): boolean {
  return pathname.startsWith("/assets/") || /^\/workbox-[\w-]+\.js$/.test(pathname);
}

/**
 * The SPA shell answering for an address nothing serves, turned into a 404.
 *
 * The body is kept: the app still loads and its catch-all still sends a
 * person to `/`, so nobody who mistypes a URL sees an error page. What changes
 * is what a crawler is told: a real 404 and `noindex`, instead of a 200 copy
 * of the home page under every mistyped address. Anything that is not an
 * `ok` HTML response (a real file, a redirect, an error) is returned as it is.
 */
function notFoundIfShell(response: Response): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("text/html")) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("x-robots-tag", "noindex, nofollow");
  headers.set("cache-control", "no-store");
  headers.delete("content-length");
  return new Response(response.body, {
    status: 404,
    statusText: "Not Found",
    headers,
  });
}

async function handleRequest(context: PagesContext): Promise<Response> {
  const url = new URL(context.request.url);

  // A hashed asset that falls through to the SPA fallback must die as an
  // uncacheable 404, never travel as HTML. During a deploy's propagation
  // window the domain can briefly answer for a hash it does not have yet; the
  // fallback is index.html, `_headers` stamps everything under /assets/* as
  // immutable for a year, and the edge cache will happily serve that HTML as
  // the stylesheet until 2027 (it did, 2026-08-20 — blank site). `_headers`
  // does not apply to function responses, so the no-store here is what wins.
  if (isHashedAssetPath(url.pathname)) {
    const response = await context.next();
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      return new Response("Not found", {
        status: 404,
        headers: {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }
    return response;
  }

  // `/app/*`, minus the invite door: per-account, behind a login, nothing an
  // index can use. `robots.txt` no longer disallows it (see `app-robots.ts`
  // for why a `Disallow` a crawler never fetches cannot keep it out of the
  // index either), so this is what actually keeps it out: let the crawl
  // through, stamp the response `noindex, nofollow` from a header a crawler
  // reads before it parses the body. Cheap on purpose — no `response.text()`,
  // the body streams through untouched.
  if (
    context.request.method === "GET" &&
    isNoIndexAppPath(url.pathname)
  ) {
    const response = await context.next();
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.includes("text/html")) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.set("x-robots-tag", "noindex, nofollow");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  // `Accept: text/markdown` on a page that has a written markdown twin. This
  // sits above every other branch because it answers with a different document
  // entirely, not with a rewritten head, and below the hashed-asset guard
  // because that one is about not serving HTML for a stylesheet. Only GET, and
  // only when the twin is actually there: every failure falls through to the
  // ordinary HTML page.
  if (context.request.method === "GET" && prefersMarkdown(context.request.headers.get("accept"))) {
    const twin = markdownTwinFor(url.pathname);
    const assets = context.env.ASSETS;
    if (twin && assets) {
      try {
        const twinUrl = new URL(twin, context.request.url);
        const markdown = await assets.fetch(new Request(twinUrl.toString()));
        if (markdown.ok) {
          const body = await markdown.text();
          return new Response(body, {
            status: 200,
            headers: {
              "content-type": "text/markdown; charset=utf-8",
              "cache-control": "public, max-age=300",
              vary: "accept",
              // Rough, and honest about being rough: a whole-word-ish count is
              // within a factor the caller can budget with, and the header is
              // optional anyway.
              "x-markdown-tokens": String(Math.ceil(body.split(/\s+/).filter(Boolean).length * 1.3)),
            },
          });
        }
      } catch {
        // Fall through to HTML. A markdown variant is a nicety; the page is not.
      }
    }
  }

  const handle = handleFromMetaPath(url.pathname);
  const slug = handle ? null : communitySlugFromMetaPath(url.pathname);
  const marketing =
    handle || slug ? null : marketingPageFromMetaPath(url.pathname);
  const blog: BlogTarget | null =
    handle || slug || marketing ? null : blogTargetFromMetaPath(url.pathname);
  const inviteCode =
    handle || slug || marketing || blog
      ? null
      : inviteCodeFromMetaPath(url.pathname);
  // The overwhelmingly common case, and it must cost nothing: this middleware
  // is in front of every request the site serves, including every hashed
  // asset. All five parsers are pure string checks — nothing is awaited
  // before this return.
  if (!handle && !slug && !marketing && !blog && !inviteCode) {
    // Still a pure string check. Only a GET for a path the SPA has no route
    // for pays for the content-type look, and only to turn the shell's
    // 200 into a real 404. See `spa-routes.ts`.
    if (context.request.method === "GET" && isUnknownSpaPath(url.pathname)) {
      return notFoundIfShell(await context.next());
    }
    return context.next();
  }
  if (context.request.method !== "GET") {
    return context.next();
  }

  // Started beside the page fetch, so it costs nothing once memoized.
  const chrome =
    marketing && PRERENDERED_MARKETING_PAGES.includes(marketing)
      ? marketingChrome(context)
      : null;
  const response = await context.next();
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("text/html")) {
    return response;
  }

  const locale = preferredLocale(
    url.search,
    context.request.headers.get("accept-language"),
  );
  // Marketing pages carry Spanish copy of their own; the invite, community and
  // profile cards do not yet, so Spanish readers get their English card. The
  // blog gets `en` as its base too, and serves a post's Spanish card itself
  // when that post has one (`injectBlogHead` reads the stamped `es`).
  const cardLocale = locale === "es" ? "en" : locale;

  if (marketing) {
    // No API involved: the copy is constant per page and locale, so the only
    // failure mode left is a document with no <head>, and the injector answers
    // that by returning the html unchanged.
    // A page that carries a no-JS body (`marketing-prerender.ts`) gets it in
    // the same language; every other marketing page comes back unchanged.
    const html = await response.text();
    return rewritten(
      response,
      injectMarketingBody(
        injectMarketingHead(html, marketing, locale),
        marketing,
        locale,
        chrome ? await chrome : undefined,
      ),
    );
  }

  if (blog) {
    // Same as the marketing branch and for the same reason: a release note's
    // title, summary and date are checked into the repository, so the head can
    // be written without asking the API anything.
    const html = await response.text();
    return rewritten(response, injectBlogHead(html, blog, cardLocale, locale));
  }

  if (inviteCode) {
    // Also fetches nothing, and for a different reason than the two above: not
    // because there is no data to fetch, but because fetching it would publish
    // a private community's name to everyone the link ever reaches. See
    // `invite-meta.ts`. The consequence is the good one — a revoked, expired
    // or invented code unfurls exactly like a live one, so the card is not an
    // oracle — and it means invite unfurls do not care whether
    // `COMMUNITIES_ENABLED` is on, whether the invite belongs to a community
    // at all, or whether the API is up.
    const html = await response.text();
    return rewritten(
      response,
      injectInviteHead(html, inviteCode, {
        siteOrigin: url.origin,
        locale: cardLocale,
      }),
    );
  }

  const apiOrigin = await resolveApiOrigin(context);
  if (!apiOrigin) {
    return response;
  }

  if (slug) {
    const community = await fetchCommunity(apiOrigin, slug);
    if (!community) {
      // Unknown, unlisted, suspended, or the flag is off — the API answers all
      // four identically and so does this. The SPA draws its own "essa
      // comunidade não existe" page and the head stays the product's generic
      // card, which is correct: at that point the page really is about the
      // product.
      return response;
    }
    const html = await response.text();
    return rewritten(
      response,
      injectCommunityHead(html, community, {
        siteOrigin: url.origin,
        apiOrigin,
        locale: cardLocale,
      }),
    );
  }

  const profile = await fetchProfile(apiOrigin, handle!);
  if (!profile) {
    // An unclaimed handle. The SPA draws its own "this @ is free — claim it"
    // page, which is a better landing than a 404 and is a growth surface in its
    // own right; the head stays the product's generic card, which is correct
    // because the page really is about the product at that point.
    return response;
  }

  const html = await response.text();
  return rewritten(
    response,
    injectProfileHead(html, profile, {
      siteOrigin: url.origin,
      apiOrigin,
      locale: cardLocale,
    }),
  );
}

/**
 * `index.html` carries the landing page's first screen for the home route
 * (`src/lib/prerender-hero.ts`). The file is the same for every path, so every
 * HTML answer for a path that is NOT `/` has it taken out here: a browser
 * would hide it, but a crawler or a reader that does not run JavaScript would
 * read the home hero as the body of `/vs-discord` or `/@handle`. Covers every
 * branch of the middleware, including the pass-through and the error
 * fall-throughs, because it wraps all of them.
 */
export async function onRequest(context: PagesContext): Promise<Response> {
  const response = await handleRequest(context);
  if (context.request.method !== "GET") {
    return response;
  }
  if (new URL(context.request.url).pathname === "/") {
    return response;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    return response;
  }
  const html = await response.text();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(stripPrerenderHero(html), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
