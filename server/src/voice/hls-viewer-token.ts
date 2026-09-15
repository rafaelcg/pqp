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
 * `LIVE_HLS_VIEWER_TOKEN_TTL_MS` lets an operator move that number without a
 * code change; the default below is unchanged. `hls-revocation.ts` reads the
 * SAME effective value for its own pruning window, so raising the TTL also
 * raises how long a revocation entry has to be remembered -- the two are one
 * decision, not two.
 *
 * The token names no objects; the presigned segment URLs the proxy writes
 * expire on their own (`LIVE_HLS_URL_TTL_SECONDS`).
 *
 * The key is derived from `CLERK_SECRET_KEY` (purpose-bound, same reasoning
 * as `voice-resume-token.ts`), so production needs no new secret.
 */

export const HLS_VIEWER_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * The TTL actually used for freshly-minted viewer tokens:
 * `LIVE_HLS_VIEWER_TOKEN_TTL_MS` overriding the default above. Read live
 * (not cached) so a config change takes effect on the next mint with no
 * restart -- the same reasoning as every other `positiveIntFromEnv` knob in
 * `hls-egress.ts`. An unset or non-positive value keeps the default.
 */
export function hlsViewerTokenTtlMs(): number {
  const raw = Number(process.env.LIVE_HLS_VIEWER_TOKEN_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : HLS_VIEWER_TOKEN_TTL_MS;
}

/** Query parameter name on the proxy URL. */
export const HLS_VIEWER_TOKEN_PARAM = "t";

/**
 * The hard ceiling on a party pass's own life, regardless of
 * `LIVE_HLS_PARTY_PASS_TTL_MS`. "Party-lifetime" is an aspiration, not a
 * measurement -- the mint site does not know when the session will end -- so
 * this is the longest a single watch party is expected to run plus margin,
 * not a promise that the pass outlives every party.
 */
export const LIVE_HLS_PARTY_PASS_MAX_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * The TTL actually used for freshly-minted party passes, bounded by
 * `LIVE_HLS_PARTY_PASS_MAX_TTL_MS` no matter what the env says -- an operator
 * can only SHORTEN this window, never lengthen it past the ceiling, because
 * the ceiling is a policy decision (how long a leaked or over-shared pass can
 * cost a channel) and not merely a default. `0` disables minting entirely:
 * `mintHlsPartyPass` returns null, `stampViewerStream` omits `?pp=`, and the
 * edge Worker falls back to gating on the short-lived `?t=` alone, exactly
 * as it did before this existed.
 */
export function hlsPartyPassTtlMs(): number {
  const raw = Number(process.env.LIVE_HLS_PARTY_PASS_TTL_MS);
  if (!Number.isFinite(raw) || raw < 0) {
    return LIVE_HLS_PARTY_PASS_MAX_TTL_MS;
  }
  return Math.min(Math.floor(raw), LIVE_HLS_PARTY_PASS_MAX_TTL_MS);
}

/** Query parameter name for the party pass (see `mintHlsPartyPass` below). */
export const HLS_PARTY_PASS_PARAM = "pp";

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
    e: issuedAt + hlsViewerTokenTtlMs(),
    i: issuedAt,
    p: input.purpose ?? "live",
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  return `${payload}.${sign(payload, secret)}`;
}

/** Everything a token names, once its signature and expiry check out. */
export interface HlsViewerTokenClaims {
  userId: string;
  channelId: string;
  startedAt: number;
  issuedAt: number;
  purpose: "live" | "replay";
}

/**
 * Verify a token's signature and expiry ONLY, returning what it claims about
 * itself rather than checking those claims against an expected channel and
 * session. `verifyHlsViewerToken` below is the door a caller who already
 * knows which channel/session to expect should use; this is for a caller
 * that does not know that yet and wants the token to NAME it instead --
 * BROADCAST_PIPELINE B0.6's telemetry route, which binds a batch's session
 * identity to this rather than trusting a client-supplied string (a Farol
 * finding, 2026-09-13: an authenticated caller could otherwise claim any
 * session id it liked).
 */
