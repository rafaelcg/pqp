/**
 * pqp-jam-media-edge: public jam media at the edge.
 *
 * `GET|HEAD /jam-media/<token>?e=<unix seconds>&s=<signature>`, the exact path
 * shape `jamPublicMediaUrl` (server/src/services/jam-public-media.ts) mints
 * when `JAM_PUBLIC_MEDIA_BASE_URL` points at this host. Setting that variable
 * is the only switch; unsetting it puts the API back on presigned bucket URLs.
 *
 * WHY IT EXISTS. Public jam audio, video and covers used to be read by the
 * browser straight from the bucket's own endpoint. That is not a Cloudflare
 * cached hostname on our zone, so Cloudflare's CSAM Scanning Tool (which
 * works on content served through the cache of a zone) could not see it. This
 * Worker puts the bytes behind a hostname on our zone and through the colo
 * cache. What that does and does not buy is written down honestly in
 * docs/CONTENT_SAFETY.md and docs/JAM_PUBLIC.md: the tool's documentation
 * speaks of images, and public audio stays unscanned.
 *
 * WHAT IT DOES, IN ORDER.
 *
 *  1. Routes: OPTIONS (CORS preflight), GET and HEAD on `/jam-media/<token>`,
 *     `/health`. Everything else is a 404 or 405.
 *  2. The kill switch (`MEDIA_SERVING=off`): 503, no-store.
 *  3. The URL (`media-token.ts`): signature, expiry, decrypt to an object key
 *     that starts with `jam/`. The credential is checked on EVERY request,
 *     before any cache is looked at, so a cached object is never served to a
 *     URL that expired or never existed.
 *  4. The bytes: colo cache first (a stored 200 answers a Range with a 206),
 *     else R2 through the binding. A first request is served straight from R2
 *     (ranged when it asked for a range) and the whole object is put in the
 *     cache in the background when it is at most `CACHE_FILL_MAX_BYTES`.
 *  5. Headers: the stored Content-Type (only audio, video and image types a
 *     jam can hold are ever served), nosniff, CORS for the allowlist,
 *     `Cache-Control` no longer than the URL's own expiry.
 *
 * The R2 binding is only ever `get`/`head`, only for a key under `jam/`.
 */

import { logEvent } from "./log.js";
import { isServableJamKey, openJamMediaToken } from "./media-token.js";
import { parseRange, resolveRange, toR2Range, type ByteRange } from "./range.js";

export interface Env {
  /** The bucket the API signs jam objects into. Unbound: every request is a 503. */
  JAM_MEDIA?: R2Bucket;
  /** The API's DERIVED key (see README.md). Unset: every URL is refused with a 503. */
  JAM_PUBLIC_MEDIA_SECRET?: string;
  /** Comma separated exact origins that get CORS. */
  CORS_ALLOWED_ORIGINS?: string;
  /** `off` is the kill switch. */
  MEDIA_SERVING?: string;
}

export const MEDIA_ROUTE = "/jam-media/";
/**
 * How long the colo keeps an object, and so the most a browser is told to keep
 * it. Objects are immutable (a key carries a random UUID), so this is not
 * about freshness. It is the bound for an object the API DELETES (a deleted
 * track, an account deletion): a cached copy outlives the deletion by at most
 * this. README.md "How long a removal takes".
 */
export const CACHE_TTL_SECONDS = 600;
/** Whole-object cache fill ceiling: a 100 MiB video is the largest jam object, 64 MiB covers every audio take and cover. */
export const CACHE_FILL_MAX_BYTES = 64 * 1024 * 1024;

