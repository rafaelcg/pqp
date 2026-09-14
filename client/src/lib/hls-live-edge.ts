/**
 * Pure helpers for the watch player's "how far behind live" state, Media
 * Session metadata, Picture-in-Picture availability, and the live-window
 * numbers hls.js is started with. Kept apart from `hls-watch-player.tsx`
 * so they can be unit tested without a DOM.
 */

/**
 * The live window the playlist proxy serves: fifteen 4 s segments = 60 s
 * (`server/src/voice/hls-live-window.ts`). The egress itself writes only
 * five, and an API that predates the widening still serves those 20 s.
 *
 * SEGMENTS WENT FROM 2 S TO 4 S ON 2026-09-12
 * (`LIVE_HLS_SEGMENT_SECONDS`, `server/src/voice/hls-egress.ts`), because at
 * 2 s the egress's two synchronous playlist uploads per segment fell behind
 * real time on a cross-region bucket; the bucket moved closer at the same
 * time. The numbers below were re-tuned for the 4 s premise on a
 * not-interactive watch party: sit comfortably behind live (~20 s, five
 * segments) with a deep forward buffer, because resilience against a slow
 * poll or a throttled tab matters far more here than shaving latency does.
 * That is more slack than the old 2 s tuning carried (6 s back, 16 s of
 * tolerance on a 30 s window) and is the point, not a regression: a
 * YouTube-style cushion, not a race to the edge.
 */
export const HLS_LIVE_SEGMENT_SECONDS = 4;
export const HLS_LIVE_WINDOW_SECONDS = 60;
/** ~20 s behind live: five segments, comfortably inside the 60 s window. */
export const HLS_LIVE_SYNC_DURATION_COUNT = 5;
/**
 * The window the egress itself writes: five segments, 20 s at 4 s. An API
 * that predates the proxy's 60 s widening still serves exactly this, and a
 * 5-segment sync point lands on its OLDEST entry with no slack. See
 * `effectiveLiveSyncDurationCount`.
 */
export const HLS_EGRESS_WINDOW_SEGMENTS = 5;
/** ~20 s: how far behind the presenter the PLAYER sits, by its own design. */
export const HLS_PLAYER_CUSHION_SECONDS =
  HLS_LIVE_SYNC_DURATION_COUNT * HLS_LIVE_SEGMENT_SECONDS;

/**
 * The live-sync count to actually run, given how many segments the loaded
 * playlist lists right now.
 *
 * WHY THIS EXISTS. `HLS_LIVE_SYNC_DURATION_COUNT` is chosen for the proxy's
 * 60 s (15-segment) window. Against an API that still serves the egress's
 * raw five-segment window, a 5-count sync point is the OLDEST listed segment
 * with zero slack, so a single slow playlist poll or a throttled tab ages it
 * out of the back of the window and hls.js re-syncs or stalls. Cap the count
 * so at least one listed segment always sits behind the sync point. On the
 * production window this returns the configured count unchanged; it only
 * bites a rolled-back or old API, but the guard is cheap. Applied live on
 * every `LEVEL_UPDATED`, because only then is the real playlist depth known.
 */
export function effectiveLiveSyncDurationCount(
  segmentsListed: number,
  configured: number = HLS_LIVE_SYNC_DURATION_COUNT,
): number {
  if (!Number.isFinite(segmentsListed) || segmentsListed < 2) {
    // One segment (a just-started egress) cannot offer slack either way;
    // keep the configured value and let hls.js clamp to what exists.
    return configured;
  }
  return Math.min(configured, Math.floor(segmentsListed) - 1);
}

/**
 * What the "behind live" badge should claim: the pipeline delay the server
 * reports PLUS the player's own ~20 s cushion, which sits on top of it.
 *
 * The wire `delaySeconds` (`LIVE_HLS_DELAY_SECONDS`) is a PIPELINE figure
 * only (see `hls-watch-player.tsx`); the player then positions itself
 * `HLS_PLAYER_CUSHION_SECONDS` behind the live edge on purpose, so a badge
 * that showed the pipeline value alone under-reported how far behind the
 * viewer actually sits. Absent a wire value, the pipeline portion is unknown
 * and the cushion alone is the honest floor.
 */
