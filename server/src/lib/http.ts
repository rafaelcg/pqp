import type { IncomingMessage, ServerResponse } from "node:http";

// Cap request bodies so a client can't exhaust memory by streaming an
// unbounded payload (Zod limits only apply after the whole body is buffered).
const MAX_BODY_BYTES = 256 * 1024;

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
    .map((value) => value.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : null;
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const configured = allowedOrigins();
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  };

  if (!configured) {
    // No allowlist: permissive (fine for local dev / self-host).
    headers["Access-Control-Allow-Origin"] = "*";
    return headers;
  }

  // Allowlisted: only echo ACAO for an origin that is actually allowed. For a
  // disallowed (or missing) origin, omit ACAO so the browser blocks it —
  // echoing a *different* allowed origin would be an incorrect per-request
  // decision and just produces confusing failures.
  const requestOrigin = req.headers.origin;
  headers.Vary = "Origin";
  if (requestOrigin && configured.includes(requestOrigin)) {
    headers["Access-Control-Allow-Origin"] = requestOrigin;
  }
  return headers;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  data: unknown,
  req?: IncomingMessage,
) {
  res.writeHead(status, {
    "Content-Type": "application/json",
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

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(413, "Request body too large");
    }
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
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
    sendJson(res, 204, null, req);
    return true;
  }
  return false;
}