export function decodeHlsViewerToken(
  token: string | null | undefined,
  now = Date.now(),
): HlsViewerTokenClaims | null {
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
    typeof claims.c !== "string" ||
    typeof claims.s !== "number" ||
    typeof claims.e !== "number" ||
    claims.e < now
  ) {
    return null;
  }
  return {
    userId: claims.u,
    channelId: claims.c,
    startedAt: claims.s,
    issuedAt:
      typeof claims.i === "number"
        ? claims.i
        : claims.e - HLS_VIEWER_TOKEN_TTL_MS,
    purpose: claims.p ?? "live",
  };
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
  const claims = decodeHlsViewerToken(token, now);
  if (
    !claims ||
    claims.channelId !== expected.channelId ||
    claims.startedAt !== expected.startedAt ||
    (expected.purpose !== undefined && claims.purpose !== expected.purpose)
  ) {
    return null;
  }
  return { userId: claims.userId, issuedAt: claims.issuedAt };
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
 * THE PARTY PASS: a second, longer-lived capability for the edge Worker
 * ONLY, never for this API's own playlist proxy.
 *
 * WHY A SEPARATE TOKEN AND NOT A LONGER `HLS_VIEWER_TOKEN_TTL_MS`. The
 * viewer token's TTL is deliberately short (see the module doc above) because
 * `hls-playlist-proxy.ts` re-checks `hls-revocation.ts` on every request it
 * actually serves, so a longer TTL there buys nothing and only widens the
 * share-the-URL window. The edge Worker (`tools/hls-edge/`) is different: it
 * exists precisely to answer most requests WITHOUT an origin round trip, so
 * pinning it to the same short TTL means every viewer's playback still stalls
 * once an hour waiting on the reactive refresh (claim 8,
 * `docs/plans/BROADCAST_PIPELINE.md`). A party-lifetime credential fixes that
 * for the one consumer that can safely hold it.
 *
 * WHY A DIFFERENT SECRET, NOT A CLAIM ON THE SAME TOKEN. `partySecret()`
 * derives an entirely different HMAC key from the same root secret (a
 * different `info` string, same pattern as `viewerSecret()`). That is what
 * makes "the API keeps the short TTL for its own proxy" true BY CONSTRUCTION
 * rather than by convention: `verifyHlsViewerToken` cannot verify a party
 * pass and `verifyHlsPartyPass` cannot verify a viewer token, so there is no
 * call site anywhere that could accidentally accept one as the other, now or
 * after a future edit. A shared claim (`p: "party"` on the existing shape)
 * would have needed every current and future caller of
 * `verifyHlsViewerToken` to remember to exclude it; a second key needs
 * nobody to remember anything.
 *
 * WHAT IT IS BOUND TO. Exactly the same triple as a viewer token -- user,
 * channel, session (`startedAt`) -- so it is useless for any other viewer,
 * any other channel, or a later session on the same channel. "Bound to the
 * session" is this, not a server-side revocation on session end: the pass
 * keeps verifying, on the Worker, until its own `e` claim passes, even if the
 * session it names has since ended. That is fine -- a finished session has
 * no live playlist left to serve, so an outlived pass has nothing to reach.
 *
 * THE REVOCATION TRADE-OFF, STATED PLAINLY. The Worker's own check
 * (`hls-viewer-token.js`'s port of the functions below) answers "is this
 * signature valid, for this channel and session, and not yet expired" --
 * nothing else. It has no path to `hls-revocation.ts`, which lives only on
 * this process's memory. So a viewer banned or kicked mid-party keeps a
 * PARTY PASS working for as long as the pass itself has left to live (up to
 * `LIVE_HLS_PARTY_PASS_MAX_TTL_MS`), not for the few seconds a viewer token
 * would have cost them. Today that gap is closed only by the ordinary paths
 * that already stop RECEIVING the stream (an eviction pulls the viewer out of
 * the channel and the voice room in the same instant, same as always) --
 * this is specifically about someone who kept the tokened URL after losing
 * access and pastes it back in. See `tools/hls-edge/README.md` and the
 * `isPartyPassRevoked` TODO in `tools/hls-edge/src/index.ts` for the KV-based
 * denylist hook this trade-off is asking to be closed with, once an operator
 * decides the gap is worth a KV namespace and a write from `hls-revocation.ts`.
 */
interface PartyPassClaims {
  v: 1;
  u: string;
  c: string;
  s: number;
  e: number;
  i: number;
}

function partySecret(): string | null {
  const raw = process.env.CLERK_SECRET_KEY
    ? process.env.CLERK_SECRET_KEY
    : process.env.DEV_AUTH_BYPASS === "true"
      ? "pqp-dev-hls-viewer"
      : null;
  if (!raw) {
    return null;
  }
  // A DIFFERENT `info` string than `viewerSecret()` -- see the doc comment
  // above for why this, and not a claim, is what keeps the two token kinds
  // from ever verifying as each other.
  return createHmac("sha256", raw).update("pqp-hls-party-pass").digest("base64url");
}

/**
 * Mints a party pass, or null when no key is configured or the operator has
 * set `LIVE_HLS_PARTY_PASS_TTL_MS=0` (disabled). Called from
 * `stampViewerStream`, and only when the edge host is actually configured --
 * a pass nobody's Worker will ever check is wasted bytes on every URL.
 */
export function mintHlsPartyPass(input: {
  userId: string;
  channelId: string;
  startedAt: number;
  now?: number;
}): string | null {
  const ttl = hlsPartyPassTtlMs();
  if (ttl <= 0) {
    return null;
  }
  const secret = partySecret();
  if (!secret) {
    return null;
  }
  const issuedAt = input.now ?? Date.now();
  const claims: PartyPassClaims = {
    v: 1,
    u: input.userId,
    c: input.channelId,
    s: input.startedAt,
    e: issuedAt + ttl,
    i: issuedAt,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * The user id a party pass was issued to, and when, or null. Same shape and
 * the same checks as `verifyHlsViewerToken`, against the party secret
 * instead -- see that function's doc comment for what each field guards.
 */
export function verifyHlsPartyPass(
  token: string | null | undefined,
  expected: { channelId: string; startedAt: number },
  now = Date.now(),
): { userId: string; issuedAt: number } | null {
  if (!token) {
    return null;
  }
  const secret = partySecret();
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
  const claims = parsed as PartyPassClaims;
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
  return { userId: claims.u, issuedAt: claims.i };
}

/** Same failure vocabulary as `HlsViewerTokenFailure`, for the same reason. */
export type HlsPartyPassFailure =
  | "missing"
  | "unconfigured"
  | "malformed"
  | "bad-signature"
  | "expired"
  | "wrong-channel"
  | "wrong-session";

export function describeHlsPartyPass(
  token: string | null | undefined,
  expected: { channelId: string; startedAt: number },
  now = Date.now(),
): HlsPartyPassFailure | null {
  if (!token) {
    return "missing";
  }
  const secret = partySecret();
  if (!secret) {
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
  const claims = parsed as PartyPassClaims | null;
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
  const channelId = extractChannelId(stream.hlsUrl) ?? "";
  const token = mintHlsViewerToken({
    userId,
    channelId,
    startedAt: stream.startedAt,
  });
  if (!token) {
    return stream;
  }
  // The party pass rides ALONGSIDE `?t=`, never instead of it: the edge
  // Worker checks `t` first and only falls back to `pp` once `t` has expired
  // (see `tools/hls-edge/src/index.ts`), and this API's own proxy never
  // looks at `pp` at all. Minted only when there is an edge host to hand it
  // to -- see `mintHlsPartyPass`'s doc comment for why nobody else needs one.
  const edge = playlistBaseUrl();
  const partyPass = edge
    ? mintHlsPartyPass({ userId, channelId, startedAt: stream.startedAt })
    : null;
  const withParams = (path: string): string =>
    partyPass
      ? appendParam(appendToken(path, token), HLS_PARTY_PASS_PARAM, partyPass)
      : appendToken(path, token);
  return {
    ...stream,
    hlsUrl: withEdgeBase(withParams(stream.hlsUrl)),
    // THE SAME TOKEN, because it is the same capability: it names the user,
    // the channel and the session, and the camera's playlist is a rendition
    // OF that session (`<startedAt>-cam360p30`). Minting a second one would
    // be a second thing that can expire at a different moment, which is
    // exactly the shape of the failure that stalled every web viewer once
    // already (CLAUDE.md pitfall 16). The party pass is exempt from that
    // rule on purpose: it is a SEPARATE credential kind by construction (see
    // its doc comment), so reusing the same one for both renditions is a
    // convenience, not a requirement the way the viewer token's reuse is.
    ...(stream.cameraHlsUrl && stream.cameraHlsUrl.startsWith("/")
      ? { cameraHlsUrl: withEdgeBase(withParams(stream.cameraHlsUrl)) }
      : {}),
  };
}

function appendToken(url: string, token: string): string {
  return appendParam(url, HLS_VIEWER_TOKEN_PARAM, token);
}

function appendParam(url: string, key: string, value: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${value}`;
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