export function endToEndDelaySeconds(
  pipelineDelaySeconds?: number | null,
  cushionSeconds: number = HLS_PLAYER_CUSHION_SECONDS,
): number {
  const pipeline =
    typeof pipelineDelaySeconds === "number" && pipelineDelaySeconds > 0
      ? pipelineDelaySeconds
      : 0;
  return pipeline + cushionSeconds;
}
/**
 * Skip forward only once the playhead is 48 s behind (twelve segments),
 * still inside the 60 s window. Must be greater than the sync count and
 * fit the window; against an older API's 20 s window hls.js simply
 * re-syncs when the playlist no longer lists the playhead, which is what
 * it did before and no worse.
 */
export const HLS_LIVE_MAX_LATENCY_DURATION_COUNT = 12;
/** Buffer up to 24 s ahead; never more than 40, well inside the window. */
export const HLS_MAX_BUFFER_LENGTH_SECONDS = 24;
export const HLS_MAX_MAX_BUFFER_LENGTH_SECONDS = 40;
/**
 * hls.js defaults `backBufferLength` to `Infinity`, which keeps every
 * appended segment in the SourceBuffer for the whole party. Twelve seconds
 * behind the playhead is all a seek back to live ever needs.
 */
export const HLS_BACK_BUFFER_LENGTH_SECONDS = 12;

export interface HlsLivePlayerConfig {
  liveSyncDurationCount: number;
  liveMaxLatencyDurationCount: number;
  maxBufferLength: number;
  maxMaxBufferLength: number;
  backBufferLength: number;
  /** Auto: ABR picks from the seed, which is the 720p60@3200 rung. */
  startLevel: number;
}

export function hlsLivePlayerConfig(): HlsLivePlayerConfig {
  return {
    liveSyncDurationCount: HLS_LIVE_SYNC_DURATION_COUNT,
    liveMaxLatencyDurationCount: HLS_LIVE_MAX_LATENCY_DURATION_COUNT,
    maxBufferLength: HLS_MAX_BUFFER_LENGTH_SECONDS,
    maxMaxBufferLength: HLS_MAX_MAX_BUFFER_LENGTH_SECONDS,
    backBufferLength: HLS_BACK_BUFFER_LENGTH_SECONDS,
    startLevel: -1,
  };
}

/** hls.js ABR seed: above the 720 peak so Auto does not start on 480p. */
export const HLS_ABR_DEFAULT_ESTIMATE_BPS = 3_500_000;

// ---------------------------------------------------------------------------
// LL-HLS (`docs/plans/LL_HLS.md`, task L2.4). Kept apart from the conventional
// constants above on purpose: nothing in this section is read unless a live
// state actually says `mode: "ll"`, so the conventional path (every existing
// number above) stays byte-for-byte what it was.
// ---------------------------------------------------------------------------

/** `mode` on a live `LiveHlsStream` -- see `LlHlsStreamFields` below. */
export type HlsMode = "conventional" | "ll";

/**
 * `LiveHlsStream.mode` (PR 580, `feat/llhls-l1-5-control-plane`, not yet
 * merged to `main`) and `LiveHlsStream.partTargetMs`, which does not exist
 * on that branch's wire type EITHER as of this PR -- `hls-remux.ts` there
 * stores `part_target_ms` on the `hls_sessions` row and never puts it on the
 * `LiveHlsStream` it hands back. `packages/shared/src/live-hls.ts` on `main`
 * carries neither field today.
 *
 * This client does not validate incoming `channel-live`/`voice-stream`
 * frames or `GET /api/channels/:id/live` answers against the shared zod
 * schema at all (`client/src/lib/realtime.ts`'s `JSON.parse(...) as
 * ChatServerMessage | VoiceSignalingMessage` is a type assertion, not a
 * parse) -- so a server that DOES send `mode`/`partTargetMs` on the wire
 * already reaches this object at runtime; only the TypeScript type is
 * missing them. This interface is the narrow, local fix for that: every read
 * site casts through it rather than widening `LiveHlsStream` itself, which
 * this task is not allowed to touch (client-only; see `CLAUDE.md`).
 *
 * TODO(PR 580): once `mode` (and a `partTargetMs`, once something wires it
 * onto the wire type) land on `packages/shared/src/live-hls.ts`, delete this
 * interface and read the fields straight off `LiveHlsStream`.
 */
export interface LlHlsStreamFields {
  mode?: HlsMode;
  /** Absent until `partTargetMs` exists on the wire type; see above. */
  partTargetMs?: number;
}

/** `mode`, defaulting to what every stream before this field existed was. */
export function hlsModeOf(
  stream: LlHlsStreamFields | null | undefined,
): HlsMode {
  return stream?.mode ?? "conventional";
}

