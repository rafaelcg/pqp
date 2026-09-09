/**
 * pqp-admin: the Worker in front of the operator dashboard.
 *
 * Four jobs, in this order, on every request:
 *
 *  1. Gate. Almost everything (the page, /metrics, /health) sits behind HTTP
 *     Basic Auth. The repo is public and a workers.dev hostname is guessable,
 *     so the page cannot rely on obscurity. With ADMIN_DASH_PASSWORD unset the
 *     Worker serves nothing at all (503), so a misdeploy never exposes data.
 *     The one exception is `POST /apk-click`: a public, CORS-open increment
 *     that the hosted `/android` page beacons. It writes a counter and
 *     nothing else; the read of that counter still needs the password.
 *  2. Proxy. `/metrics` is `${API_ORIGIN}/api/admin/metrics` called with the
 *     machine token, then merged with the Android distribution block this
 *     Worker owns (button clicks in KV, GitHub `download_count`);
 *     `/occupancy` is `${API_ORIGIN}/api/admin/voice-occupancy` with the same
 *     token and only the `days` and `day` parameters forwarded; `/health`
 *     is `${API_ORIGIN}/status.json`. The page only ever talks to its own
 *     origin and never holds a credential.
 *
 *     Four `/operator/*` routes join them, and they are this Worker's FIRST
 *     WRITES. Two reads (find a server, list its voice channels) and two PUTs
 *     (watch party availability per server, a channel's transport pin). They
 *     are in `OPERATOR_ROUTES` below, an exact (method, path) table for the
 *     same reason the API keeps one: the blast radius of the password plus
 *     the machine token should be readable in one glance, and a prefix is a
 *     thing somebody widens by accident. Everything else stays GET-only.
 *  3. Serve. `/` is the static page from the assets binding, and
 *     `/insights.js` the one script it loads (the three verdicts on "agora",
 *     kept in their own file so they can be unit tested). Both sit behind the
 *     gate. Anything else is a 404 from an allowlist, not a passthrough, so
 *     the Worker cannot be used as an open proxy or an asset lister.
 *
 * Every response carries `Cache-Control: no-store` and `Referrer-Policy:
 * no-referrer`; `/robots.txt` disallows everything and is the one path served
 * before the gate (a crawler that gets a 401 never sees the disallow).
 *
 * Secrets come from bindings only: `wrangler secret put ADMIN_DASH_PASSWORD`
 * and `wrangler secret put ADMIN_METRICS_TOKEN`. Nothing here is ever written
 * into the static HTML. See README.md.
 */

import {
  APK_CLICKS_KEY,
  APK_RATE_PREFIX,
  APK_RATE_TTL_SECONDS,
  bumpClicks,
  distributionBlock,
  emptyClicks,
  fetchGithubApkDownloads,
  isAllowedClickOrigin,
  type ApkClickState,
} from "./distribution.js";

export interface Env {
  ASSETS: Fetcher;
  /** Public API origin, e.g. https://api.pqp.gg (a var in wrangler.jsonc). */
  API_ORIGIN?: string;
  /** Basic Auth username (a var; defaults to "operador"). */
  ADMIN_DASH_USER?: string;
  /** Basic Auth password (secret). Unset means the dashboard is off. */
  ADMIN_DASH_PASSWORD?: string;
  /** Bearer token the API expects on /api/admin/metrics (secret). */
  ADMIN_METRICS_TOKEN?: string;
  /** `owner/repo` for the Android beta release. */
  GITHUB_REPO?: string;
  /** Click counter. Unset: /apk-click is a no-op and the tile says so. */
  APK_CLICKS?: KVNamespace;
}

const DEFAULT_USER = "operador";
const UPSTREAM_TIMEOUT_MS = 8_000;

const BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function withBaseHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(BASE_HEADERS)) {
    out.headers.set(name, value);
  }
  return out;
}

function text(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...extra },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * Constant-time string equality over UTF-8 bytes. Length is folded into the
 * result rather than returned early on, and the loop always runs to the longer
 * of the two, so a wrong guess takes the same time whatever it got wrong.
 */
function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

function unauthorized(): Response {
  return text(401, "autenticação necessária", {
    "WWW-Authenticate": 'Basic realm="pqp admin", charset="UTF-8"',
  });
}

