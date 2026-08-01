import type { IncomingMessage, ServerResponse } from "node:http";

/** Requests larger than this are rejected before we buffer them. */
export const MAX_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Origins allowed to call the API from a browser. Configured via `ALLOWED_ORIGINS`
 * (comma separated). Empty config keeps the previous permissive behaviour so a
 * self-host deploy that has not set it does not break — but hosted deploys
 * should always set it.
 */
function getAllowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

export function resolveCorsOrigin(
  requestOrigin: string | undefined,
): string | null {
  const allowed = getAllowedOrigins();
  if (allowed.length === 0) {
    return "*";
  }
  if (!requestOrigin) {
    return null;
  }
  const normalized = requestOrigin.replace(/\/$/, "");
  return allowed.includes(normalized) ? requestOrigin : null;
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = resolveCorsOrigin(
    Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin,
  );
  if (!origin) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "600",
    ...(origin === "*" ? {} : { Vary: "Origin" }),
  };
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
    ...(req ? corsHeaders(req) : {}),
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

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const declared = Number(req.headers["content-length"] ?? 0);
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
    const headers = corsHeaders(req);
    res.writeHead(Object.keys(headers).length > 0 ? 204 : 403, {
      ...SECURITY_HEADERS,
      ...headers,
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
