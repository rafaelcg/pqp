/**
 * CONVENTIONAL SEGMENTS AT THE EDGE: `GET /api/voice/hls-segment/:channelId/:startedAt/:name?s=`.
 *
 * WHY THIS EXISTS. Until this route, a conventional rung's segment bytes went
 * from every viewer's player straight to R2's S3 endpoint on a presigned URL
 * (`hls-playlist-proxy.ts`). The bucket lives in ENAM (eastern North America,
 * the nearest location R2 offers to Brazil) and the S3 endpoint is not a
 * cacheable zone, so every viewer in São Paulo paid a trip to Virginia for
 * every segment, over HTTP/1.1. Measured from two São Paulo boxes on
 * 2026-09-23, 1.2 MB segments: 177 ms time to first byte at p50, 298 ms at
 * p99, ~40 Mbit/s per connection. The same bytes from this Worker's colo
 * cache: 20 ms at p50, 38 ms at p99, HTTP/2, 260 to 350 Mbit/s. A live
 * audience asks for the same segment within a couple of seconds of itself,
 * so one R2 read per colo per segment serves the whole city.
 *
 * WHAT IT DOES, IN ORDER.
 *
 *  1. **The name**, before any credential work: a segment name LiveKit
 *     egress writes, never a playlist (`.m3u8`), and one that starts with
 *     this session's `startedAt`. Anything else is a 404, the same answer an
 *     unmatched path gets.
 *  2. **The capability** (`?s=`, `hls-segment-token.js`): minted by the API
 *     into the shared playlist, scoped to channel + session + rendition, and
 *     expiring with `LIVE_HLS_URL_TTL_SECONDS`. 401/403 with the reason word
 *     otherwise, rate-limited as `hlsEdge.segmentRejected`.
 *  3. **The bytes**, through `serveImmutableMedia` (`ll-media.ts`), the
 *     path LL parts already take: colo cache keyed on the PATH (never the
 *     token), one R2 read per key per isolate however many viewers arrive at
 *     once, bounded joins, a hard timeout. `Cache-Control: public,
 *     max-age=31536000, immutable`, because a segment's name carries its
 *     sequence number and is never rewritten.
 *  4. **Range**, for players that ask for part of a segment (AVPlayer does,
 *     occasionally): served from the same cached bytes as a 206.
 *
 * THE OBJECT KEY IS REBUILT FROM THE PATH, `live/<channelId>/<name>`, which is
 * `hlsObjectPrefix`'s layout. The token binds the channel, the session and
 * the rendition prefix of `<name>`, so a valid token for one rendition can
 * never read another channel's object, another session's, or a sibling
 * rung's. The R2 binding (`LIVE_SEGMENTS`) is read-only in practice: this
 * module only ever calls `get`.
 */

import { logEvent } from "./log.js";
import {
  serveImmutableMedia,
  type LlMediaOrigin,
  type LlMediaTimers,
} from "./ll-media.js";
import { describeHlsSegmentToken, HLS_SEGMENT_TOKEN_PARAM } from "./hls-segment-token.js";
import { logRejection, statusForRejection } from "./viewer-access.js";
import { parseSegmentPath, type SegmentRouteMatch } from "./playlist-route.js";

export interface SegmentEnv {
  /** The live-HLS bucket (`pqp-live-enam` in production). Unbound: 503. */
  LIVE_SEGMENTS?: R2Bucket;
  /** HMAC-SHA256(CLERK_SECRET_KEY, "pqp-hls-segment"), base64url. Unset: every token is refused. */
  HLS_SEGMENT_TOKEN_SECRET?: string;
}

/** What LiveKit egress writes for a rendition: `.ts` segments (and `.m4s`/`.aac` for the formats it could be asked for). */
const SEGMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}\.(?:ts|m4s|aac|mp4)$/;

/**
 * Reads a segment out of R2 through the Worker binding. Shaped as an
 * `LlMediaOrigin` so the shared serving path needs no second implementation:
 * a missing object is a 404 (never cached), anything the binding throws is
 * an origin error (502, never cached).
 */
