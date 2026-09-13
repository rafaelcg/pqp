import { createHmac, timingSafeEqual } from "node:crypto";
import type { LiveHlsStream } from "@pqp/shared";
import { playlistBaseUrl } from "./hls-egress.js";

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
  /**
   * What this capability is FOR: `"live"` (the default, and every token
   * minted before this claim existed) or `"replay"`
   * (`GET .../watch-party/history/:sessionAt/replay`).
   *
   * WHY THIS EXISTS. The claims otherwise name only a user, a channel and a
   * `startedAt` -- identical for a live viewer's token and a moderator's
   * replay token on the SAME broadcast, minted minutes apart from two
   * different, differently-authorised routes. Without a purpose, an ordinary
   * audience member's live-stream token (minted by `GET
   * /api/channels/:id/live`, gated only on ordinary channel access) verifies
   * just as well against the replay proxy, which is gated on
   * `START_WATCH_PARTY` / `MANAGE_CHANNELS` -- silently handing the audience
   * a door around the moderator-only surface. A caller that cares (the
   * replay proxy) passes `purpose: "replay"` on `verifyHlsViewerToken`'s
   * `expected` and a token minted for anything else, live tokens included,
   * fails verification. A caller that does not care (the live proxy, which
   * has never needed this) omits it and nothing about its behaviour changes.
   */
  p?: "live" | "replay";
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
  /** See `ViewerClaims.p`. Omitted (and stamped `"live"`) for every existing caller. */
  purpose?: "live" | "replay";
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
    p: input.purpose ?? "live",
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
  expected: {
    channelId: string;
    startedAt: number;
    /** See `ViewerClaims.p`. Omitted accepts a token of any purpose,
     * matching every caller before this claim existed. */
    purpose?: "live" | "replay";
  },
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
    claims.s !== expected.startedAt ||
    (expected.purpose !== undefined &&
      (claims.p ?? "live") !== expected.purpose)
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
 * WHY A CAPABILITY TOKEN DID NOT OPEN THE DOOR, in one word.
 *
 * `verifyHlsViewerToken` answers null for six unrelated reasons and the proxy
 * could not tell them apart, so a 401 said nothing at all. Finding the
 * hls.js/Clerk interaction that stalled every web viewer took an afternoon and
 * ended with a screenshot of somebody's browser, because the server had
 * nothing to say. These are the words it says now.
 *
 * Never includes the token, the signature or the user id: this exists to
 * explain a rejection in a log, not to help anybody reproduce one.
 */
export type HlsViewerTokenFailure =
  | "missing"
  | "unconfigured"
  | "malformed"
  | "bad-signature"
  | "expired"
  | "wrong-channel"
  | "wrong-session";

export function describeHlsViewerToken(
  token: string | null | undefined,
  expected: { channelId: string; startedAt: number },
  now = Date.now(),
): HlsViewerTokenFailure | null {
  if (!token) {
    return "missing";
  }
  const secret = viewerSecret();
  if (!secret) {
    // No key configured at all: every token fails and the Bearer path is the
    // only one that works. Worth its own word, because from the outside it
    // looks exactly like a signing bug.
    return "unconfigured";
  }
  const dot = token.lastIndexOf(".");
  if (dot <= 0) {
    return "malformed";
  }
  const payload = token.slice(0, dot);
  if (!equal(token.slice(dot + 1), sign(payload, secret))) {
    return "bad-signature";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return "malformed";
  }
  const claims = parsed as ViewerClaims | null;
  if (
    !claims ||
    typeof claims !== "object" ||
    claims.v !== 1 ||
    typeof claims.u !== "string" ||
    typeof claims.e !== "number"
  ) {
    return "malformed";
  }
  if (claims.c !== expected.channelId) {
    return "wrong-channel";
  }
  if (claims.s !== expected.startedAt) {
    // The common honest one: the egress restarted and this viewer is still
    // holding the previous session's capability. That should cost one clean
    // refetch, never a repeating rejection.
    return "wrong-session";
  }
  if (claims.e < now) {
    return "expired";
  }
  return null;
}

/**
 * The stream as one recipient should see it: the API-relative proxy path
 * with this user's token appended, then (`LIVE_HLS_PLAYLIST_BASE_URL`) the
 * edge host prepended, in that order. A full public URL
 * (`LIVE_HLS_SIGNED_URLS=false`) is passed through untouched, and so is the
 * stream when no key is configured (the Bearer path still works for hls.js).
 *
 * ORDER MATTERS. `stream.hlsUrl` arriving here is always the plain
 * API-relative path (`viewerPlaylistUrl` in `hls-egress.ts` never applies the
 * edge base itself, on purpose -- see that function's doc comment for the
 * bug this fixed: an already-absolute, not-yet-tokened URL looks exactly
 * like the `LIVE_HLS_SIGNED_URLS=false` case below and would have its token
 * skipped entirely). So the check below is still a reliable way to tell "an
 * already-public raw bucket URL" apart from "one of ours" -- it only has to
 * stay true for what THIS function is handed, not for what a caller further
 * down the line ends up with.
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
  return {
    ...stream,
    hlsUrl: withEdgeBase(appendToken(stream.hlsUrl, token)),
    // THE SAME TOKEN, because it is the same capability: it names the user,
    // the channel and the session, and the camera's playlist is a rendition
    // OF that session (`<startedAt>-cam360p30`). Minting a second one would
    // be a second thing that can expire at a different moment, which is
    // exactly the shape of the failure that stalled every web viewer once
    // already (CLAUDE.md pitfall 16).
    ...(stream.cameraHlsUrl && stream.cameraHlsUrl.startsWith("/")
      ? { cameraHlsUrl: withEdgeBase(appendToken(stream.cameraHlsUrl, token)) }
      : {}),
  };
}

function appendToken(url: string, token: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${HLS_VIEWER_TOKEN_PARAM}=${token}`;
}

/**
 * Prepends `LIVE_HLS_PLAYLIST_BASE_URL` (`playlistBaseUrl()` in
 * `hls-egress.ts`) to an already-tokened, API-relative playlist path, or
 * returns it unchanged when the flag is unset. The one and only place this
 * repo turns a signed playlist path into an edge URL -- see this function's
 * caller for why it has to happen here, after the token, and not earlier.
 */
function withEdgeBase(path: string): string {
  const edge = playlistBaseUrl();
  return edge ? `${edge}${path}` : path;
}

/** `/api/voice/hls-playlist/<channelId>/<startedAt>` -> channelId. */
function extractChannelId(path: string): string | null {
  const match = /^\/api\/voice\/hls-playlist\/([^/?]+)\//.exec(path);
  return match ? match[1]! : null;
}