/**
 * `HlsWatchPlayer.mode` is a THIRD vocabulary from this one: `"live"` /
 * `"vod"` / `"ll"` (`hls-watch-player.tsx`, PR 573's VOD replay mode
 * alongside this task's `"ll"`), where `HlsMode` here only ever covers a
 * stream that IS live (`"conventional"` vs `"ll"` engine tuning) -- a
 * replay is a separate, component-level concept this file has no notion of.
 * Every caller that threads a live stream's wire `mode` down to the player
 * (`watch-stage.tsx`, `cinema-stage.tsx`, `call-stage.tsx` via
 * `screen-stage.tsx`) goes through this rather than passing `HlsMode`
 * straight through -- `"conventional"` is not a valid `HlsWatchPlayer.mode`
 * value, `"live"` is.
 */
export function watchPlayerMode(mode: HlsMode): "live" | "ll" {
  return mode === "ll" ? "ll" : "live";
}

/**
 * What THIS SESSION is actually behaving as, once §4's pin rule (two
 * part-load errors inside 10s) may have moved it off LL client-side --
 * which the server never learns about, so the `mode` prop itself keeps
 * saying `"ll"` for the rest of the party. Every reader of "which mode is
 * this, right now" -- the hls.js config, the watchdog, the seek offset, the
 * live badge and, eventually, any telemetry sample -- must go through this
 * rather than the raw prop (Farol review, this PR: the badge kept showing
 * an LL latency reading after a session had already been pinned to
 * conventional-style targeting).
 */
export function effectiveHlsMode(
  mode: HlsMode,
  pinnedToConventional: boolean,
): HlsMode {
  return pinnedToConventional ? "conventional" : mode;
}

/**
 * `LIVE_HLS_REMUX_PART_MS`'s own default (`server/src/voice/hls-remux.ts`),
 * mirrored client-side for the case `partTargetMs` is absent on an `ll`
 * stream -- every deployment that has not overridden the env var runs this
 * value today, so the fallback is honest rather than a guess.
 */
export const LL_HLS_DEFAULT_PART_TARGET_MS = 500;

/**
 * The sane band a real `partTargetMs` lives in. `LIVE_HLS_REMUX_PART_MS`
 * defaults to 500 and the plan's whole latency budget (§2) assumes
 * sub-second parts; nothing in `docs/plans/LL_HLS.md` proposes a part under
 * 200ms (more overhead than picture) or over 2s (no longer "low latency" by
 * any definition this feature uses).
 */
export const LL_HLS_MIN_PART_TARGET_MS = 200;
export const LL_HLS_MAX_PART_TARGET_MS = 2_000;

/**
 * The ONE validity check for a raw `partTargetMs`, wherever it is read from:
 * the live stream (`hlsPartTargetMs` below), a prop already threaded down
 * to `HlsWatchPlayer`, `collectScreenTiles`' tile output, or the stall
 * watchdog's `configureForMode`. Non-finite or outside
 * [`LL_HLS_MIN_PART_TARGET_MS`, `LL_HLS_MAX_PART_TARGET_MS`] falls back to
 * the default rather than being trusted as-is (Farol review, this PR): a
 * value outside that band is a malformed frame or a caller bug, not a real
 * deployment's part target, and every LL number in this file -- the config,
 * the watchdog thresholds, the seek offset, the badge threshold -- is
 * derived from it.
 */
export function validPartTargetMs(value: number | null | undefined): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < LL_HLS_MIN_PART_TARGET_MS ||
    value > LL_HLS_MAX_PART_TARGET_MS
  ) {
    return LL_HLS_DEFAULT_PART_TARGET_MS;
  }
  return value;
}

export function hlsPartTargetMs(
  stream: LlHlsStreamFields | null | undefined,
): number {
  return validPartTargetMs(stream?.partTargetMs);
}

/**
 * §5's SEGMENT-level stall ceiling for the full escalating ladder
 * (`sequence-stuck`: start-load, restart-load, reload-level, then
 * reconnect/dead). Farol review, this PR: the ladder keys on
 * `EXT-X-MEDIA-SEQUENCE` (`HlsStallWatch.onMediaSequence`, fed from hls.js's
 * `LEVEL_UPDATED`'s `details.startSN`/`endSN`), and that number only
 * advances once per closed SEGMENT even in LL mode -- segments still close
 * on the elastic rule in `docs/plans/LL_HLS.md` §3, roughly every
 * `HLS_LIVE_SEGMENT_SECONDS`, while PARTS arrive far more often. An earlier
 * version of this constant scaled the SAME threshold to a handful of PARTS,
 * which fired the full ladder on a perfectly healthy stream: the segment
 * number legitimately does not move for several seconds, parts or no parts.
 * `LL_HLS_SEQUENCE_STUCK_SEGMENTS` keeps this SEGMENT-paced -- three
 * segments, floored at `LL_HLS_SEQUENCE_STUCK_FLOOR_MS` -- tighter than the
 * conventional 20 s constructor default but never part-scaled. See
 * `HlsStallWatch.configureForMode` and, separately, `LL_HLS_PART_STUCK_PARTS`
 * below for the actual part-level signal.
 */
