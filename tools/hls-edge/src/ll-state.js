/**
 * `state.json` — the contract between `pqp-remux` (or, until `L1.6`/`L2.3`
 * wire it up for real, a stand-in origin serving the same shape) and this
 * Worker's LL playlist renderer (`ll-playlist.js`), task `L2.2`
 * (`docs/plans/LL_HLS.md` §7 "L2: the edge and the players").
 *
 * WHY THIS ENDPOINT EXISTS. `tools/pqp-remux/README.md`'s "Not yet" section
 * is explicit: `GET /playlist.m3u8` (the box's local test surface, `L1.1`
 * through `L1.4`) "is a conventional media playlist listing sealed
 * segments... no blocking-reload support; that is entirely the edge
 * Worker's job in `L2.1` and `L2.2`." This Worker renders the LL playlist
 * ITSELF (RFC 8216bis tags: `EXT-X-SERVER-CONTROL`, `EXT-X-PART-INF`,
 * `EXT-X-PART`, `EXT-X-PRELOAD-HINT`) rather than forwarding a body some
 * origin already wrote in that shape, because nothing upstream of it writes
 * that shape yet. It needs a source of truth for the numbers those tags
 * encode — which segments and parts exist, how long each is, which part
 * starts on an IDR — structured enough to read without parsing anyone's
 * playlist text. `state.json` is that source of truth, and this file is its
 * contract: THE REMUX MUST IMPLEMENT THIS (`L1.6`/`L2.3`) for the LL rung to
 * ever serve real media; until then, `ll-playlist-origin.ts` gets a 404 or a
 * connection failure from every real deployment, which is the same "wired
 * but dark" shape `docs/plans/LL_HLS.md` uses throughout (flags, allowlists,
 * `origin_base_url` unset).
 *
 * ## The shape
 *
 * `GET {originBase}/s/:sessionId/state.json`, `sessionId` = `ll-session.js`'s
 * `deriveLlSessionId(channelId, startedAtMs)` — a path this Worker computes
 * itself, never looked up, so the remux only ever needs to know its OWN
 * session id (it already does: the control plane starts it with one,
 * `hls-remux.ts`'s `buildStartRequest`) and serve state.json under it.
 *
 * ```jsonc
 * {
 *   "sessionId": "5a1b2c3d-...",     // matches the URL; belt and braces
 *   "channelId": "chan_abc123",
 *   "partTargetMs": 500,              // pqp-remux's PART_MS
 *   "segmentTargetMs": 4000,          // pqp-remux's SEGMENT_MS
 *   "targetDurationSecs": 6,          // ceil(max observed segment duration) — EXT-X-TARGETDURATION, section 3's elastic branch
 *   "mediaSequence": 41,              // MSN of the OLDEST segment in "video.segments" (both tracks share one MSN space per rendition)
 *   "video": {
 *     "initUri": "init.mp4",          // fetched from the SAME origin, path `/s/:sessionId/init.mp4`
 *     "segments": [
 *       {
 *         "msn": 41,
 *         "complete": true,           // sealed — gets a full #EXTINF + URI line
 *         "durationSecs": 4.016,      // required when complete; null/absent otherwise
 *         "programDateTime": "2026-09-14T18:03:21.114Z",
 *         "uri": "seg-41.m4s",        // required when complete; omit/null otherwise
 *         "parts": [
 *           { "index": 0, "durationSecs": 0.501, "independent": true,  "uri": "part-41.0.m4s" },
 *           { "index": 1, "durationSecs": 0.498, "independent": false, "uri": "part-41.1.m4s" }
 *         ]
 *       },
 *       {
 *         "msn": 44,
 *         "complete": false,          // the segment currently being assembled — NEVER gets an EXTINF line, only its parts
 *         "programDateTime": "2026-09-14T18:03:33.114Z",
 *         "parts": [
 *           { "index": 0, "durationSecs": 0.502, "independent": true, "uri": "part-44.0.m4s" }
 *         ]
 *       }
 *     ],
 *     "preloadHint": { "msn": 44, "part": 1, "uri": "part-44.1.m4s" }  // next unwritten part, or null
 *   },
 *   "audio": {                        // null/absent entirely until a stage source has spoken (mirrors `tools/pqp-remux/README.md`'s own audio-is-optional framing)
 *     "initUri": "audio-init.mp4",
 *     "segments": [ /* same shape, "audio-seg-<n>.m4s" / "audio-part-<seq>.m4s" — see pqp-remux's R2 writer for the naming precedent * / ],
 *     "preloadHint": { ... } | null
 *   }
 * }
 * ```
 *
 * RULES a producer of this document must follow, all enforced by
 * `parseLlState` below:
 *
 *  - `segments` is never empty, and AT MOST THE LAST entry may have
 *    `complete: false` — every LL playlist needs at least one thing to
 *    list, and an incomplete segment anywhere but the live edge would mean
 *    the origin skipped sealing one.
 *  - `independent` on a part is the origin's own claim, not something this
 *    Worker infers — it already knows which part's first frame is an IDR
 *    (video) or simply "every part" (audio; RFC 8216bis: independence is
 *    RECOMMENDED on audio parts since there's usually no inter-part
 *    reference to break).
 *  - `programDateTime` is an ISO 8601 string, required on every segment
 *    (complete or not) so `#EXT-X-PROGRAM-DATE-TIME` can be emitted before
 *    ANY segment's lines, matching genuinely time-anchored HLS behaviour
 *    rather than only the sealed ones.
 *  - `preloadHint`, when present, names a part that does not exist YET —
 *    it is what `#EXT-X-PRELOAD-HINT` tells a player to start fetching
 *    before the origin has finished writing it (RFC 8216bis §4.4.3.9).
 *
 * `ll-playlist.js` renders text FROM the parsed shape below; nothing in
 * that file re-reads `raw` JSON, and nothing here renders a single playlist
 * tag — same "read/render" split `hls-blocking-reload.js`'s own module doc
 * comment describes for its own pure pieces.
 */

