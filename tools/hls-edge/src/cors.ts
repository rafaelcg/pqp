/**
 * CORS, ported from `server/src/lib/http.ts`'s `corsHeaders` /
 * `resolveCorsOrigin` / `handleCors` and narrowed to what this Worker
 * actually serves (GET only — there is nothing here to POST to).
 *
 * Same default-open shape as the origin: `CORS_ALLOWED_ORIGINS` unset means
 * every origin is echoed back (`*` is not literally returned when an `Origin`
 * header is present, to keep credentialed requests working the same way the
 * origin's own fallback does), which is what a self-host with no allowlist
 * configured needs to keep working on day one. Set `CORS_ALLOWED_ORIGINS`
 * (comma-separated) to lock it down the same way the API's own env var does.
 */

function allowedOrigins(env: { CORS_ALLOWED_ORIGINS?: string }): string[] | null {
  const raw = env.CORS_ALLOWED_ORIGINS;
  if (!raw) {
    return null;
  }
  const origins = raw
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return origins.length > 0 ? origins : null;
}

function resolveCorsOrigin(
  env: { CORS_ALLOWED_ORIGINS?: string },
  requestOrigin: string | null,
): string | null {
  const configured = allowedOrigins(env);
  if (!configured || !requestOrigin) {
    return "*";
  }
  return configured.includes(requestOrigin.replace(/\/$/, ""))
    ? requestOrigin
    : null;
}

export function corsHeaders(
  env: { CORS_ALLOWED_ORIGINS?: string },
  request: Request,
): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Max-Age": "600",
  });
  if (allowedOrigins(env)) {
    headers.set("Vary", "Origin");
  }
  const origin = resolveCorsOrigin(env, request.headers.get("Origin"));
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

/** Layers CORS (and this Worker's own cache-status header, if set) onto a response, without touching its body. */
export function withCors(
  response: Response,
  env: { CORS_ALLOWED_ORIGINS?: string },
  request: Request,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of corsHeaders(env, request)) {
    headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

export function handleCorsPreflight(
  env: { CORS_ALLOWED_ORIGINS?: string },
  request: Request,
): Response | null {
  if (request.method !== "OPTIONS") {
    return null;
  }
  return new Response(null, { status: 204, headers: corsHeaders(env, request) });
}