export const LL_HLS_SEQUENCE_STUCK_SEGMENTS = 3;
export const LL_HLS_SEQUENCE_STUCK_FLOOR_MS = 6_000;

/**
 * §5's PART-level stall check, SEPARATE from the segment-based ceiling
 * above: parts stop arriving at all, not merely "no new segment yet" (which
 * is the ordinary, healthy case for seconds at a time). Farol review, this
 * PR: this rule exists precisely because the segment-based ceiling above is
 * -- correctly -- too slow to catch a dead part feed quickly, so it fires
 * the ladder's FIRST in-place recovery step exactly once per stall episode
 * and never escalates further on its own; a problem that persists past that
 * one nudge is left for the segment-based ceiling's own full ladder to
 * eventually catch. Four parts, not six: at a 500 ms target that is 2 s,
 * comfortably inside the segment ceiling's 6 s floor.
 */
export const LL_HLS_PART_STUCK_PARTS = 4;

/**
 * How far behind the edge hls.js is allowed to drift before it forces a
 * seek forward (`config.liveMaxLatencyDuration`). HLS has no manifest tag
 * for this the way `PART-HOLD-BACK` covers the sync target, so it stays a
 * config concern -- sized off the party's own part target, never a fixed
 * number, per §2's "do not hardcode 20 s anywhere on this path".
 */
export const LL_HLS_MAX_LATENCY_PARTS = 8;

/**
 * hls.js's OWN low-latency catch-up (`config.maxLiveSyncPlaybackRate`,
 * verified against `hls.mjs`'s `LatencyController`: it nudges
 * `video.playbackRate` up to this ceiling whenever `lowLatencyMode` is on
 * and the playhead trails the manifest's own hold-back). The conventional
 * path deliberately sets this to `1` (off) and runs its OWN external curve
 * instead (`catchUpPlaybackRate` below) -- built when the player still sat
 * ~20 s behind live and needed a curve gentler than hls.js's flat ceiling.
 * LL has no such history and no 20 s cushion to protect: the manifest's own
 * hold-back IS the target, so letting hls.js's built-in controller chase it
 * is "stop overriding the manifest" applied to catch-up too, not just to
 * hold-back. `HlsWatchPlayer` skips its own manual `video.playbackRate`
 * loop on the LL path for exactly this reason -- see its comment.
 */
export const LL_HLS_MAX_LIVE_SYNC_PLAYBACK_RATE = 1.1;

/** A handful of parts, not a segment: no 20 s cushion to protect here. */
export const LL_HLS_BACK_BUFFER_SECONDS = 4;
export const LL_HLS_MAX_BUFFER_LENGTH_SECONDS = 6;
export const LL_HLS_MAX_MAX_BUFFER_LENGTH_SECONDS = 10;

export interface HlsLLPlayerConfig {
  lowLatencyMode: true;
  /**
   * Deliberately the only live-edge-targeting field this config sets.
   * `liveSyncDuration`/`liveSyncDurationCount` are left OUT on purpose:
   * verified against `hls.mjs`'s `LatencyController.updateTargetLatency`,
   * hls.js only overrides the manifest's `PART-HOLD-BACK`/`HOLD-BACK` when
   * the constructor's OWN `userConfig` set `liveSyncDuration` or
   * `liveSyncDurationCount` -- so omitting both here is what "defer to the
   * manifest when one is present" (`docs/plans/LL_HLS.md` §4) actually
   * means in hls.js terms, not just a comment. `liveMaxLatencyDuration` has
   * no manifest equivalent to defer to (HLS states a hold-back, never a
   * "this is too far" ceiling), so it stays an explicit, part-derived
   * config value.
   */
  liveMaxLatencyDuration: number;
  maxLiveSyncPlaybackRate: number;
  maxBufferLength: number;
  maxMaxBufferLength: number;
  backBufferLength: number;
  startLevel: number;
}

