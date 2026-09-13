import { HLS_VIEWER_TOKEN_PARAM } from "./hls-viewer-token.js";

/**
 * Where a playlist's BYTES actually come from, once a request has already
 * cleared this Worker's own token check (`hls-viewer-token.js`) and path
 * parsing (`playlist-route.ts`). Everything in `index.ts` — the caching
 * decision, the CORS layer, the logging — is written against this
 * interface, never against "the API" directly, on purpose.
 *
 * THE SEAM THIS EXISTS FOR. The owner wants a watch party to keep playing
 * when the API is down. That means this Worker eventually needs a SECOND
 * implementation that lists a session's segments straight from R2 and
 * renders a media playlist itself — a Durable Object per session remembering
 * which segments it has seen, the same widened-window idea as
 * `hls-live-window.ts`'s in-process history on the API, just living at the
 * edge instead — with NO origin round trip at all once a session is warm.
 * That implementation is NOT built here: this PR ships only the ONE
 * implementation below (ask the API, same as always — this Worker still
 * takes the API down with it today), plus the R2 bucket binding and Durable
 * Object as commented placeholders in `wrangler.jsonc`. See
 * `docs/plans/ALWAYS_ON.md` task A1.x. Splitting this out now means that
 * work touches this file (and a new sibling implementing the same
 * interface), not the routing/caching/CORS logic in `index.ts` — and lets
 * `index.ts` eventually pick between the two per request (R2 first, API as
 * fallback) without caring which one actually answered.
 */
export interface PlaylistFetch {
  channelId: string;
  startedAt: string;
  rung?: string;
  /**
   * The token this Worker has ALREADY verified. Forwarded to the API today
   * because the API's own auth still runs on every request it sees (see
   * `index.ts`'s module doc comment, "What stays authoritative") — an R2
   * implementation would not need it at all, since there would be nothing
   * left to authorize against once this Worker is already the source of
   * truth for the bytes.
   */
  token: string;
}

export interface PlaylistOrigin {
  /**
   * Whether this origin can serve anything right now (e.g. `ORIGIN_BASE`
   * configured). Checked by the caller BEFORE `fetchPlaylist`, so "not
   * ready" gets its own log line and status code rather than looking like a
   * network failure that happened to also produce a 503.
   */
  readonly ready: boolean;
  /**
   * Resolves to the origin's response, whatever its HTTP status — a non-2xx
   * response is data, not a throw. Throws ONLY on a network-level failure
   * (timeout, DNS, connection reset); the caller decides how to log and
   * respond to those.
   */
  fetchPlaylist(req: PlaylistFetch): Promise<Response>;
}

/**
 * Today's only implementation: ask the API's own playlist proxy — the same
 * route this Worker exists to take load off of, just once per rung per
 * cache window instead of once per viewer. The collapsing itself happens in
 * `index.ts`, not here; this class only knows how to make ONE request.
 */
export class ApiPlaylistOrigin implements PlaylistOrigin {
  constructor(
    private readonly originBase: string | undefined,
    private readonly timeoutMs: number,
  ) {}

  get ready(): boolean {
    return Boolean(this.originBase);
  }

  async fetchPlaylist(req: PlaylistFetch): Promise<Response> {
    if (!this.originBase) {
      // The caller is expected to check `ready` first (index.ts does), so
      // reaching this is a bug in this module's caller, not a runtime
      // condition a viewer can trigger.
      throw new Error("ApiPlaylistOrigin.fetchPlaylist called before `ready`");
    }
    const url = playlistUrl(this.originBase, req);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      // `fetch()` resolving only means the RESPONSE HEADERS arrived — a
      // slow-drip or stalled body would otherwise be read with no timeout at
      // all once the timer below is cleared, since `finally` would already
      // have run. Buffering the body HERE, still inside the same
      // AbortController's window, means one timeout covers the whole
      // exchange (playlists are a few KB of text, so buffering costs
      // nothing); `Response.body` re-derives a fresh stream from the buffer
      // for whichever caller in index.ts passes it straight through.
      const body = await response.arrayBuffer();
      // `arrayBuffer()` transparently DECODES a standard `Content-Encoding`
      // (gzip/br/deflate) the same way `.text()`/`.json()` would; `body`
      // here is always the DECODED bytes. `response.headers`, though, still
      // carries whatever the origin put on the wire -- `Content-Encoding`
      // naming a codec the bytes are no longer in, and a `Content-Length`
      // that describes the COMPRESSED transfer size, not this buffer's. The
      // API itself sends neither today, but once `api.pqp.gg` sits behind
      // Cloudflare's own proxy (the Vultr move, `docs/deploy-vultr.md`),
      // automatic compression between this Worker and the origin is exactly
      // the kind of thing that starts being true without anyone touching
      // this file. Reusing those two headers unchanged would then hand a
      // player `Content-Encoding: br` on a body that is already plain text.
      // Dropping them and letting the runtime compute a correct
      // `Content-Length` from the actual buffer is cheap insurance now and
      // load-bearing later.
      const headers = new Headers(response.headers);
      headers.delete("Content-Encoding");
      headers.delete("Content-Length");
      return new Response(body, { status: response.status, headers });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The origin URL for one playlist request: same path shape as `playlist-route.ts`, token attached. */
function playlistUrl(originBase: string, req: PlaylistFetch): string {
  const path =
    `/api/voice/hls-playlist/${encodeURIComponent(req.channelId)}/${req.startedAt}` +
    (req.rung ? `/${encodeURIComponent(req.rung)}` : "");
  const url = new URL(path, originBase);
  url.searchParams.set(HLS_VIEWER_TOKEN_PARAM, req.token);
  return url.toString();
}