export class R2SegmentOrigin implements LlMediaOrigin {
  private readonly bucket: R2Bucket | undefined;

  constructor(bucket: R2Bucket | undefined) {
    this.bucket = bucket;
  }

  get ready(): boolean {
    return this.bucket !== undefined;
  }

  async fetchMedia(
    channelId: string,
    _startedAt: string,
    name: string,
  ): Promise<{ status: number; ok: boolean; body: ArrayBuffer }> {
    const object = await this.bucket!.get(`live/${channelId}/${name}`);
    if (!object) {
      return { status: 404, ok: false, body: new ArrayBuffer(0) };
    }
    return { status: 200, ok: true, body: await object.arrayBuffer() };
  }
}

/** `1790026895736-720p30_00042.ts` -> `720p30`; `1790026895736_00042.ts` -> `-`. For logs only. */
function rungFromName(startedAt: string, name: string): string {
  const rest = name.slice(startedAt.length);
  if (!rest.startsWith("-")) {
    return "-";
  }
  const underscore = rest.indexOf("_");
  return underscore > 1 ? rest.slice(1, underscore) : "-";
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * A single `bytes=` range served out of a full 200 response, or the response
 * untouched. Segments are at most a few MB, and a range request for one is
 * rare, so buffering it here is cheaper than a second cache layout.
 */
export async function applyRange(request: Request, response: Response): Promise<Response> {
  const range = request.headers.get("Range");
  if (response.status !== 200) {
    return response;
  }
  if (!range) {
    const headers = new Headers(response.headers);
    headers.set("Accept-Ranges", "bytes");
    return new Response(response.body, { status: 200, headers });
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  const body = await response.arrayBuffer();
  const size = body.byteLength;
  let start: number;
  let end: number;
  if (!match || (match[1] === "" && match[2] === "")) {
    // Several ranges, or garbage: serve the whole object, which RFC 9110
    // allows a server to do for any Range it chooses not to honour.
    const headers = new Headers(response.headers);
    headers.set("Accept-Ranges", "bytes");
    return new Response(body, { status: 200, headers });
  }
  if (match[1] === "") {
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}`, "Cache-Control": "no-store" },
    });
  }
  const headers = new Headers(response.headers);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(body.slice(start, end + 1), { status: 206, headers });
}

export async function handleSegmentRequest(
  request: Request,
  env: SegmentEnv,
  cache: Cache,
  ctx: ExecutionContext,
  route: SegmentRouteMatch,
  timers: LlMediaTimers = {},
): Promise<Response> {
  if (
    !SEGMENT_NAME.test(route.name) ||
    !route.name.startsWith(`${route.startedAt}`)
  ) {
    return json(404, { error: "Not found" });
  }
  const rung = rungFromName(route.startedAt, route.name);

  const failure = await describeHlsSegmentToken(
    new URL(request.url).searchParams.get(HLS_SEGMENT_TOKEN_PARAM),
    { channelId: route.channelId, startedAt: route.startedAt, name: route.name },
    env.HLS_SEGMENT_TOKEN_SECRET,
  );
  if (failure) {
    logRejection(route.channelId, rung, failure, "hlsEdge.segmentRejected");
    const status = failure === "wrong-rendition" ? 403 : statusForRejection(failure);
    return json(status, { error: "Unauthorized", reason: failure });
  }

  const origin = new R2SegmentOrigin(env.LIVE_SEGMENTS);
  if (!origin.ready) {
    // The API is pointing viewers here (`LIVE_HLS_SEGMENT_BASE_URL`) but this
    // deploy has no bucket bound. Loud, and not cached: the rollout order in
    // README.md "Segments at the edge" is Worker first, flag second.
    logEvent("hlsEdge.segmentOriginNotConfigured", { channelId: route.channelId, rung });
    return json(503, { error: "Segment storage not configured" });
  }

  const served = await serveImmutableMedia(request, origin, cache, ctx, {
    channelId: route.channelId,
    startedAt: route.startedAt,
    rung,
    name: route.name,
    kind: "segment",
  }, timers);
  return applyRange(request, served);
}

/**
 * WARM BEFORE REVEAL.
 *
 * Measured on staging (120 viewers in GRU, 2026-09-23): with segments at the
 * edge, the median segment request was 40 ms against 256 ms presigned, but
 * the slowest 5% were no better than before, because they were the viewers
 * who asked for a brand-new segment while the colo was still reading it from
 * R2: every one of them waited for the whole object to arrive and be written
 * to the cache before getting a first byte.
 *
 * The only way a viewer learns a segment exists is the rendition playlist,
 * and this Worker already fetches that from the API once per rung per colo
 * every two seconds. So the fetch that is about to REVEAL a new segment to
 * the colo reads it into the cache first, and only then hands the playlist
 * on. The segment appears in the playlist a few hundred milliseconds later
 * than it would have, against a player that sits three segments behind the
 * edge, and nobody in the colo ever waits on R2.
 *
 * Bounded (`SEGMENT_WARM_BUDGET_MS`): a slow read does not hold the playlist
 * past the budget, it carries on in the background (the shared fetch is kept
 * alive by `ctx.waitUntil`) and viewers who ask meanwhile join it, which is
 * exactly the behaviour without warming. Only segments on THIS host (the
 * cache is per hostname), only the newest `SEGMENT_WARM_NEWEST` lines, and
 * only once per isolate per segment.
 */
export const SEGMENT_WARM_BUDGET_MS = 1_500;
const SEGMENT_WARM_NEWEST = 2;
const WARMED_MAX = 512;
const warmed = new Set<string>();

function rememberWarmed(key: string): void {
  warmed.add(key);
  if (warmed.size > WARMED_MAX) {
    // Sets iterate in insertion order: drop the oldest.
    const oldest = warmed.values().next().value;
    if (oldest !== undefined) {
      warmed.delete(oldest);
    }
  }
}

/** For tests. */
export function resetSegmentWarmingForTests(): void {
  warmed.clear();
}

export async function warmNewSegments(
  playlistBody: string,
  requestUrl: string,
  env: SegmentEnv,
  cache: Cache,
  ctx: ExecutionContext,
  budgetMs: number = SEGMENT_WARM_BUDGET_MS,
): Promise<{ attempted: number; timedOut: boolean }> {
  if (!env.LIVE_SEGMENTS || !env.HLS_SEGMENT_TOKEN_SECRET) {
    return { attempted: 0, timedOut: false };
  }
  const host = new URL(requestUrl).host;
  const candidates: { url: URL; route: SegmentRouteMatch }[] = [];
  for (const raw of playlistBody.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("https://") && !line.startsWith("http://")) {
      continue;
    }
    let url: URL;
    try {
      url = new URL(line);
    } catch {
      continue;
    }
    if (url.host !== host) {
      continue;
    }
    const route = parseSegmentPath(url.pathname);
    if (route) {
      candidates.push({ url, route });
    }
  }
  const fresh = candidates
    .slice(-SEGMENT_WARM_NEWEST)
    .filter(({ url }) => !warmed.has(url.pathname));
  if (fresh.length === 0) {
    return { attempted: 0, timedOut: false };
  }
  const work = Promise.all(
    fresh.map(async ({ url, route }) => {
      const response = await handleSegmentRequest(new Request(url.toString()), env, cache, ctx, route);
      // Drained, not just dropped: the body is the cache read-back or the
      // shared buffer, and an unread stream holds the fetch open.
      const drained = await response.arrayBuffer().then(
        () => true,
        () => false,
      );
      // Only a fully read 200 counts as warm: a failed drain may mean the
      // cache write never landed, and the next playlist should try again.
      if (response.status === 200 && drained) {
        rememberWarmed(url.pathname);
      }
    }),
  ).then(
    () => undefined,
    () => undefined,
  );
  ctx.waitUntil(work);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    work.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), budgetMs);
    }),
  ]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  return { attempted: fresh.length, timedOut };
}
