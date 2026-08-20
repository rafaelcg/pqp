import {
  communitySlugFromMetaPath,
  injectCommunityHead,
  type CommunityMeta,
} from "../src/lib/community-meta";
import {
  injectMarketingHead,
  marketingPageFromMetaPath,
} from "../src/lib/marketing-meta";
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
 * THREE SURFACES, ONE MIDDLEWARE. `/@rafa` is a person, `/c/valorant` is a
 * room, and `/vs-discord` is the product arguing for itself — and they get
 * different cards: a square avatar with `summary` for the first, a 3:1 banner
 * with `summary_large_image` for the second, and static per-locale copy for
 * the third. The head builders live in `src/lib/profile-meta.ts`,
 * `src/lib/community-meta.ts` and `src/lib/marketing-meta.ts` and are
 * deliberately not one parameterised builder; see the file comment on the
 * community one for the argument. The marketing branch is also the only one
 * that fetches nothing — its copy is constant, so it runs before the API
 * origin is even resolved. What is shared is everything below: the API origin,
 * the timeout, the locale, and the rule that every failure path serves the
 * page unchanged.
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
    const config = (await response.json()) as { apiUrl?: string };
    const apiUrl = config.apiUrl?.trim();
    return apiUrl ? apiUrl.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
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

export async function onRequest(context: PagesContext): Promise<Response> {
  const url = new URL(context.request.url);
  const handle = handleFromMetaPath(url.pathname);
  const slug = handle ? null : communitySlugFromMetaPath(url.pathname);
  const marketing =
    handle || slug ? null : marketingPageFromMetaPath(url.pathname);
  // The overwhelmingly common case, and it must cost nothing: this middleware
  // is in front of every request the site serves, including every hashed
  // asset. All three parsers are pure string checks — nothing is awaited
  // before this return.
  if ((!handle && !slug && !marketing) || context.request.method !== "GET") {
    return context.next();
  }

  const response = await context.next();
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("text/html")) {
    return response;
  }

  const locale = preferredLocale(
    url.search,
    context.request.headers.get("accept-language"),
  );

  if (marketing) {
    // No API involved: the copy is constant per page and locale, so the only
    // failure mode left is a document with no <head>, and the injector answers
    // that by returning the html unchanged.
    const html = await response.text();
    return rewritten(response, injectMarketingHead(html, marketing, locale));
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
        locale,
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
      locale,
    }),
  );
}