/** The rung name a viewer's client sees for the LL video rendition. Also what the master's `EXT-X-STREAM-INF` variant points at. */
export const LL_VIDEO_RUNG = "ll";
/** The rung name for the separate LL audio rendition (`EXT-X-MEDIA:TYPE=AUDIO`'s `URI`). */
export const LL_AUDIO_RUNG = "ll-audio";

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isNonNegInt(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * @typedef {{ index: number, durationSecs: number, independent: boolean, uri: string }} LlPart
 */

/**
 * @param {unknown} raw
 * @returns {LlPart | null}
 */
function parsePart(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = /** @type {Record<string, unknown>} */ (raw);
  if (!isNonNegInt(value.index)) {
    return null;
  }
  if (!isFiniteNumber(value.durationSecs) || value.durationSecs <= 0) {
    return null;
  }
  if (typeof value.independent !== "boolean") {
    return null;
  }
  if (!isNonEmptyString(value.uri)) {
    return null;
  }
  return {
    index: value.index,
    durationSecs: value.durationSecs,
    independent: value.independent,
    uri: value.uri,
  };
}

/**
 * @typedef {{
 *   msn: number,
 *   complete: boolean,
 *   durationSecs: number | null,
 *   uri: string | null,
 *   programDateTime: string,
 *   parts: LlPart[],
 * }} LlSegment
 */

/**
 * @param {unknown} raw
 * @returns {LlSegment | null}
 */
function parseSegment(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = /** @type {Record<string, unknown>} */ (raw);
  if (!isNonNegInt(value.msn)) {
    return null;
  }
  if (typeof value.complete !== "boolean") {
    return null;
  }
  if (value.complete) {
    if (!isFiniteNumber(value.durationSecs) || value.durationSecs <= 0) {
      return null;
    }
    if (!isNonEmptyString(value.uri)) {
      return null;
    }
  } else if (value.uri !== undefined && value.uri !== null) {
    // An in-progress segment has no sealed object to point at yet.
    return null;
  }
  if (!isNonEmptyString(value.programDateTime)) {
    return null;
  }
  if (!Number.isFinite(Date.parse(value.programDateTime))) {
    return null;
  }
  if (!Array.isArray(value.parts)) {
    return null;
  }
  /** @type {LlPart[]} */
  const parts = [];
  for (const rawPart of value.parts) {
    const parsed = parsePart(rawPart);
    if (!parsed) {
      return null;
    }
    parts.push(parsed);
  }
  return {
    msn: value.msn,
    complete: value.complete,
    durationSecs: value.complete
      ? /** @type {number} */ (value.durationSecs)
      : isFiniteNumber(value.durationSecs)
        ? value.durationSecs
        : null,
    uri: value.complete ? /** @type {string} */ (value.uri) : null,
    programDateTime: value.programDateTime,
    parts,
  };
}

/**
 * @typedef {{ msn: number, part: number, uri: string }} LlPreloadHint
 */

/**
 * @param {unknown} raw
 * @returns {LlPreloadHint | null}
 */
function parsePreloadHint(raw) {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw !== "object") {
    return null;
  }
  const value = /** @type {Record<string, unknown>} */ (raw);
  if (!isNonNegInt(value.msn) || !isNonNegInt(value.part) || !isNonEmptyString(value.uri)) {
    return null;
  }
  return { msn: value.msn, part: value.part, uri: value.uri };
}

