/**
 * Renders LL-HLS playlist TEXT from an already-validated `LlSessionState`
 * (`ll-state.js`'s `parseLlState`) — task `L2.2`
 * (`docs/plans/LL_HLS.md` §7 "L2: the edge and the players").
 *
 * Pure functions of (state, options) → string, no I/O, no Workers-only API —
 * same shape as `hls-blocking-reload.js`'s "read/render split" and plain JS
 * for the same reason that file gives: `node --test` runs it unmodified, no
 * build step, no Miniflare (see that file's header).
 *
 * WHY THIS FILE CAN STAY PURE TEXT AND `hls-blocking-reload.js` NEEDS NO
 * CHANGES FOR L2.2. That module's `parseLiveEdge` already reads a live edge
 * generically off ANY playlist text: it counts `#EXTINF:` lines for
 * complete segments and any `#EXT-X-PART:` lines trailing after the last one
 * for the segment being assembled, and reads `PART-TARGET=` off whatever
 * `#EXT-X-PART-INF:` line is present. This file's OWN job is only to make
 * that text real — once `index.ts` points an LL rendition's fetch at
 * `ll-playlist-origin.ts` instead of the API, `hls-blocking-reload.js`'s
 * poll loop, timeout and coalescing work on it exactly as they already do
 * for a conventional playlist, with no code path split between the two.
 *
 * TWO PLAYLISTS:
 *
 *  - `buildLlRenditionPlaylist` — one rung's MEDIA playlist (video `ll` or
 *    audio `ll-audio`), the one that gets polled / blocking-reloaded.
 *  - `buildLlMultivariantPlaylist` — the session's MASTER playlist for an
 *    LL session: the video variant plus the audio rendition as an
 *    `EXT-X-MEDIA:TYPE=AUDIO` group, `CODECS` supplied by the caller
 *    (`ll-init-codecs.js` reads them off the init segments — this file
 *    never touches MP4 bytes).
 *
 * WHAT THE URIS POINT AT. Every URI this file emits is relative to
 * `opts.basePath` (this Worker's own viewer-facing route root,
 * `/api/voice/hls-playlist/:channelId/:startedAt` — see `playlist-route.ts`)
 * plus `/{rung}/{name}`. These are DELIBERATELY NEVER the remux origin's own
 * host — `hls-remux.ts`'s doc comment on `llPlaylistUrl` explains why a raw
 * origin URL must never reach a client: it is a bearer link nothing can
 * revoke short of ending the session. `/{rung}/{name}` is answered by THIS
 * Worker, in `ll-media.ts` (`docs/plans/LL_HLS.md` task `L2.3`, shipped):
 * the token on the URI is checked the same way it is on this playlist, and
 * the bytes are fetched from `{LL_ORIGIN_BASE}/s/{sessionId}/{name}` and
 * cached per colo, immutably. Until that route existed every URI this file
 * emitted 404'd, which is why `L2.2` shipped a playlist that was correct
 * and unplayable.
 *
 * THE TOKEN, AND WHY `buildLlRenditionPlaylist` NEVER TAKES ONE. PR #572's
 * party-lifetime pass established that the viewer's own `?t=` token stays on
 * every URI this Worker hands out — true for the master (`buildMasterPlaylistFor`
 * on the API, and `buildLlMultivariantPlaylist` below, neither of which is
 * ever cached) but NOT safely true for a RENDITION playlist that goes
 * through `index.ts`'s shared 2s cache and blocking-reload poll-loop
 * coalescer, which key on (channel, session, rung) alone — no token — on the
 * premise that the body is identical for every viewer of that rung in that
 * window. A first draft of this file embedded the REQUESTING viewer's real
 * token directly, which broke that premise: a Farol review of this PR
 * caught that the cached/coalesced entry then handed one viewer's bearer
 * token to every other viewer who hit the same warm entry, readable and
 * reusable by them even after the original viewer's own token expired or
 * was revoked. **Fixed**: `buildLlRenditionPlaylist` renders every URI with
 * the fixed, non-secret `LL_TOKEN_PLACEHOLDER` string instead of a real
 * token, so its OUTPUT is a pure function of `(state, rung, basePath)` again
 * — safe to cache and coalesce exactly like a conventional rendition body.
 * `applyLlRenditionToken` is the one substitution step that turns that
 * shared text into a specific viewer's playable response, and it must run
 * AFTER the cache/coalescer, once per outgoing response, never before
 * (`index.ts`'s `stampLlToken`, called only on the response actually being
 * returned to a request, never on what gets written into the cache).
 */

import { HLS_VIEWER_TOKEN_PARAM } from "./hls-viewer-token.js";
import { LL_AUDIO_RUNG, LL_VIDEO_RUNG } from "./ll-state.js";