/**
 * The LL hls.js config, pure and derived entirely from `partTargetMs` --
 * never a hardcoded 20 s, and never `liveSyncDurationCount`/`liveSyncDuration`
 * (see `HlsLLPlayerConfig`'s own comment on why leaving those two out is the
 * whole point).
 */
export function llHlsConfig(partTargetMs: number): HlsLLPlayerConfig {
  const partSeconds =
    Number.isFinite(partTargetMs) && partTargetMs > 0
      ? partTargetMs / 1000
      : LL_HLS_DEFAULT_PART_TARGET_MS / 1000;
  return {
    lowLatencyMode: true,
    liveMaxLatencyDuration: LL_HLS_MAX_LATENCY_PARTS * partSeconds,
    maxLiveSyncPlaybackRate: LL_HLS_MAX_LIVE_SYNC_PLAYBACK_RATE,
    maxBufferLength: LL_HLS_MAX_BUFFER_LENGTH_SECONDS,
    maxMaxBufferLength: LL_HLS_MAX_MAX_BUFFER_LENGTH_SECONDS,
    backBufferLength: LL_HLS_BACK_BUFFER_SECONDS,
    startLevel: -1,
  };
}

/**
 * The "jump to live"/recovery seek offset (`jumpToLiveTime`'s
 * `segmentSeconds` argument), mode-aware: one part behind the edge on LL
 * instead of one whole 4 s segment, which on a 500 ms part target would
 * throw away seven parts of an already-tiny window for nothing.
 */
export function liveSeekOffsetSeconds(
  mode: HlsMode,
  partTargetMs: number = LL_HLS_DEFAULT_PART_TARGET_MS,
): number {
  if (mode === "ll") {
    return Math.max(0.05, partTargetMs) / 1000;
  }
  return HLS_LIVE_SEGMENT_SECONDS;
}

/**
 * The "behind live" / "jump to live" badge threshold, mode-aware. The
 * conventional constant (`BEHIND_LIVE_THRESHOLD_SECONDS`, 30 s) is tuned for
 * a player that sits ~20 s behind live ON PURPOSE; on LL the whole budget is
 * 2 to 4 s, so 30 s would never fire. Reuses `LL_HLS_MAX_LATENCY_PARTS`
 * rather than inventing a third number: roughly where hls.js's own
 * `liveMaxLatencyDuration` would force a seek anyway.
 */
export function behindLiveThresholdSeconds(
  mode: HlsMode,
  partTargetMs: number = LL_HLS_DEFAULT_PART_TARGET_MS,
): number {
  if (mode === "ll") {
    return (LL_HLS_MAX_LATENCY_PARTS * partTargetMs) / 1000;
  }
  return BEHIND_LIVE_THRESHOLD_SECONDS;
}

/**
 * §5: "a second stall inside the same window demotes the channel to the
 * conventional ladder for the rest of the session" (L1.6's watchdog, not yet
 * merged). True exactly for that transition on the SAME viewing session --
 * never for a session change (that is an ordinary re-attach, handled
 * elsewhere by `shouldAdoptHlsSource`) and never the reverse (nothing on the
 * server promotes a live party from conventional to `ll` mid-session).
 */
export function isInPlaceModeDemotion(input: {
  previousMode: HlsMode;
  nextMode: HlsMode;
  sameSession: boolean;
}): boolean {
  return (
    input.sameSession &&
    input.previousMode === "ll" &&
    input.nextMode === "conventional"
  );
}

/**
 * §4: "two part-load errors inside 10 s pin the player to a conventional
 * rung for the rest of the session. A viewer who cannot hold the edge should
 * stop trying, not oscillate." `timestampsMs` is every part-load error seen
 * so far this session, ascending; true once the last two are within
 * `windowMs` of each other.
 */
export const LL_HLS_PART_ERROR_PIN_WINDOW_MS = 10_000;

export function shouldPinToConventionalRung(
  timestampsMs: readonly number[],
  windowMs: number = LL_HLS_PART_ERROR_PIN_WINDOW_MS,
): boolean {
  if (timestampsMs.length < 2) {
    return false;
  }
  const last = timestampsMs[timestampsMs.length - 1]!;
  const secondLast = timestampsMs[timestampsMs.length - 2]!;
  return last - secondLast <= windowMs;
}

/**
 * hls.js `ERROR` detail strings that mean a fragment/part failed to load --
 * the "part-load error" `shouldPinToConventionalRung` counts. LL parts are
 * loaded as ordinary fragment requests in hls.js's own loader (there is no
 * separate "part" error family), so this is the same detail set a
 * conventional stream's network errors would use; the caller only feeds it
 * errors seen while `mode === "ll"`.
 */
