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
 * contract.
 *
 * **THE REMUX IMPLEMENTS IT** since 2026-09-15:
 * `tools/pqp-remux/internal/llstate` renders the document from the live
 * ring and `internal/serve`'s `GET /state.json` serves it, mounted per
 * session at `GET /s/:id/state.json` behind the same `X-Pqp-Origin-Key`
 * gate as every other media route. It did not, for one live party: on
 * 2026-09-15 at 08:01 UTC the API selected LL mode, `pqp-remuxd` started
 * the session and served parts, segments and `init.mp4` with a 200 apiece,
 * and every viewer stalled anyway, because this Worker asks for
 * `state.json` FIRST and got a 404 — `hlsEdge.llStateFetchFailed` on every
 * probe and no playlist ever built. The producer half is pinned against
 * this parser by `test/ll-state-remux-golden.test.mjs`, which feeds it the
 * golden document the Go renderer actually emits.
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
 *           // `index` is the part's position within THIS segment; the URI is
 *           // whatever file the origin serves it from, and `pqp-remux` names
 *           // parts by their GLOBAL CMAF sequence number (`part-<seq>.m4s`,
 *           // `internal/serve`), never by segment-and-index. Both are legal
 *           // here — a URI only has to be a safe relative name this Worker
 *           // can fetch back — and the names below are the shape a real
 *           // deployment produces.
 *           { "index": 0, "durationSecs": 0.501, "independent": true,  "uri": "part-164.m4s" },
 *           { "index": 1, "durationSecs": 0.498, "independent": false, "uri": "part-165.m4s" }
 *         ]
 *       },
 *       {
 *         "msn": 44,
 *         "complete": false,          // the segment currently being assembled — NEVER gets an EXTINF line, only its parts
 *         "programDateTime": "2026-09-14T18:03:33.114Z",
 *         "parts": [
 *           { "index": 0, "durationSecs": 0.502, "independent": true, "uri": "part-176.m4s" }
 *         ]
 *       }
 *     ],
 *     "preloadHint": { "msn": 44, "part": 1, "uri": "part-177.m4s" }  // next unwritten part, or null
 *   },
 *   "audio": {                        // null/absent entirely until a stage source has spoken (mirrors `tools/pqp-remux/README.md`'s own audio-is-optional framing)
 *     "initUri": "audio-init.mp4",
 *     "segments": [ /* same shape, "audio-seg-<n>.m4s" / "audio-part-<seq>.m4s" — the names pqp-remux's own audio ring is served under * / ],
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
 * FIVE MORE RULES, added after a Farol review of the first draft found this
 * parser checked every FIELD in isolation but none of the RELATIONSHIPS
 * `ll-playlist.js`'s renderer and `ll-playlist-origin.ts`'s origin fetches
 * silently depend on — a `state.json` that passed every per-field check
 * above could still describe a snapshot that made no sense as a timeline,
 * and the renderer had no choice but to render it anyway:
 *
 *  - A track's segment MSNs are STRICTLY INCREASING AND CONTIGUOUS (each one
 *    exactly one more than the last) — a gap or a duplicate is not a
 *    playlist this format has any way to represent, so it is rejected
 *    outright rather than rendered with a silently wrong media sequence.
 *  - `mediaSequence` must equal the VIDEO track's OLDEST (first) segment MSN
 *    — the one piece of cross-field arithmetic the shape above documents in
 *    words ("MSN of the OLDEST segment in video.segments") and nothing
 *    previously checked.
 *  - Every COMPLETE segment's `durationSecs`, on either track, must not
 *    exceed the RENDERED `EXT-X-TARGETDURATION` (`Math.ceil(targetDurationSecs)`,
 *    matching `ll-playlist.js`) by more than `MAX_SEGMENT_OVERAGE_SECS` —
 *    that tag is a ceiling RFC 8216bis requires every `EXTINF` to respect,
 *    but a small allowance past it absorbs ordinary encoder-timing jitter
 *    a real player already tolerates rather than rejecting a legitimate
 *    snapshot outright.
 *  - The track's OWN live edge must have something to play: if the last
 *    (possibly incomplete) segment has zero parts, `preloadHint` must be
 *    present — a live segment with neither parts nor a hint at what is
 *    coming next renders a playlist with nothing new to fetch at all.
 *  - A present `preloadHint` must name the EXACT next unwritten part — part
 *    0 of a new segment one past the last, if the last segment is complete;
 *    otherwise the next index after the last segment's own parts. Anything
 *    else either re-announces a part that already exists (which
 *    `EXT-X-PRELOAD-HINT` must never do, per RFC 8216bis §4.4.3.9) or points
 *    somewhere a client could never reconcile with the segments already
 *    listed.
 *
 * `sessionId` is also checked against the UUID shape `ll-session.js`'s
 * `deriveLlSessionId` always produces (not merely "non-empty") — it is
 * rendered UNESCAPED into `#EXT-X-PQP-SESSION:` (`ll-playlist.js`) and used
 * as a path segment against the remux origin (`ll-playlist-origin.ts`), so a
 * value this parser let through unconstrained would let a compromised or
 * mistaken origin inject arbitrary playlist lines or, worse, redirect this
 * Worker's own outbound requests. The per-item URI fields (`initUri`, a
 * segment's `uri`, a part's `uri`, a preload hint's `uri`) get the same
 * treatment for the same reason — see `isSafeUriSegment` below.
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
 * Rejects any embedded or TRAILING carriage-return or newline. JS's `$`
 * anchor (without the `m` flag, which none of this file's patterns set)
 * already matches only the true end of the string — unlike some other
 * regex dialects, it has no "matches before a final newline" special case,
 * so `/^[A-Za-z0-9]+$/.test("seg.m4s\n")` is `false` on the V8 engine both
 * this Worker and its test suite run on. This check exists anyway, as a
 * second, explicit line of defense that does not lean on that anchor
 * semantics alone — see `isSafeUriSegment`/`isUuidLike`, both of which are
 * rendered UNESCAPED into playlist text where a stray `\r`/`\n` would
 * inject a line.
 * @param {string} value
 * @returns {boolean}
 */
function containsLineTerminator(value) {
  return value.indexOf("\n") !== -1 || value.indexOf("\r") !== -1;
}

/**
 * A safe origin-supplied "file name" — no `/`, no `..`, no query/fragment,
 * no whitespace or control characters, nothing a template literal could
 * turn into a playlist-line injection or a `new URL(path, base)` escape.
 * `new URL` resolves a leading `//host/...` or a full `scheme://...` string
 * against a DIFFERENT origin entirely rather than the intended base — this
 * pattern's charset makes that construction impossible, closing both the
 * playlist-injection and the origin-redirect readings of the same
 * underlying gap. Every legitimate name in `state.json`'s own contract
 * (`init.mp4`, `seg-41.m4s`, `part-164.m4s`, `audio-init.mp4`, ...) is well
 * inside it; 191 characters is generous headroom over anything the remux
 * actually writes.
 * @param {unknown} value
 * @returns {value is string}
 */
const URI_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;
function isSafeUriSegment(value) {
  return typeof value === "string" && URI_SEGMENT_PATTERN.test(value) && !containsLineTerminator(value);
}

/**
 * The exact shape `ll-session.js`'s `deriveLlSessionId` always produces.
 * `state.json`'s own `sessionId` is rendered UNESCAPED into
 * `#EXT-X-PQP-SESSION:` (`ll-playlist.js`) — this bounds it to characters
 * that can never break out of that line.
 * @param {unknown} value
 * @returns {value is string}
 */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuidLike(value) {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value) && !containsLineTerminator(value);
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
  if (!isSafeUriSegment(value.uri)) {
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
    if (!isSafeUriSegment(value.uri)) {
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
  if (!isNonNegInt(value.msn) || !isNonNegInt(value.part) || !isSafeUriSegment(value.uri)) {
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
  if (!isSafeUriSegment(value.initUri)) {
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
  // MSNs are strictly increasing and contiguous -- a gap or a duplicate is
  // not a timeline this format can represent (see the module doc comment,
  // "FIVE MORE RULES").
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i].msn !== segments[i - 1].msn + 1) {
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
  const last = segments[segments.length - 1];
  if (!last.complete && last.parts.length === 0 && !preloadHint) {
    // The live edge has nothing published and nothing scheduled -- see the
    // module doc comment, "The track's OWN live edge must have something to
    // play".
    return null;
  }
  if (preloadHint) {
    // Must name the EXACT next unwritten part: part 0 of the segment one
    // past the last if that last segment is already sealed, otherwise the
    // next index after the last segment's own parts. Anything else either
    // re-announces a part that already exists or points somewhere the
    // segments listed here cannot reconcile with.
    const expected = last.complete
      ? { msn: last.msn + 1, part: 0 }
      : { msn: last.msn, part: last.parts.length };
    if (preloadHint.msn !== expected.msn || preloadHint.part !== expected.part) {
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
 * anything malformed — a producer bug, a corrupt response, or a caller that
 * pointed this parser at the wrong thing entirely — rather than throwing, so callers can log the
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
  if (!isUuidLike(value.sessionId) || !isNonEmptyString(value.channelId)) {
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
  // `mediaSequence` must be the VIDEO track's OLDEST (first) segment MSN --
  // the shape's own documented invariant ("MSN of the OLDEST segment in
  // video.segments"), unchecked before this review. `video.segments` is
  // never empty (parseTrack already rejects that), so `[0]` is safe.
  if (value.mediaSequence !== video.segments[0].msn) {
    return null;
  }
  let audio = null;
  if (value.audio !== undefined && value.audio !== null) {
    audio = parseTrack(value.audio);
    if (!audio) {
      return null;
    }
  }
  // No COMPLETE segment, on either track, may claim a duration much longer
  // than the RENDERED EXT-X-TARGETDURATION -- a ceiling every EXTINF must
  // respect (RFC 8216bis), but not a millisecond-exact one. Two things,
  // both from Farol's second review:
  //
  //  1. `ll-playlist.js`'s `buildLlRenditionPlaylist` does not render
  //     `targetDurationSecs` as-is: it emits
  //     `Math.max(1, Math.ceil(state.targetDurationSecs))`, an INTEGER per
  //     the tag's own grammar. Comparing against the raw fractional
  //     `targetDurationSecs` was already stricter than what the renderer
  //     itself produces, so mirror that SAME formula here.
  //  2. Even against that ceiling, ordinary encoder-timing jitter can push
  //     a real, legal segment slightly past a whole-second target --
  //     `targetDurationSecs: 2` with a 2.04s segment renders
  //     `EXT-X-TARGETDURATION:2` / `EXTINF:2.04`, which every real LL-HLS
  //     player already tolerates as normal rounding noise, not a
  //     malformed response. `MAX_SEGMENT_OVERAGE_SECS` is that tolerance --
  //     generous enough for jitter, nowhere near generous enough to hide a
  //     segment that is actually many multiples of the target (the shape a
  //     genuinely malformed or hostile snapshot would take).
  //
  //  THE BOUND IS EXCLUSIVE AT THE TOP, NOT INCLUSIVE (Farol, third
  //  review). `renderedTargetDuration + MAX_SEGMENT_OVERAGE_SECS` sits
  //  EXACTLY at the next whole second (e.g. target 2 + 0.5 = 2.5, and a
  //  segment landing precisely at 2.5s would itself round-half-up to 3 --
  //  a target-duration player derives from that ceiling MUST already be
  //  3, not 2, for a segment that long, so accepting it at `>` (only
  //  rejecting strictly PAST 2.5) let a segment through whose OWN
  //  half-second boundary case round-tripped to a target one whole second
  //  higher than what this parser had just accepted. `>=` closes it: a
  //  segment must land strictly BELOW the next whole second past the
  //  ceiling to pass, so `duration < renderedTargetDuration +
  //  MAX_SEGMENT_OVERAGE_SECS` is the actual accept condition, and this
  //  check is its negation.
  const renderedTargetDuration = Math.max(1, Math.ceil(value.targetDurationSecs));
  const MAX_SEGMENT_OVERAGE_SECS = 0.5;
  for (const track of audio ? [video, audio] : [video]) {
    for (const segment of track.segments) {
      if (
        segment.complete &&
        /** @type {number} */ (segment.durationSecs) >= renderedTargetDuration + MAX_SEGMENT_OVERAGE_SECS
      ) {
        return null;
      }
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