/** RFC 8216bis's `EXT-X-PART`/`EXT-X-PRELOAD-HINT` need at least this. */
export const LL_PLAYLIST_VERSION = 9;

/** `PART-HOLD-BACK` is a multiple of the part target — `docs/plans/LL_HLS.md` §2's table, `hls-live-edge.ts`'s conventional counterpart. */
export const PART_HOLD_BACK_MULTIPLIER = 3;

/** How many of the newest COMPLETE segments keep their `#EXT-X-PART` lines — README.md "Blocking reload (L2.1)", "per spec guidance". */
export const KEPT_PART_SEGMENTS = 3;

/**
 * `EXT-X-STREAM-INF` requires `BANDWIDTH`. Nothing in `state.json` measures
 * one yet (`docs/plans/LL_HLS.md` §8 "What it costs" estimates the SFU-side
 * number; `L3.2`'s staging benchmark is where a real figure would come
 * from) — a fixed, honest-about-being-approximate ceiling for a
 * single-layer 1080p-or-under screen share is a safer default than a wrong
 * precise-looking one. Revisit once `L3.x` has a measurement.
 */
export const DEFAULT_LL_VIDEO_BANDWIDTH_BPS = 4_000_000;

/**
 * Stands in for a real `?t=` token in every URI `buildLlRenditionPlaylist`
 * emits — see this file's header, "THE TOKEN, AND WHY...". Not a secret and
 * not itself usable as a token: it exists purely so the rendered text is
 * identical for every viewer, and is replaced with a real one by
 * `applyLlRenditionToken` after the cache/coalescer, per response. Chosen to
 * contain no URI-reserved characters, so it round-trips through a `URL`
 * unmodified and is trivial to find-and-replace with a plain string split.
 */
export const LL_TOKEN_PLACEHOLDER = "__PQP_LL_TOKEN_PLACEHOLDER__";

/**
 * @param {string} uri
 * @param {string} token
 * @returns {string}
 */
function withToken(uri, token) {
  const separator = uri.includes("?") ? "&" : "?";
  return `${uri}${separator}${HLS_VIEWER_TOKEN_PARAM}=${encodeURIComponent(token)}`;
}

/**
 * The one substitution that turns a cached/coalesced, placeholder-bearing LL
 * rendition body into a specific viewer's playable response — a plain
 * string `split`/`join` rather than a `RegExp`, since `LL_TOKEN_PLACEHOLDER`
 * is a fixed literal with no regex metacharacters to worry about escaping.
 * Pure and total: text with no placeholder in it (any conventional
 * playlist, or an LL error body like "Not found") comes back byte-for-byte
 * unchanged, so callers do not need to special-case "was this actually an
 * LL body" before calling it.
 *
 * @param {string} playlistText
 * @param {string} token
 * @returns {string}
 */
export function applyLlRenditionToken(playlistText, token) {
  return playlistText.split(LL_TOKEN_PLACEHOLDER).join(encodeURIComponent(token));
}

/**
 * @param {string} basePath
 * @param {string} rung
 * @param {string} name
 * @param {string} token
 * @returns {string}
 */
function renditionUri(basePath, rung, name, token) {
  return withToken(`${basePath}/${rung}/${name}`, token);
}

/**
 * Trims to millisecond precision and drops a trailing `.000` down to a bare
 * integer where possible — RFC 8216bis's DECIMAL-FLOATING-POINT accepts
 * either, and a shorter number is one less thing for a hand-parsing test to
 * disagree with this Worker about.
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  return Number(seconds.toFixed(3)).toString();
}

/**
 * @param {import("./ll-state.js").LlPart} part
 * @param {string} basePath
 * @param {string} rung
 * @param {string} token
 * @returns {string}
 */
function formatPartLine(part, basePath, rung, token) {
  const uri = renditionUri(basePath, rung, part.uri, token);
  const independent = part.independent ? ",INDEPENDENT=YES" : "";
  return `#EXT-X-PART:DURATION=${formatDuration(part.durationSecs)},URI="${uri}"${independent}`;
}

/**
 * One rung's LL media playlist — the body a viewer's player polls or
 * blocking-reloads. Takes NO token (see this file's header, "THE TOKEN,
 * AND WHY..."): every URI carries `LL_TOKEN_PLACEHOLDER` instead, so this
 * function's output is a pure function of `(state, rung, basePath)` and
 * safe to cache/coalesce across viewers exactly like a conventional
 * rendition. `applyLlRenditionToken` turns it into one viewer's response.
 *
 * @param {import("./ll-state.js").LlSessionState} state
 * @param {import("./ll-state.js").LlTrackState} track
 * @param {string} rung
 * @param {{ basePath: string }} opts
 * @returns {string}
 */
