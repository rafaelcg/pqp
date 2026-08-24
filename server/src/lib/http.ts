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

export function corsHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {
    // `If-None-Match` has to be allowed explicitly or the preflight refuses the
    // conditional GET outright — a browser will not send a request header the
    // preflight did not name, and `Expose-Headers` is likewise the only way
    // cross-origin JS can read the `ETag` back off the response.
    "Access-Control-Allow-Headers": "Content-Type, Authorization, If-None-Match",
    "Access-Control-Expose-Headers": "ETag",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "600",
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
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    ...(req ? corsHeaders(req) : { "Access-Control-Allow-Origin": "*" }),
  });
  res.end(JSON.stringify(data));
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