/** True when the request carries valid Basic credentials. */
function isAuthorized(request: Request, env: Env): boolean {
  const expectedPassword = env.ADMIN_DASH_PASSWORD ?? "";
  const expectedUser = env.ADMIN_DASH_USER?.trim() || DEFAULT_USER;
  const header = request.headers.get("Authorization") ?? "";
  const [scheme, encoded] = header.split(" ", 2);
  if (!scheme || scheme.toLowerCase() !== "basic" || !encoded) {
    return false;
  }
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(
      Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
    );
  } catch {
    return false;
  }
  const colon = decoded.indexOf(":");
  const user = colon === -1 ? decoded : decoded.slice(0, colon);
  const password = colon === -1 ? "" : decoded.slice(colon + 1);
  // Both comparisons always run; `&` rather than `&&` on purpose.
  const userOk = safeEqual(user, expectedUser);
  const passwordOk = safeEqual(password, expectedPassword);
  return (Number(userOk) & Number(passwordOk)) === 1;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && isAllowedClickOrigin(origin) ? origin : "https://pqp.gg";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function clickResponse(status: number, origin: string | null): Response {
  return new Response(null, {
    status,
    headers: { ...BASE_HEADERS, ...corsHeaders(origin) },
  });
}

/** Public increment of the Android download-button counter. No body, ever. */
async function handleApkClick(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin && !isAllowedClickOrigin(origin)) {
    return clickResponse(204, origin);
  }
  if (request.method === "OPTIONS") {
    return clickResponse(204, origin);
  }
  if (request.method !== "POST") {
    return clickResponse(404, origin);
  }

  const kv = env.APK_CLICKS;
  if (!kv) {
    return clickResponse(204, origin);
  }

  try {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const limited = await kv.get(`${APK_RATE_PREFIX}${ip}`);
    if (limited) {
      return clickResponse(204, origin);
    }

    const current = (await kv.get<ApkClickState>(APK_CLICKS_KEY, "json")) ?? emptyClicks();
    await Promise.all([
      kv.put(APK_CLICKS_KEY, JSON.stringify(bumpClicks(current))),
      kv.put(`${APK_RATE_PREFIX}${ip}`, "1", { expirationTtl: APK_RATE_TTL_SECONDS }),
    ]);
  } catch {
    // A failed increment must not become a 500 on a public beacon.
  }
  return clickResponse(204, origin);
}

async function readClicks(env: Env): Promise<{ state: ApkClickState | null; configured: boolean }> {
  if (!env.APK_CLICKS) {
    return { state: null, configured: false };
  }
  const state = (await env.APK_CLICKS.get<ApkClickState>(APK_CLICKS_KEY, "json")) ?? emptyClicks();
  return { state, configured: true };
}

/**
 * The API payload plus the Android block this Worker owns. A failed GitHub
 * read leaves `apkDownloads` null rather than inventing a zero.
 */
async function metricsWithDistribution(
  url: string,
  headers: Record<string, string>,
  env: Env,
): Promise<Response> {
  const repo = (env.GITHUB_REPO ?? "rafaelcg/pqp").replace(/^\/+|\/+$/g, "");
  const [upstream, clicks, github] = await Promise.all([
    fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    }).catch(() => null),
    readClicks(env),
    fetchGithubApkDownloads(repo),
  ]);
  if (!upstream) {
    return json(502, { error: "upstream unavailable" });
  }
  const text = await upstream.text();
  if (!upstream.ok) {
    return new Response(text, {
      status: upstream.status,
      headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8" },
    });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return new Response(text, {
      status: upstream.status,
      headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8" },
    });
  }
  body.distribution = distributionBlock(clicks.state, clicks.configured, github);
  return json(200, body);
}