export function buildLlRenditionPlaylist(state, track, rung, opts) {
  const { basePath } = opts;
  const token = LL_TOKEN_PLACEHOLDER;
  const partTargetSecs = state.partTargetMs / 1000;
  const partHoldBackSecs = partTargetSecs * PART_HOLD_BACK_MULTIPLIER;
  const targetDuration = Math.max(1, Math.ceil(state.targetDurationSecs));
  const firstMsn = track.segments[0].msn;
  const completeCount = track.segments.reduce((count, s) => count + (s.complete ? 1 : 0), 0);

  const lines = [
    "#EXTM3U",
    `#EXT-X-VERSION:${LL_PLAYLIST_VERSION}`,
    `#EXT-X-PQP-SESSION:${state.sessionId}`,
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    `#EXT-X-PART-INF:PART-TARGET=${formatDuration(partTargetSecs)}`,
    `#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=${formatDuration(partHoldBackSecs)}`,
    `#EXT-X-MEDIA-SEQUENCE:${firstMsn}`,
    `#EXT-X-MAP:URI="${renditionUri(basePath, rung, track.initUri, token)}"`,
  ];

  let completeSeen = 0;
  for (const segment of track.segments) {
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${segment.programDateTime}`);
    if (segment.complete) {
      completeSeen += 1;
      const rankFromNewest = completeCount - completeSeen;
      if (rankFromNewest < KEPT_PART_SEGMENTS) {
        for (const part of segment.parts) {
          lines.push(formatPartLine(part, basePath, rung, token));
        }
      }
      lines.push(`#EXTINF:${formatDuration(/** @type {number} */ (segment.durationSecs))},`);
      lines.push(renditionUri(basePath, rung, /** @type {string} */ (segment.uri), token));
    } else {
      // The segment currently being assembled: parts only, never an
      // `#EXTINF` — `parseLiveEdge` (`hls-blocking-reload.js`) relies on
      // exactly this to tell "the last complete segment" from "how far the
      // next one has gotten".
      for (const part of segment.parts) {
        lines.push(formatPartLine(part, basePath, rung, token));
      }
    }
  }

  if (track.preloadHint) {
    const uri = renditionUri(basePath, rung, track.preloadHint.uri, token);
    lines.push(`#EXT-X-PRELOAD-HINT:TYPE=PART,URI="${uri}"`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * The multivariant (master) playlist for an LL session: the video rendition
 * plus, when the state has one, the audio rendition as a separate
 * `EXT-X-MEDIA` group referenced from the video's `EXT-X-STREAM-INF`.
 *
 * @param {import("./ll-state.js").LlSessionState} state
 * @param {{
 *   basePath: string,
 *   token: string,
 *   videoCodec: string,
 *   videoWidth?: number,
 *   videoHeight?: number,
 *   audioCodec: string | null,
 *   videoBandwidthBps?: number,
 * }} opts
 * @returns {string}
 */
export function buildLlMultivariantPlaylist(state, opts) {
  const {
    basePath,
    token,
    videoCodec,
    videoWidth,
    videoHeight,
    audioCodec,
    videoBandwidthBps = DEFAULT_LL_VIDEO_BANDWIDTH_BPS,
  } = opts;
  const hasAudio = Boolean(state.audio) && Boolean(audioCodec);
  const audioGroupId = "ll-audio";

  const lines = ["#EXTM3U", `#EXT-X-VERSION:${LL_PLAYLIST_VERSION}`, `#EXT-X-PQP-SESSION:${state.sessionId}`];

  if (hasAudio) {
    const audioUri = withToken(`${basePath}/${LL_AUDIO_RUNG}`, token);
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${audioGroupId}",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,URI="${audioUri}"`,
    );
  }

  const codecs = hasAudio ? `${videoCodec},${audioCodec}` : videoCodec;
  const streamInfAttrs = [`BANDWIDTH=${Math.round(videoBandwidthBps)}`];
  if (videoWidth && videoHeight) {
    streamInfAttrs.push(`RESOLUTION=${videoWidth}x${videoHeight}`);
  }
  streamInfAttrs.push(`CODECS="${codecs}"`);
  if (hasAudio) {
    streamInfAttrs.push(`AUDIO="${audioGroupId}"`);
  }

  lines.push(`#EXT-X-STREAM-INF:${streamInfAttrs.join(",")}`);
  lines.push(withToken(`${basePath}/${LL_VIDEO_RUNG}`, token));

  return `${lines.join("\n")}\n`;
}