const PART_LOAD_ERROR_DETAILS = new Set([
  "fragLoadError",
  "fragLoadTimeOut",
  "fragParsingError",
]);

export function isLlPartLoadErrorDetail(details: string): boolean {
  return PART_LOAD_ERROR_DETAILS.has(details);
}

/**
 * Where "jump to live" should land. Seeking onto the exact live edge
 * sits inside the newest segment and often `waiting` immediately.
 */
export function jumpToLiveTime(
  liveSyncPosition: number,
  segmentSeconds: number = HLS_LIVE_SEGMENT_SECONDS,
): number {
  if (!Number.isFinite(liveSyncPosition)) {
    return liveSyncPosition;
  }
  return Math.max(0, liveSyncPosition - segmentSeconds);
}

/**
 * The real live edge, not a leftover `liveSyncPosition` from a short window.
 *
 * THE BUG THIS EXISTS FOR. Recover / jump-to-live used
 * `hls.liveSyncPosition ?? video.duration`. After `startLoad()` the sync
 * point can be the first-window value (~6–8 s) while the media element's
 * timeline has already grown with the session. Seeking there jumps the
 * picture back about a minute of already-buffered media and keeps playing
 * — no stall, just the wrong part of the film. Prefer the larger of the
 * two finite clocks; that is the actual edge.
 */
export function resolveLiveEdge(
  liveSyncPosition: number | null | undefined,
  seekableEnd: number,
): number | null {
  const candidates = [liveSyncPosition, seekableEnd].filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  if (candidates.length === 0) {
    return null;
  }
  return Math.max(...candidates);
}

/** Last end of `video.seekable`. Empty range is not a live edge. */
export function mediaSeekableEnd(video: {
  seekable: { length: number; end: (index: number) => number };
}): number {
  const { seekable } = video;
  if (seekable.length === 0) {
    return Number.NaN;
  }
  return seekable.end(seekable.length - 1);
}

/**
 * Where a recover / jump-to-live seek may move the playhead.
 *
 * Returns null instead of a target more than one live window behind the
 * current playhead: that seek is not "catch up", it is the Chrome content
 * swap (old media still sitting in an infinite back-buffer).
 */
export function liveSeekTarget(input: {
  currentTime: number;
  liveSyncPosition: number | null | undefined;
  seekableEnd: number;
  /**
   * How far behind the edge to land (`jumpToLiveTime`'s own parameter).
   * Defaults to a conventional segment; the LL path passes
   * `liveSeekOffsetSeconds("ll", partTargetMs)` instead.
   */
  segmentSeconds?: number;
}): number | null {
  const edge = resolveLiveEdge(input.liveSyncPosition, input.seekableEnd);
  if (edge === null) {
    return null;
  }
  const target = jumpToLiveTime(edge, input.segmentSeconds);
  if (
    Number.isFinite(input.currentTime) &&
    input.currentTime - target > HLS_LIVE_WINDOW_SECONDS
  ) {
    return null;
  }
  return target;
}

/**
 * True when a live-sync / max-latency pair still sits inside the PRODUCTION
 * (60 s) window. The attach path must not start so far from the edge that the
 * playhead falls out the back on the next playlist update.
 *
 * This validates the configured counts against the widened window only; the
 * shorter egress/legacy window (`HLS_EGRESS_WINDOW_SEGMENTS`) cannot be known
 * until a playlist loads, and is handled live by
 * `effectiveLiveSyncDurationCount` on each `LEVEL_UPDATED`.
 */
export function hlsLiveSyncFitsWindow(config: HlsLivePlayerConfig): boolean {
  const sync = config.liveSyncDurationCount * HLS_LIVE_SEGMENT_SECONDS;
  const maxLatency =
    config.liveMaxLatencyDurationCount * HLS_LIVE_SEGMENT_SECONDS;
  return (
    sync < HLS_LIVE_WINDOW_SECONDS &&
    maxLatency <= HLS_LIVE_WINDOW_SECONDS &&
    maxLatency > sync &&
    config.maxBufferLength <= HLS_LIVE_WINDOW_SECONDS &&
    config.maxMaxBufferLength <= HLS_LIVE_WINDOW_SECONDS &&
    Number.isFinite(config.backBufferLength) &&
    config.backBufferLength <= HLS_LIVE_WINDOW_SECONDS
  );
}

/** How far behind hls.js's live edge the playhead currently sits. */
export function secondsBehindLive(
  currentTime: number,
  liveEdge: number,
): number {
  return Math.max(0, liveEdge - currentTime);
}