/** Fetch an upstream JSON document and pass status + body through, nothing else. */
async function proxyJson(
  url: string,
  headers: Record<string, string>,
  init: { method?: string; body?: string } = {},
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(init.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: init.body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return json(502, { error: "upstream unavailable" });
  }
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * The operator controls: two reads and two writes, as an exact table.
 *
 * `forward` builds the upstream URL from the parameters this Worker is
 * willing to pass on, and never from the incoming query string wholesale: an
 * open query passthrough is a proxy nobody asked for, and the same reasoning
 * already governs `/occupancy`.
 *
 * A write's BODY is passed through untouched, because validating it here
 * would be a second copy of a Zod schema that the API already applies and
 * that would rot. The API answers 400 for anything that is not the shape, and
 * the page shows that answer.
 */
const OPERATOR_ROUTES: {
  method: "GET" | "PUT";
  path: string;
  forward: (url: URL, origin: string) => string;
}[] = [
  {
    method: "GET",
    path: "/operator/servers",
    forward: (url, origin) => {
      const upstream = new URL(`${origin}/api/admin/servers`);
      const q = url.searchParams.get("q");
      if (q) upstream.searchParams.set("q", q);
      return upstream.toString();
    },
  },
  {
    method: "GET",
    path: "/operator/channels",
    forward: (url, origin) => {
      const upstream = new URL(`${origin}/api/admin/server-channels`);
      upstream.searchParams.set("serverId", url.searchParams.get("serverId") ?? "");
      return upstream.toString();
    },
  },
  {
    method: "PUT",
    path: "/operator/server-live-hls",
    forward: (_url, origin) => `${origin}/api/admin/server-live-hls`,
  },
  {
    method: "PUT",
    path: "/operator/channel-transport",
    forward: (_url, origin) => `${origin}/api/admin/channel-voice-transport`,
  },
];

function matchOperatorRoute(method: string, path: string) {
  return (
    OPERATOR_ROUTES.find(
      (route) => route.method === method && route.path === path,
    ) ?? null
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/robots.txt") {
      return text(200, "User-agent: *\nDisallow: /\n");
    }

    // Public on purpose: the hosted site beacons here from a browser that
    // has no admin password. It increments a counter. It cannot read one.
    if (path === "/apk-click") {
      return handleApkClick(request, env);
    }

    // No password, no dashboard. A 503 rather than a 401, so the operator can
    // tell "not configured" from "wrong password" without reading logs.
    if (!env.ADMIN_DASH_PASSWORD) {
      return text(503, "dashboard not configured");
    }

    if (!isAuthorized(request, env)) {
      return unauthorized();
    }

    const origin = (env.API_ORIGIN ?? "").replace(/\/+$/, "");

    // The operator controls. Behind the same password as everything else and
    // forwarded on the same machine token; the page never holds either.
    const operatorRoute = matchOperatorRoute(request.method, path);
    if (operatorRoute) {
      if (!origin || !env.ADMIN_METRICS_TOKEN) {
        return json(503, { error: "operator controls not configured" });
      }
      return proxyJson(
        operatorRoute.forward(url, origin),
        { Authorization: `Bearer ${env.ADMIN_METRICS_TOKEN}` },
        {
          method: operatorRoute.method,
          body:
            operatorRoute.method === "PUT"
              ? await request.text()
              : undefined,
        },
      );
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json(404, { error: "not found" });
    }

    if (path === "/metrics") {
      if (!origin || !env.ADMIN_METRICS_TOKEN) {
        return json(503, { error: "metrics not configured" });
      }
      return metricsWithDistribution(
        `${origin}/api/admin/metrics`,
        { Authorization: `Bearer ${env.ADMIN_METRICS_TOKEN}` },
        env,
      );
    }

    // The voice-occupancy history behind the voz tab. Same token, same
    // timeout, same headers as /metrics; a separate route because it is a
    // separate read on a much slower cadence, and because the page asks for a
    // single day at minute resolution when somebody drills into one. Only
    // `days` and `day` are forwarded: the upstream ignores anything else and
    // an open query passthrough is a proxy nobody asked for.
    if (path === "/occupancy") {
      if (!origin || !env.ADMIN_METRICS_TOKEN) {
        return json(503, { error: "occupancy not configured" });
      }
      const upstream = new URL(`${origin}/api/admin/voice-occupancy`);
      const days = url.searchParams.get("days");
      const day = url.searchParams.get("day");
      if (days) upstream.searchParams.set("days", days);
      if (day) upstream.searchParams.set("day", day);
      return proxyJson(upstream.toString(), {
        Authorization: `Bearer ${env.ADMIN_METRICS_TOKEN}`,
      });
    }

    if (path === "/health") {
      if (!origin) {
        return json(503, { error: "health not configured" });
      }
      return proxyJson(`${origin}/status.json`, {});
    }

    // The page and the one script it loads. An allowlist rather than a
    // passthrough to the assets binding: this Worker must not be usable as an
    // asset lister or an open proxy, so a path that is not one of these two is
    // a 404 whatever happens to be in the bucket.
    const ASSETS: Record<string, string> = {
      "/": "/",
      "/index.html": "/",
      "/insights.js": "/insights.js",
    };
    const asset = ASSETS[path];
    if (asset) {
      // The Authorization header is stripped first: the asset store has no
      // use for it.
      const assetRequest = new Request(new URL(asset, url).toString(), {
        method: request.method,
      });
      return withBaseHeaders(await env.ASSETS.fetch(assetRequest));
    }

    return json(404, { error: "not found" });
  },
} satisfies ExportedHandler<Env>;
