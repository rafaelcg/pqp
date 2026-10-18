import type { IncomingMessage, ServerResponse } from "node:http";
import { computeEtag, ifNoneMatchSatisfiedBy } from "./etag.js";
import { logEvent } from "./log.js";

/**
 * Cap request bodies so a client can't exhaust memory by streaming an
 * unbounded payload (Zod limits only apply after the whole body is buffered).
 * No endpoint accepts anything close to this.
 */
export const MAX_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Allowed CORS origins. When CORS_ALLOWED_ORIGINS is set (comma-separated),
 * only those origins are echoed back; otherwise fall back to `*` so local dev
 * and self-hosting keep working out of the box.
 */
function allowedOrigins(): string[] | null {
  const raw = process.env.CORS_ALLOWED_ORIGINS;
  if (!raw) {
    return null;
  }
  const origins = raw
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return origins.length > 0 ? origins : null;
}

/**
 * Resolves the `Access-Control-Allow-Origin` value for a request, or null when
 * the browser should be left to block it.
 *
 * A request with no Origin header is not a browser CORS request (CLI,
 * server-to-server, same-origin) — CORS can't restrict it anyway, so stay
 * permissive. When an Origin is present, only echo it back if allowed; echoing
 * a *different* allowed origin would be wrong.
 */
export function resolveCorsOrigin(
  requestOrigin: string | undefined,
): string | null {
  const configured = allowedOrigins();
  if (!configured || !requestOrigin) {
    return "*";
  }
  return configured.includes(requestOrigin.replace(/\/$/, ""))
    ? requestOrigin
    : null;
}

/**
 * `resolveCorsOrigin` intentionally fails *open* to `*` when
 * CORS_ALLOWED_ORIGINS is unset, so local dev and self-hosting work with zero
 * config. That default is wrong for a production deploy, but flipping it to
 * fail-closed here could take a live site down the moment this ships, before
 * the operator has had a chance to set the env var. So: don't change the
 * behavior, just make it impossible to miss. Call once from the boot path
 * (alongside `assertAuthConfig`), not per-request — this must be loud and
 * singular, not noise the operator learns to ignore.
 */
export function assertCorsConfig(): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }
  if (!allowedOrigins()) {
    logEvent("cors.wildcard_in_production", {
      warning:
        "CORS_ALLOWED_ORIGINS is unset — the API answers every origin with '*'. Set CORS_ALLOWED_ORIGINS to lock this down.",
    });
  }
}

/**
 * How long a browser may reuse the answer to a CORS preflight. Chrome caps it
 * at 7200 (two hours), Firefox at 86400, Safari at 600, so 7200 is what a
 * Chromium browser will honour in full; the others clamp it themselves.
 *
 * Every authenticated call from `pqp.gg` to `api.pqp.gg` carries `Authorization`
 * and so is preflighted, once per distinct URL, and a preflight is a whole round
 * trip before the request (180 ms on the capture that found this, about a
 * third of all the time the page spent on API calls). The old ten minutes meant
 * a returning visitor paid them again for every URL they had loaded before. The
 * answer only describes which origin, methods and headers are allowed, and a
 * browser re-checks that against the cached entry on each use: a request that
 * needs a header the cached answer does not name simply preflights again, so a
 * deploy that widens the list is not held back by the longer cache.
 */
export const PREFLIGHT_MAX_AGE_SECONDS = 7200;

export function corsHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {
    // Every one of these has to be allowed explicitly or the preflight
    // refuses the request outright: a browser will not send a request
    // header the preflight did not name, and `Expose-Headers` is likewise
    // the only way cross-origin JS can read the `ETag` back off the
    // response. `Idempotency-Key` missing here is exactly the failure mode
    // pitfall 9 already warns about elsewhere in this codebase: a header
    // that works from same-origin curl and fails silently, as
    // `net::ERR_FAILED` on the preflight, everywhere the client and API are
    // on different origins (every hosted deploy, and any local setup where
    // the client's dev server and the API are not the same port).
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, If-None-Match, Idempotency-Key",
    "Access-Control-Expose-Headers": "ETag",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": String(PREFLIGHT_MAX_AGE_SECONDS),
  };

  const origin = resolveCorsOrigin(req.headers.origin);
  if (allowedOrigins()) {
    headers.Vary = "Origin";
  }
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/**
 * Headers that make sense for a JSON API and for the SPA we may also serve.
 * The API returns no HTML, so a maximally strict CSP is safe here.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

export function sendJson(
  res: ServerResponse,
  status: number,
  data: unknown,
  req?: IncomingMessage,
) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    // Stated, not left to Node: for a GET Node adds it itself, and for a HEAD
    // (which the public community reads now answer) it adds nothing, so
    // without this a HEAD would lack the header its GET carries.
    "Content-Length": String(Buffer.byteLength(body)),
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    ...(req ? corsHeaders(req) : { "Access-Control-Allow-Origin": "*" }),
  });
  res.end(body);
}

export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  req?: IncomingMessage,
) {
  sendJson(res, status, { error: message }, req);
}

/**
 * A3.1: what a DB-dependent route answers instead of queueing on a
 * saturated or unreachable pool for `connectionTimeoutMillis`. `Retry-After`
 * is a flat 5s rather than derived from the breaker's own cooldown — a
 * caller close enough to read `db.ts` internals to compute a better number
 * can also just retry sooner; this is a hint for everyone else, not a
 * promise the pool will be back by then.
 */
export function sendDatabaseUnavailable(
  res: ServerResponse,
  req?: IncomingMessage,
) {
  res.setHeader("Retry-After", "5");
  sendError(res, 503, "database_unavailable", req);
}

/**
 * A 200 with a validator, or a bodyless 304 when the caller already holds this
 * exact response.
 *
 * `Cache-Control` stays `no-store`, same as every other JSON response here.
 * That is not an oversight: these payloads are per-viewer and Bearer-authed, so
 * the only party allowed to keep one is the client that asked for it, and the
 * only thing this adds is letting *that* client revalidate cheaply. A
 * `max-age` would invite a shared proxy to hand one user's messages to the
 * next caller.
 *
 * Call this only with a body the caller has already been proved entitled to —
 * see `Etagged` in ./etag.ts.
 */
export function sendConditionalJson(
  req: IncomingMessage,
  res: ServerResponse,
  data: unknown,
): void {
  const serialized = JSON.stringify(data);
  const etag = computeEtag(serialized);
  const shared = {
    ETag: etag,
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    ...corsHeaders(req),
  };

  if (ifNoneMatchSatisfiedBy(req.headers["if-none-match"], etag)) {
    // No Content-Type and no body: a 304 carries neither, and writing one
    // makes clients that follow the spec (URLSession among them) misparse it.
    res.writeHead(304, shared);
    res.end();
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json", ...shared });
  res.end(serialized);
}

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const declared = Number(req.headers?.["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, "Request body too large");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      // Stop reading; the socket is torn down by the 413 response.
      throw new HttpError(413, "Request body too large");
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") {
    return {} as T;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export function handleCors(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...SECURITY_HEADERS,
      ...corsHeaders(req),
    });
    res.end();
    return true;
  }
  return false;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Path params reach Postgres as `uuid`, where a malformed value raises and
 * surfaces as a 500. Reject them at the edge instead.
 */
export function isUuid(value: string | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Clamp a caller-supplied page size into a range the database can serve. */
export function clampLimit(
  raw: string | null,
  fallback: number,
  max: number,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
}
