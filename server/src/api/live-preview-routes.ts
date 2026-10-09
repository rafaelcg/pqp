import type { IncomingMessage, ServerResponse } from "node:http";
import {
  COMMUNITY_SLUG_PATTERN,
  LIVE_PREVIEW_ENDED_ERROR,
  livePreviewStartSchema,
} from "@pqp/shared";
import { DatabaseUnavailableError } from "../db.js";
import {
  corsHeaders,
  HttpError,
  readJsonBody,
  SECURITY_HEADERS,
  sendDatabaseUnavailable,
  sendError,
  sendJson,
} from "../lib/http.js";
import { clientAddress, createRateLimiter } from "../lib/rate-limit.js";
import {
  listLivePreviewChannels,
  livePreviewMaybeOn,
  livePreviewSeconds,
  previewServerForInvite,
  previewServerForSlug,
  startLivePreview,
} from "../services/live-preview.js";

/**
 * THE SIGNED-OUT LIVE PREVIEW'S PUBLIC ROUTES, all three handled in
 * `handleApi` BEFORE the Bearer resolution (pitfall 8), so a header of any
 * quality (none, garbage, an expired Clerk JWT) changes nothing about them
 * (pitfall 16):
 *
 *  - `GET  /api/public/live-preview/communities/:slug`
 *  - `GET  /api/public/live-preview/invites/:code`
 *  - `POST /api/public/live-preview/start`
 *
 * NOT MATCHED AT ALL while `live_preview` is off everywhere
 * (`livePreviewMaybeOn`), so with the flag off these paths fall through to the
 * same 401 an unknown path gets today. With it on for some server, a slug or
 * code whose server does not qualify answers the same 404 as one that does not
 * exist, from one query, so the listing cannot sort communities into kinds.
 *
 * Each route has its own address-keyed bucket under `anonLimiter`, which
 * `handleApi` takes first for every request, the arrangement
 * `servePublicInvitePreview` set. A NEW window costs from a third, tighter
 * bucket; re-minting inside a window does not.
 */

const LISTING_COMMUNITY_PATH = /^\/api\/public\/live-preview\/communities\/([^/]{1,64})$/;
const LISTING_INVITE_PATH = /^\/api\/public\/live-preview\/invites\/([^/]{1,64})$/;
const START_PATH = "/api/public/live-preview/start";

/** Same alphabet `servePublicInvitePreview` accepts. */
const INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The listing: a streamer's link going around a group chat is many people at
 * once, and the answer is identical for all of them and cacheable for a few
 * seconds, so it is generous.
 */
const listingLimiter = createRateLimiter({ capacity: 60, refillPerSecond: 2 });
/** Every start call, fresh or not: a reload, a session restarting. */
const startLimiter = createRateLimiter({ capacity: 30, refillPerSecond: 1 });
/**
 * A NEW window. Generous enough for several people behind one carrier address
 * opening the same link, and slow enough that clearing storage over and over
 * is not a way to watch a whole film.
 */
const freshWindowLimiter = createRateLimiter({ capacity: 20, refillPerSecond: 0.2 });

export function resetLivePreviewRateLimits(): void {
  listingLimiter.reset();
  startLimiter.reset();
  freshWindowLimiter.reset();
}

/** Returns true when it answered the request. */
export async function handleLivePreviewRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith("/api/public/live-preview/")) {
    return false;
  }
  if (!livePreviewMaybeOn()) {
    return false;
  }
  const communityMatch = LISTING_COMMUNITY_PATH.exec(pathname);
  const inviteMatch = communityMatch ? null : LISTING_INVITE_PATH.exec(pathname);
  if (communityMatch || inviteMatch) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET, OPTIONS");
      sendError(res, 405, "Method not allowed", req);
      return true;
    }
    await serveListing(
      req,
      res,
      communityMatch
        ? { kind: "community", ref: communityMatch[1]! }
        : { kind: "invite", ref: inviteMatch![1]! },
    );
    return true;
  }
  if (pathname === START_PATH) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      sendError(res, 405, "Method not allowed", req);
      return true;
    }
    await serveStart(req, res);
    return true;
  }
  return false;
}

async function serveListing(
  req: IncomingMessage,
  res: ServerResponse,
  target: { kind: "community" | "invite"; ref: string },
): Promise<void> {
  const address = clientAddress(req as never);
  const key = `live-preview-list:${address}`;
  if (!listingLimiter.take(key)) {
    res.setHeader("Retry-After", String(listingLimiter.retryAfter(key)));
    sendError(res, 429, "Too many requests", req);
    return;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(target.ref);
  } catch {
    sendError(res, 404, "Not found", req);
    return;
  }
  const slug = target.kind === "community" ? decoded.toLowerCase() : decoded;
  const shapeOk =
    target.kind === "community"
      ? COMMUNITY_SLUG_PATTERN.test(slug)
      : INVITE_CODE_PATTERN.test(slug);
  if (!shapeOk) {
    sendError(res, 404, "Not found", req);
    return;
  }
  try {
    const serverId =
      target.kind === "community"
        ? await previewServerForSlug(slug)
        : await previewServerForInvite(slug);
    if (!serverId) {
      sendError(res, 404, "Not found", req);
      return;
    }
    const channels = await listLivePreviewChannels(serverId);
    // The same for every caller holding the link, and needed no credential:
    // a few seconds at a shared cache is what keeps a streamer's audience
    // arriving at once from being one query each. Short, because "is anything
    // live" is the whole question.
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=10",
      ...SECURITY_HEADERS,
      ...corsHeaders(req),
    });
    res.end(
      JSON.stringify({
        livePreview: { channels, seconds: livePreviewSeconds() },
      }),
    );
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      sendDatabaseUnavailable(res, req);
      return;
    }
    console.error("[live-preview] listing failed:", error);
    sendError(res, 503, "Live preview temporarily unavailable", req);
  }
}

async function serveStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const address = clientAddress(req as never);
  const key = `live-preview-start:${address}`;
  if (!startLimiter.take(key)) {
    res.setHeader("Retry-After", String(startLimiter.retryAfter(key)));
    sendError(res, 429, "Too many requests", req);
    return;
  }
  let body;
  try {
    body = livePreviewStartSchema.parse(await readJsonBody(req));
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.status, error.message, req);
      return;
    }
    // Includes a body without `ageConfirmed: true`: nothing plays for a
    // visitor who has not answered the age question on their device.
    sendError(res, 400, "Invalid request", req);
    return;
  }
  const freshKey = `live-preview-fresh:${address}`;
  try {
    const result = await startLivePreview({
      channelId: body.channelId,
      ticket: body.ticket ?? null,
      takeFreshTicket: () => freshWindowLimiter.take(freshKey),
    });
    if (result.kind === "ok") {
      sendJson(res, 200, result.body, req);
      return;
    }
    if (result.kind === "ended") {
      sendError(res, 403, LIVE_PREVIEW_ENDED_ERROR, req);
      return;
    }
    if (result.status === 429) {
      res.setHeader("Retry-After", String(freshWindowLimiter.retryAfter(freshKey)));
      sendError(res, 429, "Too many requests", req);
      return;
    }
    sendError(res, 404, "Not found", req);
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      sendDatabaseUnavailable(res, req);
      return;
    }
    console.error("[live-preview] start failed:", error);
    sendError(res, 503, "Live preview temporarily unavailable", req);
  }
}