/**
 * The "Ao vivo" badge turns into a "Pular pro ao vivo" button once the
 * playhead drifts more than this far behind hls.js's live edge. With the
 * player itself now sitting ~20 s back by design (`HLS_LIVE_SYNC_DURATION_COUNT`),
 * a threshold at the old 10 s would flag every viewer sitting exactly where
 * the player put them. 30 s only fires on top of the delay that is already
 * the product (buffering, a paused tab catching up, a throttled background
 * tab), not on the cushion everyone always has.
 */
export const BEHIND_LIVE_THRESHOLD_SECONDS = 30;

export function isBehindLive(
  currentTime: number,
  liveEdge: number,
  threshold: number = BEHIND_LIVE_THRESHOLD_SECONDS,
): boolean {
  return secondsBehindLive(currentTime, liveEdge) > threshold;
}

/**
 * How fast the picture should chase the live edge, keyed on how far behind
 * it currently sits. Never faster than this (`BROADCAST_PIPELINE.md` B1.1).
 */
export const HLS_CATCH_UP_MAX_PLAYBACK_RATE = 1.2;

/**
 * How far behind the player's INTENDED sync point the playhead sits, for
 * `catchUpPlaybackRate` below.
 *
 * THE BUG THIS EXISTS FOR (Farol review, PR 570). The player sits
 * `cushionSeconds` behind the live edge ON PURPOSE
 * (`HLS_PLAYER_CUSHION_SECONDS`, ~20 s), so passing `secondsBehindLive`'s raw
 * edge distance straight to `catchUpPlaybackRate` flagged every ordinary
 * viewer sitting exactly where the design put them: `> 6` on that curve is
 * `1.2x`, and an untouched viewer's distance from the edge is ~20 s, so the
 * common path ran at the curve's fastest rate continuously, raced everyone
 * toward the actual edge, and pitched the presenter's audio for the whole
 * party -- the cushion this player exists to hold, defeated by its own
 * catch-up logic. Distance here is measured from `liveEdge - cushionSeconds`,
 * the point hls.js is actually aiming to hold, so only genuine drift PAST
 * that cushion is ever non-zero. `secondsBehindLive`/`isBehindLive` stay
 * edge-relative on purpose -- that pair only feeds the "jump to live" badge,
 * which is deliberately about the real edge, not the cushioned target.
 */
export function secondsBehindCatchUpTarget(
  currentTime: number,
  liveEdge: number,
  cushionSeconds: number = HLS_PLAYER_CUSHION_SECONDS,
): number {
  if (!Number.isFinite(currentTime) || !Number.isFinite(liveEdge)) {
    return 0;
  }
  return Math.max(0, liveEdge - cushionSeconds - currentTime);
}

/**
 * A gentle catch-up curve, not the flat multiplier the review re-proposed.
 *
 * WHY A CURVE, AND WHY IT STAYS LOW. `maxLiveSyncPlaybackRate: 1.5` was
 * shipped once and reverted (`hls-watch-player.tsx`, next to
 * `HLS_LIVE_SYNC_DURATION_COUNT`): against the old 10 s window the playhead
 * sat past the sync point almost always, so 1.5x was not catch-up, it was
 * the ordinary playback speed, and it pitched the presenter's music for the
 * whole party. The player now sits ~20 s behind live ON PURPOSE
 * (`HLS_PLAYER_CUSHION_SECONDS`), so "distance from where the design put
 * you" is a meaningful, rare trigger rather than the common case.
 *
 * Even so, whether the presenter's audio is music-heavy right now is not
 * something this player can detect, so there is no "hold 1.0x during music"
 * rule to fall back on -- the curve is gentle everywhere instead of fast
 * anywhere. 1.2x is a barely-perceptible pitch shift; 1.5x was not. This
 * moves the target smoothly (`video.playbackRate`, applied continuously
 * below): a viewer who drifts gets nudged back over several seconds, never
 * a jump-cut seek.
 */
export function catchUpPlaybackRate(secondsBehindTarget: number): number {
  if (!Number.isFinite(secondsBehindTarget) || secondsBehindTarget <= 1) {
    // Comfortably covers "back to 1.0x within 0.5 s of target" too.
    return 1;
  }
  if (secondsBehindTarget <= 3) {
    return 1.05;
  }
  if (secondsBehindTarget <= 6) {
    return 1.1;
  }
  return HLS_CATCH_UP_MAX_PLAYBACK_RATE;
}