/**
 * @typedef {{ initUri: string, segments: LlSegment[], preloadHint: LlPreloadHint | null }} LlTrackState
 */

/**
 * @param {unknown} raw
 * @returns {LlTrackState | null}
 */
function parseTrack(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = /** @type {Record<string, unknown>} */ (raw);
  if (!isNonEmptyString(value.initUri)) {
    return null;
  }
  if (!Array.isArray(value.segments) || value.segments.length === 0) {
    return null;
  }
  /** @type {LlSegment[]} */
  const segments = [];
  for (const rawSegment of value.segments) {
    const parsed = parseSegment(rawSegment);
    if (!parsed) {
      return null;
    }
    segments.push(parsed);
  }
  // At most the LAST segment may be the one still being assembled.
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (!segments[i].complete) {
      return null;
    }
  }
  let preloadHint = null;
  if (value.preloadHint !== undefined && value.preloadHint !== null) {
    preloadHint = parsePreloadHint(value.preloadHint);
    if (!preloadHint) {
      // Present but malformed -- distinct from "absent", which is
      // legitimately null (the origin has nothing new to hint at yet).
      return null;
    }
  }
  return { initUri: value.initUri, segments, preloadHint };
}

/**
 * @typedef {{
 *   sessionId: string,
 *   channelId: string,
 *   partTargetMs: number,
 *   segmentTargetMs: number,
 *   targetDurationSecs: number,
 *   mediaSequence: number,
 *   video: LlTrackState,
 *   audio: LlTrackState | null,
 * }} LlSessionState
 */

/**
 * Validates and reshapes one `state.json` response. Returns `null` on
 * anything malformed — a producer bug, a corrupt response, or (today, since
 * nothing implements this endpoint yet) a caller that pointed this parser
 * at the wrong thing entirely — rather than throwing, so callers can log the
 * "which field" detail themselves if they want it and otherwise just treat
 * `null` the same as "origin has nothing for this session."
 *
 * @param {unknown} raw
 * @returns {LlSessionState | null}
 */
export function parseLlState(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = /** @type {Record<string, unknown>} */ (raw);
  if (!isNonEmptyString(value.sessionId) || !isNonEmptyString(value.channelId)) {
    return null;
  }
  if (!Number.isInteger(value.partTargetMs) || value.partTargetMs <= 0) {
    return null;
  }
  if (!Number.isInteger(value.segmentTargetMs) || value.segmentTargetMs <= 0) {
    return null;
  }
  if (!isFiniteNumber(value.targetDurationSecs) || value.targetDurationSecs <= 0) {
    return null;
  }
  if (!isNonNegInt(value.mediaSequence)) {
    return null;
  }
  const video = parseTrack(value.video);
  if (!video) {
    return null;
  }
  let audio = null;
  if (value.audio !== undefined && value.audio !== null) {
    audio = parseTrack(value.audio);
    if (!audio) {
      return null;
    }
  }
  return {
    sessionId: value.sessionId,
    channelId: value.channelId,
    partTargetMs: value.partTargetMs,
    segmentTargetMs: value.segmentTargetMs,
    targetDurationSecs: value.targetDurationSecs,
    mediaSequence: value.mediaSequence,
    video,
    audio,
  };
}

/**
 * @param {LlSessionState} state
 * @param {string} rung
 * @returns {LlTrackState | null}
 */
export function trackForRung(state, rung) {
  if (rung === LL_VIDEO_RUNG) {
    return state.video;
  }
  if (rung === LL_AUDIO_RUNG) {
    return state.audio;
  }
  return null;
}

/**
 * Which family of origin a RENDITION request's `rung` belongs to — pure, so
 * `index.ts`'s "which origin answers this rung" decision (LL origin for
 * `ll`/`ll-audio` when it's configured, the API for every other rung,
 * unchanged) is unit-testable with no Workers runtime at all. A rung this
 * Worker has never heard of (a conventional rendition name, or garbage) is
 * `"api"` — the SAME origin and the SAME code path it has always been,
 * which is what makes "conventional sessions are untouched byte-for-byte"
 * (`docs/plans/LL_HLS.md` task `L2.2`) a property of this one function
 * rather than something only an end-to-end test could show.
 *
 * @param {string} rung
 * @returns {"ll" | "api"}
 */
export function playlistOriginKindForRung(rung) {
  return rung === LL_VIDEO_RUNG || rung === LL_AUDIO_RUNG ? "ll" : "api";
}