/** What a jam can hold (packages/shared/src/jam.ts). Nothing else is ever served, whatever a key says. */
const SERVABLE_TYPES = new Set([
  "audio/flac",
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "video/webm",
  "video/mp4",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const TYPE_BY_EXTENSION: Record<string, string> = {
  flac: "audio/flac",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  webm: "video/webm",
  mp4: "video/mp4",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const UNSET_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

/** The type to serve, or null when the object is not a type a jam holds. */
export function servableContentType(stored: string | undefined, key: string): string | null {
  const bare = (stored ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (SERVABLE_TYPES.has(bare)) {
    return bare;
  }
  if (UNSET_TYPES.has(bare)) {
    const extension = key.split(".").pop()?.toLowerCase() ?? "";
    return TYPE_BY_EXTENSION[extension] ?? null;
  }
  return null;
}

function allowedOrigins(env: Env): string[] {
  return (env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

/** CORS for an allowlisted origin only. `Vary: Origin` always, because the answer depends on it. */
function corsHeaders(env: Env, request: Request): Headers {
  const headers = new Headers({ Vary: "Origin" });
  const origin = request.headers.get("Origin")?.replace(/\/$/, "");
  if (origin && allowedOrigins(env).includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag");
  }
  return headers;
}

function withCors(response: Response, env: Env, request: Request): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of corsHeaders(env, request)) {
    headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

export function failure(status: number, reason: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
}

function preflight(env: Env, request: Request): Response {
  const headers = corsHeaders(env, request);
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Range, Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(null, { status: 204, headers });
}

interface ObjectFacts {
  contentType: string;
  size: number;
  etag: string | null;
}

/** The headers every successful answer carries, whichever way the bytes arrived. */
function mediaHeaders(
  facts: ObjectFacts,
  length: number,
  expires: number,
  nowMs: number,
  contentRange: string | null,
): Headers {
  const remaining = Math.max(0, expires - Math.floor(nowMs / 1000));
  const headers = new Headers({
    "Content-Type": facts.contentType,
    "Content-Length": String(length),
    "Accept-Ranges": "bytes",
    // Never longer than the URL that fetched it is good for.
    "Cache-Control": `public, max-age=${Math.min(CACHE_TTL_SECONDS, remaining)}`,
    "X-Content-Type-Options": "nosniff",
    // The page that plays this is on another origin (jam.pqp.gg).
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  if (facts.etag) {
    headers.set("ETag", facts.etag);
  }
  if (contentRange) {
    headers.set("Content-Range", contentRange);
  }
  return headers;
}

/** The cache key: the path, never the query. The token of one object never changes, so one object is one entry. */
function cacheKeyFor(request: Request, range?: string | null): Request {
  const url = new URL(request.url);
  url.search = "";
  return new Request(url.toString(), { method: "GET", headers: range ? { Range: range } : {} });
}

async function safeMatch(cache: Cache, key: Request): Promise<Response | undefined> {
  try {
    return await cache.match(key);
  } catch {
    logEvent("jamMedia.cacheReadError", {});
    return undefined;
  }
}

async function safePut(cache: Cache, key: Request, response: Response): Promise<void> {
  try {
    await cache.put(key, response);
  } catch {
    logEvent("jamMedia.cacheWriteError", {});
  }
}

/** The response `cache.put` stores: the whole object, with what a ranged hit needs (Content-Length). */
function storedResponse(body: ReadableStream | null, facts: ObjectFacts): Response {
  const headers = new Headers({
    "Content-Type": facts.contentType,
    "Content-Length": String(facts.size),
    "Accept-Ranges": "bytes",
    "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
  });
  if (facts.etag) {
    headers.set("ETag", facts.etag);
  }
  return new Response(body, { status: 200, headers });
}

// One background fill per object per isolate at a time.
const filling = new Set<string>();

/** For tests. */
export function resetFillsForTests(): void {
  filling.clear();
}

async function fillInBackground(bucket: R2Bucket, key: string, cache: Cache, cacheKey: Request): Promise<void> {
  const marker = cacheKey.url;
  if (filling.has(marker)) {
    return;
  }
  filling.add(marker);
  try {
    const object = await bucket.get(key);
    if (!object || object.size > CACHE_FILL_MAX_BYTES) {
      return;
    }
    const contentType = servableContentType(object.httpMetadata?.contentType, key);
    if (!contentType) {
      return;
    }
    await safePut(
      cache,
      cacheKey,
      storedResponse(object.body, { contentType, size: object.size, etag: object.httpEtag ?? null }),
    );
  } catch {
    logEvent("jamMedia.fillError", {});
  } finally {
    filling.delete(marker);
  }
}

async function fromCache(
  request: Request,
  env: Env,
  cache: Cache,
  expires: number,
  nowMs: number,
  range: ByteRange | null,
): Promise<Response | null> {
  const hit = await safeMatch(cache, cacheKeyFor(request, range ? request.headers.get("Range") : null));
  // Only a stored 200 or its 206 slice is an answer. A 416 the cache made up
  // for an out-of-range request has no total length, so the bucket path
  // (which knows the size) answers that one.
  if (!hit || (hit.status !== 200 && hit.status !== 206)) {
    return null;
  }
  const headers = new Headers(hit.headers);
  const length = Number(headers.get("Content-Length"));
  const facts: ObjectFacts = {
    contentType: headers.get("Content-Type") ?? "application/octet-stream",
    size: length,
    etag: headers.get("ETag"),
  };
  const out = mediaHeaders(facts, length, expires, nowMs, hit.status === 206 ? headers.get("Content-Range") : null);
  const response = new Response(request.method === "HEAD" ? null : hit.body, { status: hit.status, headers: out });
  // No log line per hit: hits are the frequent case and a log write per
  // request is a write amplifier. The Worker's own request analytics count them.
  return withCors(response, env, request);
}

async function fromBucket(
  request: Request,
  env: Env,
  bucket: R2Bucket,
  cache: Cache,
  ctx: ExecutionContext,
  key: string,
  expires: number,
  nowMs: number,
  range: ByteRange | null,
): Promise<Response> {
  const cacheKey = cacheKeyFor(request);

  if (request.method === "HEAD") {
    let head: R2Object | null;
    try {
      head = await bucket.head(key);
    } catch {
      // Same event and same answer as a GET that cannot reach R2.
      logEvent("jamMedia.originError", {});
      return withCors(failure(502, "origin-error"), env, request);
    }
    const contentType = head ? servableContentType(head.httpMetadata?.contentType, key) : null;
    if (!head || !contentType) {
      return withCors(failure(404, "not-found"), env, request);
    }
    const facts: ObjectFacts = { contentType, size: head.size, etag: head.httpEtag ?? null };
    return withCors(new Response(null, { status: 200, headers: mediaHeaders(facts, head.size, expires, nowMs, null) }), env, request);
  }

  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(key, range ? { range: toR2Range(range) } : undefined);
  } catch {
    // An offset past the end can throw. Ask for the size to tell 416 from a real fault.
    try {
      const head = await bucket.head(key);
      if (!head) {
        return withCors(failure(404, "not-found"), env, request);
      }
      if (range && resolveRange(range, head.size) === null) {
        return withCors(failure(416, "range-not-satisfiable", { "Content-Range": `bytes */${head.size}` }), env, request);
      }
    } catch {
      // fall through to the 502
    }
    logEvent("jamMedia.originError", {});
    return withCors(failure(502, "origin-error"), env, request);
  }
  if (!object) {
    return withCors(failure(404, "not-found"), env, request);
  }
  const contentType = servableContentType(object.httpMetadata?.contentType, key);
  if (!contentType) {
    // Something under jam/ that is not audio, video or a picture. Never served.
    void object.body.cancel();
    logEvent("jamMedia.refusedType", { stored: object.httpMetadata?.contentType ?? "" });
    return withCors(failure(404, "not-found"), env, request);
  }
  const facts: ObjectFacts = { contentType, size: object.size, etag: object.httpEtag ?? null };
  const fillable = object.size <= CACHE_FILL_MAX_BYTES;

  if (!range) {
    let body: ReadableStream = object.body;
    if (fillable) {
      const [toClient, toCache] = object.body.tee();
      body = toClient;
      ctx.waitUntil(safePut(cache, cacheKey, storedResponse(toCache, facts)));
    }
    logEvent("jamMedia.miss", { bytes: object.size });
    return withCors(new Response(body, { status: 200, headers: mediaHeaders(facts, object.size, expires, nowMs, null) }), env, request);
  }

  const window = resolveRange(range, object.size);
  if (!window) {
    void object.body.cancel();
    return withCors(failure(416, "range-not-satisfiable", { "Content-Range": `bytes */${object.size}` }), env, request);
  }
  if (fillable) {
    ctx.waitUntil(fillInBackground(bucket, key, cache, cacheKey));
  }
  logEvent("jamMedia.miss", { bytes: window.end - window.start + 1, ranged: true });
  const length = window.end - window.start + 1;
  return withCors(
    new Response(object.body, {
      status: 206,
      headers: mediaHeaders(facts, length, expires, nowMs, `bytes ${window.start}-${window.end}/${object.size}`),
    }),
    env,
    request,
  );
}

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  cache: Cache,
  nowMs: number = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return preflight(env, request);
  }
  if (url.pathname === "/health" && (request.method === "GET" || request.method === "HEAD")) {
    return new Response(request.method === "HEAD" ? null : "ok", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  if (!url.pathname.startsWith(MEDIA_ROUTE)) {
    return withCors(failure(404, "not-found"), env, request);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return withCors(failure(405, "method-not-allowed", { Allow: "GET, HEAD, OPTIONS" }), env, request);
  }
  if (env.MEDIA_SERVING === "off") {
    return withCors(failure(503, "serving-off", { "Retry-After": "60" }), env, request);
  }

  const token = url.pathname.slice(MEDIA_ROUTE.length);
  const opened = await openJamMediaToken(
    token,
    url.searchParams.get("e"),
    url.searchParams.get("s"),
    env.JAM_PUBLIC_MEDIA_SECRET,
    nowMs,
  );
  if ("failure" in opened) {
    const reason = opened.failure;
    logEvent("jamMedia.rejected", { reason });
    if (reason === "unconfigured") {
      return withCors(failure(503, reason), env, request);
    }
    return withCors(failure(reason === "malformed" ? 400 : 403, reason), env, request);
  }
  // Defence in depth: `openJamMediaToken` already refuses these.
  if (!isServableJamKey(opened.key)) {
    return withCors(failure(400, "malformed"), env, request);
  }
  if (!env.JAM_MEDIA) {
    // The API points viewers here and this deploy has no bucket bound.
    logEvent("jamMedia.bucketNotConfigured", {});
    return withCors(failure(503, "storage-not-configured"), env, request);
  }

  const range = parseRange(request.headers.get("Range"));
  const cached = await fromCache(request, env, cache, opened.expires, nowMs, range);
  if (cached) {
    return cached;
  }
  return fromBucket(request, env, env.JAM_MEDIA, cache, ctx, opened.key, opened.expires, nowMs, range);
}