/**
 * The subset of an hls.js instance the recovery ladder's in-place steps
 * touch. Kept apart from `HlsQualityHandle` even though it overlaps: this
 * one exists for recovery, not for a viewer's own quality pick, and the two
 * should stay free to diverge.
 */
export interface HlsRecoveryHandle {
  currentLevel: number;
  recoverMediaError?: () => void;
  startLoad?: (startPosition?: number) => void;
  stopLoad?: () => void;
}

/**
 * Force hls.js to re-request the currently playing level's media playlist,
 * without creating a new instance and, where the level is pinned rather
 * than Auto, without losing the pin.
 *
 * THE MECHANISM. hls.js has no direct "reload this level" call. Cycling
 * `currentLevel` through Auto (`-1`) and back to whatever was actually
 * selected is what forces its level controller to treat the level as
 * changed and re-fetch its playlist; reassigning the SAME value again is
 * not guaranteed to register as a change at all. A level already on Auto
 * only needs the one assignment: ABR will reselect and the resulting fetch
 * reloads it regardless of which rung it lands on.
 */
export function reloadHlsLevelPlaylist(hls: HlsRecoveryHandle): void {
  const level = hls.currentLevel;
  hls.stopLoad?.();
  hls.currentLevel = -1;
  if (level >= 0) {
    hls.currentLevel = level;
  }
  hls.startLoad?.(-1);
}

/**
 * Run one step of the recovery ladder (`hls-stall.ts`) against a real hls.js
 * instance. Split out from the component so the mapping from a decision to
 * an actual hls.js call is itself something a test can hand a fake handle
 * to, the same way `applyHlsQualityLevel` is (`hls-quality.ts`).
 *
 * Deliberately silent on every decision this ladder does not own
 * (`"none"`, `"reconnect"`, `"rebuild"`, `"dead"`): those are the
 * component's job (asking the server, or tearing the instance down).
 */
export function applyHlsRecoveryStep(
  hls: HlsRecoveryHandle | null | undefined,
  decision: "recover-media-error" | "start-load" | "restart-load" | "reload-level",
): void {
  if (!hls) {
    return;
  }
  switch (decision) {
    case "recover-media-error":
      hls.recoverMediaError?.();
      return;
    case "start-load":
      hls.startLoad?.(-1);
      return;
    case "restart-load":
      hls.stopLoad?.();
      hls.startLoad?.(-1);
      return;
    case "reload-level":
      reloadHlsLevelPlaylist(hls);
      return;
  }
}

export interface MediaSessionMetadataInput {
  /** The party or presenter's title. Falls back to the channel name. */
  title: string;
  /** Community or server name, shown as the artist/album line. */
  communityName?: string | null;
  /** Server icon, used when no dedicated cover exists for the stream. */
  coverUrl?: string | null;
}

export interface BuiltMediaSessionMetadata {
  title: string;
  artist: string;
  album: string;
  artwork: { src: string; sizes: string; type?: string }[];
}

/**
 * What goes on the lock screen. Without this the OS falls back to the page
 * title, which for pqp is the deploy URL
 * (`staging.pqp-3yr.pages.dev`), not the party anyone actually joined.
 */
export function buildMediaSessionMetadata(
  input: MediaSessionMetadataInput,
): BuiltMediaSessionMetadata {
  return {
    title: input.title,
    artist: input.communityName ?? "pqp",
    album: input.communityName ?? "pqp",
    artwork: input.coverUrl
      ? [{ src: input.coverUrl, sizes: "512x512" }]
      : [],
  };
}

/**
 * Whether this document/browser can offer Picture-in-Picture for a video
 * element at all. Safari has no `document.pictureInPictureEnabled`; it
 * exposes presentation modes on the element instead, which the caller
 * checks separately (`hasSafariPresentationMode`).
 */
export function isPipAvailable(input: {
  pictureInPictureEnabled: boolean;
  disablePictureInPicture: boolean;
}): boolean {
  return input.pictureInPictureEnabled && !input.disablePictureInPicture;
}

/** Safari's non-standard PiP surface, present when `document.pictureInPictureEnabled` is not. */
export function hasSafariPresentationMode(video: unknown): boolean {
  return (
    typeof video === "object" &&
    video !== null &&
    "webkitSupportsPresentationMode" in video &&
    typeof (video as { webkitSupportsPresentationMode: unknown })
      .webkitSupportsPresentationMode === "function" &&
    (
      video as { webkitSupportsPresentationMode: (mode: string) => boolean }
    ).webkitSupportsPresentationMode("picture-in-picture")
  );
}
