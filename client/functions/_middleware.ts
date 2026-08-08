import {
  handleFromMetaPath,
  injectProfileHead,
  preferredLocale,
  type ProfileMeta,
} from "../src/lib/profile-meta";

/**
 * Cloudflare Pages middleware: real Open Graph tags for `/@handle`.
 *
 * WHY THIS FILE EXISTS. The site is a static SPA — every route is the same
 * `index.html`, and the head is fixed up in the browser by `Seo`. Crawlers and
 * chat-app unfurlers never run that script, so a profile link pasted into a
 * WhatsApp group renders the generic product card. That is fatal for a feature
 * whose entire growth loop is somebody sharing their own page. This runs at the
 * edge, in front of the asset, and rewrites the bytes.
 *
 * WHAT IT DOES NOT DO. It does not render the page. The SPA still fetches the
 * profile and draws it; this only fixes the head. Two fetches of the same JSON
 * (one at the edge, one in the browser) is the deliberate trade against
 * server-rendering a React tree in a Worker — the endpoint is cached for a
 * minute and the payload is a few hundred bytes.
 *
 * EVERY FAILURE PATH SERVES THE PAGE UNCHANGED. No API origin configured, the
 * API down, a 404, a timeout, a malformed body, an asset with no `<head>`: all
 * of them fall through to `context.next()`. A profile that unfurls badly is a
 * bad day; a profile that 500s at the edge is a dead link, and this middleware
 * sits in front of the whole site.
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

export async function onRequest(context: PagesContext): Promise<Response> {
  const url = new URL(context.request.url);
  const handle = handleFromMetaPath(url.pathname);
  // The overwhelmingly common case, and it must cost nothing: this middleware
  // is in front of every request the site serves, including every hashed asset.
  if (!handle || context.request.method !== "GET") {
    return context.next();
  }

  const response = await context.next();
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("text/html")) {
    return response;
  }

  const apiOrigin = await resolveApiOrigin(context);
  if (!apiOrigin) {
    return response;
  }

  const profile = await fetchProfile(apiOrigin, handle);
  if (!profile) {
    // An unclaimed handle. The SPA draws its own "this @ is free — claim it"
    // page, which is a better landing than a 404 and is a growth surface in its
    // own right; the head stays the product's generic card, which is correct
    // because the page really is about the product at that point.
    return response;
  }

  const html = await response.text();
  const rewritten = injectProfileHead(html, profile, {
    siteOrigin: url.origin,
    apiOrigin,
    locale: preferredLocale(
      url.search,
      context.request.headers.get("accept-language"),
    ),
  });

  const headers = new Headers(response.headers);
  // The document now varies by handle and by language, so anything in front of
  // this must not reuse one profile's bytes for another's URL.
  headers.set("cache-control", "public, max-age=60");
  headers.append("vary", "accept-language");
  headers.delete("content-length");
  return new Response(rewritten, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
