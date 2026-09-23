import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * SEGMENTS AT THE EDGE: the capability a conventional segment URL carries
 * when the bytes are served by `tools/hls-edge/` instead of straight from R2.
 *
 * WHY THIS EXISTS. With `LIVE_HLS_SEGMENT_BASE_URL` unset (the default, and
 * every deployment before this file), each segment line in a rendered
 * playlist is a presigned URL on the bucket's own S3 endpoint. Measured from
 * São Paulo on 2026-09-23 against `pqp-live-enam` (R2 location ENAM, the
 * closest R2 offers to Brazil): 177 ms time to first byte at p50 and 298 ms
 * at p99 for a 1.2 MB segment, HTTP/1.1 only, about 40 Mbit/s per connection,
 * and nothing in between that can cache, because the S3 endpoint is not a
 * cacheable zone. The same object out of the edge Worker's colo cache in
 * GRU: 20 ms at p50, 38 ms at p99, HTTP/2, 260 to 350 Mbit/s. A live
 * audience asks for the same segment within a second or two of each other,
 * so one R2 read per colo per segment serves the whole city.
 *
 * WHY A SESSION CAPABILITY AND NOT THE VIEWER'S `?t=`. The rendered playlist
 * is shared by every viewer of a rendition (`hls-playlist-proxy.ts`'s render
 * cache, and the edge Worker's own rendition cache), so the segment lines in
 * it cannot carry anything per viewer. That is also true today: a presigned
 * URL is signed with the BUCKET's credentials and names no viewer. This
 * token is the same shape of credential, bound tighter: one channel, one
 * session, one rendition, and an expiry equal to the presigned URL's
 * (`LIVE_HLS_URL_TTL_SECONDS`, 900 s by default). Whoever holds a rendered
 * playlist could already fetch its segments for that long; nobody without
 * one gets anything more than before.
 *
 * AND WHY IT MUST NOT CHANGE WHILE A SEGMENT IS LISTED. AVPlayer keys
 * fragments by URI (see `segmentSigningTime` in `hls-playlist-proxy.ts`), so
 * the token is minted with the same quantised signing instant the presigned
 * URLs use, and the proxy's per-segment memo keeps a listed segment on the
 * URL it was first handed out under. Two renders in one bucket produce the
 * same bytes on every machine, because nothing here reads per-process state.
 *
 * THE KEY. A fourth derived key from `CLERK_SECRET_KEY`, beside
 * `viewerSecret()` and `partySecret()` in `hls-viewer-token.ts`, with its
 * own `info` string so no other token kind can ever verify as this one. The
 * edge Worker holds the derived value as `HLS_SEGMENT_TOKEN_SECRET`, never
 * the Clerk key itself.
 */

/** The query parameter the capability travels in. Not `t`: see below. */
export const HLS_SEGMENT_TOKEN_PARAM = "s";

/**
 * The edge Worker's segment route. DELIBERATELY NOT under
 * `/api/voice/hls-playlist/`: the web client keys "attach a Bearer header
 * and swap in a fresher `?t=`" on that path (`isOwnHlsPlaylistProxyUrl` in
 * `client/src/lib/hls-playback.ts`), and a header on a segment request would
 * turn every fetch into a CORS preflight plus the request. A different path
 * keeps the segment request a simple GET, exactly as the R2 URL was.
 */
export const HLS_SEGMENT_ROUTE_PREFIX = "/api/voice/hls-segment";

interface SegmentClaims {
  v: 1;
  /** Kind. Guards against a future token kind signed with the same key. */
  k: "seg";
  c: string;
  s: number;
  /** The rung, or "" for a pre-ladder session's single rendition. */
  r: string;
  e: number;
}

function segmentSecret(): string | null {
  const raw = process.env.CLERK_SECRET_KEY
    ? process.env.CLERK_SECRET_KEY
    : process.env.DEV_AUTH_BYPASS === "true"
      ? "pqp-dev-hls-viewer"
      : null;
  if (!raw) {
    return null;
  }
  return createHmac("sha256", raw).update("pqp-hls-segment").digest("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * `LIVE_HLS_SEGMENT_BASE_URL`: the edge host that serves segment bytes, e.g.
 * `https://hls.pqp.gg`. Unset, empty, or not an http(s) URL: null, and the
 * proxy presigns R2 URLs exactly as it always has. Read per render, so the
 * flag takes effect on the next segment a live session lists, without a
 * session restart.
 */
export function hlsSegmentBaseUrl(): string | null {
  const raw = process.env.LIVE_HLS_SEGMENT_BASE_URL?.trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
  } catch {
    return null;
  }
  return raw.replace(/\/+$/, "");
}

export function mintHlsSegmentToken(input: {
  channelId: string;
  startedAt: number;
  rung?: string;
  expiresAt: number;
}): string | null {
  const secret = segmentSecret();
  if (!secret) {
    return null;
  }
  const claims: SegmentClaims = {
    v: 1,
    k: "seg",
    c: input.channelId,
    s: input.startedAt,
    r: input.rung ?? "",
    e: input.expiresAt,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export type HlsSegmentTokenFailure =
  | "missing"
  | "unconfigured"
  | "malformed"
  | "bad-signature"
  | "expired"
  | "wrong-channel"
  | "wrong-session"
  | "wrong-rendition";

/**
 * The file name prefix every segment of one rendition carries: LiveKit names
 * them `${filenamePrefix}_NNNNN.ts` and the prefix's last path element is
 * `${startedAt}` or `${startedAt}-${rung}` (`hlsObjectPrefix`).
 */
export function segmentNamePrefix(startedAt: number, rung: string): string {
  return rung ? `${startedAt}-${rung}_` : `${startedAt}_`;
}

/**
 * The server-side verifier. Production never calls it (the edge Worker has
 * its own port, `tools/hls-edge/src/hls-segment-token.js`); it exists so the
 * mint and the check live beside each other and a test can pin both.
 */
export function describeHlsSegmentToken(
  token: string | null | undefined,
  expected: { channelId: string; startedAt: number; name: string },
  now = Date.now(),
): HlsSegmentTokenFailure | null {
  if (!token) {
    return "missing";
  }
  const secret = segmentSecret();
  if (!secret) {
    return "unconfigured";
  }
  const dot = token.lastIndexOf(".");
  if (dot <= 0) {
    return "malformed";
  }
  const payload = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(sign(payload, secret));
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) {
    return "bad-signature";
  }
  let claims: SegmentClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return "malformed";
  }
  if (
    !claims ||
    typeof claims !== "object" ||
    claims.v !== 1 ||
    claims.k !== "seg" ||
    typeof claims.r !== "string" ||
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
  if (!expected.name.startsWith(segmentNamePrefix(expected.startedAt, claims.r))) {
    return "wrong-rendition";
  }
  if (claims.e < now) {
    return "expired";
  }
  return null;
}

/**
 * The URL a segment line is rewritten to when the edge serves segments, or
 * null when it cannot be (no base URL, no signing key, or a segment line the
 * edge route could not name), in which case the caller presigns as before.
 *
 * `key` is the object key the proxy would otherwise have signed:
 * `live/<channelId>/<file>`. Only a bare file directly under the channel's
 * own directory is eligible, which is every line LiveKit egress writes; the
 * edge route rebuilds exactly that key from the path, so anything else would
 * name an object the Worker refuses to read.
 */
export function edgeSegmentUrl(input: {
  base: string;
  channelId: string;
  startedAt: number;
  rung?: string;
  key: string;
  signedAtMs: number;
  ttlSeconds: number;
}): string | null {
  const dir = `live/${input.channelId}/`;
  if (!input.key.startsWith(dir)) {
    return null;
  }
  const name = input.key.slice(dir.length);
  // A camera run after the first writes `<startedAt>-<rung>-r<ms>_NNNNN.ts`
  // (`cameraRunNames` in hls-egress.ts). The token names that run as its
  // rendition, so the Worker's unchanged `startsWith` check holds it to that
  // run's files and no other.
  const run = input.rung
    ? new RegExp(`^${input.startedAt}-${escapeRegExp(input.rung)}(-r\\d{1,16})_`).exec(name)
    : null;
  const rung = run ? `${input.rung}${run[1]}` : input.rung;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/.test(name) ||
    !name.startsWith(segmentNamePrefix(input.startedAt, rung ?? "")) ||
    name.endsWith(".m3u8")
  ) {
    return null;
  }
  const token = mintHlsSegmentToken({
    channelId: input.channelId,
    startedAt: input.startedAt,
    rung,
    expiresAt: input.signedAtMs + input.ttlSeconds * 1_000,
  });
  if (!token) {
    return null;
  }
  return (
    `${input.base}${HLS_SEGMENT_ROUTE_PREFIX}/${encodeURIComponent(input.channelId)}` +
    `/${input.startedAt}/${name}?${HLS_SEGMENT_TOKEN_PARAM}=${token}`
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
