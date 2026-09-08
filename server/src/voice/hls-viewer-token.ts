import { createHmac, timingSafeEqual } from "node:crypto";
import type { LiveHlsStream } from "@pqp/shared";

/**
 * A signed query token for the playlist proxy (`hls-playlist-proxy.ts`).
 *
 * WHY. The proxy route is Bearer-authed like every other route, and hls.js
 * can attach that header through `xhrSetup`. Safari's native player and the
 * iOS app cannot: `<video src>` carries no headers, and neither does the
 * readiness probe in `use-live-hls-src.ts`. So the URL a viewer is handed
 * carries its own proof: `?t=<token>`, minted per recipient when the
 * `voice-stream` / `channel-live` frame is sent, bound to that user, that
 * channel and that session (`startedAt`). The proxy accepts either the
 * Bearer header or a valid token, and in both cases still asks whether the
 * user may view the channel on every request, so a ban mid-stream cuts the
 * stream on the next playlist refresh (2 s) rather than at token expiry.
 *
 * TTL, and why it is not 60 seconds. Since the proxy serves a verified token
 * without a database round trip, the token is a capability, so how long it
 * lives is a real question. Two different risks, bounded by two different
 * things:
 *
 *  - Someone who LOSES access (banned, kicked, a role losing VIEW) is bounded
 *    by `hls-revocation.ts`, not by this: the eviction that removes them
 *    records it, and the proxy refuses their next playlist fetch. Worst case
 *    is one segment, about 2 seconds, whatever the TTL says.
 *  - Someone who SHARES their URL is bounded by this TTL, and only by it.
 *
 * So the TTL is set as short as it can go without interrupting anybody. It
 * cannot go to a minute: the native player (iOS Safari, and any browser
 * without MSE) refetches the SAME URL for the whole watch and cannot be
 * handed a fresh one without restarting the element, so a one-minute TTL
 * would re-buffer every viewer on that path once a minute, all party long.
 * An hour is longer than the sharing window wants and shorter than a party,
 * and it also bounds how long the revocation set has to remember anything.
 *
 * The token names no objects; the presigned segment URLs the proxy writes
 * expire on their own (`LIVE_HLS_URL_TTL_SECONDS`).
 *
 * The key is derived from `CLERK_SECRET_KEY` (purpose-bound, same reasoning
 * as `voice-resume-token.ts`), so production needs no new secret.
 */

export const HLS_VIEWER_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Query parameter name on the proxy URL. */
export const HLS_VIEWER_TOKEN_PARAM = "t";

interface ViewerClaims {
  v: 1;
  u: string;
  c: string;
  s: number;
  e: number;
  /**
   * Issued-at. The revocation set (`hls-revocation.ts`) compares this against
   * when access was taken away, so a viewer who was banned and then unbanned
   * is not held out by the old entry: their NEW token postdates it. Older
   * tokens without this claim fall back to `e - TTL`, which is the same
   * number for every token this code has ever minted.
   */
  i?: number;
}

function viewerSecret(): string | null {
  const raw = process.env.CLERK_SECRET_KEY
    ? process.env.CLERK_SECRET_KEY
    : process.env.DEV_AUTH_BYPASS === "true"
      ? "pqp-dev-hls-viewer"
      : null;
  if (!raw) {
    return null;
  }
  return createHmac("sha256", raw).update("pqp-hls-viewer").digest("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function mintHlsViewerToken(input: {
  userId: string;
  channelId: string;
  startedAt: number;
  now?: number;
}): string | null {
  const secret = viewerSecret();
  if (!secret) {
    return null;
  }
  const issuedAt = input.now ?? Date.now();
  const claims: ViewerClaims = {
    v: 1,
    u: input.userId,
    c: input.channelId,
    s: input.startedAt,
    e: issuedAt + HLS_VIEWER_TOKEN_TTL_MS,
    i: issuedAt,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * The user id the token was issued to, and when, or null. Bound to the exact
 * channel and session: a token for last night's stream, or another channel's,
 * is not a token at all.
 *
 * `issuedAt` is what makes this a capability rather than just an identity:
 * the playlist proxy serves a verified token with NO database round trip, and
 * asks only whether access was revoked after this instant.
 */
export function verifyHlsViewerToken(
  token: string | null | undefined,
  expected: { channelId: string; startedAt: number },
  now = Date.now(),
): { userId: string; issuedAt: number } | null {
  if (!token) {
    return null;
  }
  const secret = viewerSecret();
  if (!secret) {
    return null;
  }
  const dot = token.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!equal(mac, sign(payload, secret))) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const claims = parsed as ViewerClaims;
  if (
    claims.v !== 1 ||
    typeof claims.u !== "string" ||
    typeof claims.e !== "number" ||
    claims.e < now ||
    claims.c !== expected.channelId ||
    claims.s !== expected.startedAt
  ) {
    return null;
  }
  return {
    userId: claims.u,
    issuedAt:
      typeof claims.i === "number"
        ? claims.i
        : claims.e - HLS_VIEWER_TOKEN_TTL_MS,
  };
}

/**
 * The stream as one recipient should see it: the API-relative proxy path
 * with this user's token appended. A full public URL
 * (`LIVE_HLS_SIGNED_URLS=false`) is passed through untouched, and so is the
 * stream when no key is configured (the Bearer path still works for hls.js).
 */
export function stampViewerStream(
  stream: LiveHlsStream,
  userId: string,
): LiveHlsStream {
  if (!stream.hlsUrl.startsWith("/")) {
    return stream;
  }
  const token = mintHlsViewerToken({
    userId,
    channelId: extractChannelId(stream.hlsUrl) ?? "",
    startedAt: stream.startedAt,
  });
  if (!token) {
    return stream;
  }
  const separator = stream.hlsUrl.includes("?") ? "&" : "?";
  return {
    ...stream,
    hlsUrl: `${stream.hlsUrl}${separator}${HLS_VIEWER_TOKEN_PARAM}=${token}`,
  };
}

/** `/api/voice/hls-playlist/<channelId>/<startedAt>` -> channelId. */
function extractChannelId(path: string): string | null {
  const match = /^\/api\/voice\/hls-playlist\/([^/?]+)\//.exec(path);
  return match ? match[1]! : null;
}
