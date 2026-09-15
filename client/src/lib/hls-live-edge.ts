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

/**
 * hls.js's own default (`nudgeMaxRetry: 3`) times out its gap-skip/nudge
 * loop (`GapController`, `highBufferWatchdogPeriod: 2 s` between attempts)
 * after roughly 6-8 s and declares the source fatal, which is what hands
 * the stall to `HlsStallWatch`'s heavier ladder (`start-load` /
 * `reload-level`) -- the step that forces hls.js to re-fetch and
 * re-append the level, and is what makes a transient egress hiccup look
 * like a few seconds of the stream repeating rather than a brief pause.
 *
 * A CPU-saturated egress (2026-09-14 party: ~94% on the transcode
 * container) that falls behind for several seconds but is still alive is
 * exactly the case hls.js's own tiny (0.1 s-scale) nudges are built to ride
 * out on their own, without ever reaching for the level reload -- they just
 * need longer than hls.js's default budget to do it. Raised from 3 to 8:
 * roughly 16-18 s of hls.js's own quiet retries before it gives up and
 * escalates, instead of ~6-8 s.
 *
 * TRADE-OFF: a source that is genuinely dead now takes that much longer to
 * reach the holding screen / rebuild path, in exchange for far fewer
 * visible repeats on the transient hiccups this was tuned against. Paired
 * with a matching bump to `HlsStallWatch`'s own `stallMs` where the player
 * constructs it -- that timer is independent of hls.js's internal fatal
 * declaration and would otherwise still fire the same ladder on its own
 * schedule.
 */
export const HLS_NUDGE_MAX_RETRY = 8;

export interface HlsLivePlayerConfig {
  liveSyncDurationCount: number;
  liveMaxLatencyDurationCount: number;
  maxBufferLength: number;
  maxMaxBufferLength: number;
  backBufferLength: number;
  /** Auto: ABR picks from the seed, which is the 720p60@3200 rung. */
  startLevel: number;
  /** hls.js's own gap-skip/nudge retry budget; see `HLS_NUDGE_MAX_RETRY`. */
  nudgeMaxRetry: number;
}

export function hlsLivePlayerConfig(): HlsLivePlayerConfig {
  return {
    liveSyncDurationCount: HLS_LIVE_SYNC_DURATION_COUNT,
    liveMaxLatencyDurationCount: HLS_LIVE_MAX_LATENCY_DURATION_COUNT,
    maxBufferLength: HLS_MAX_BUFFER_LENGTH_SECONDS,
    maxMaxBufferLength: HLS_MAX_MAX_BUFFER_LENGTH_SECONDS,
    backBufferLength: HLS_BACK_BUFFER_LENGTH_SECONDS,
    startLevel: -1,
    nudgeMaxRetry: HLS_NUDGE_MAX_RETRY,
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
 * The two LL fields of `LiveHlsStream`, as a structural minimum.
 *
 * BOTH ARE ON THE WIRE TYPE NOW (`packages/shared/src/live-hls.ts`): `mode`
 * since PR 580, `partTargetMs` since the change that made the delivery mode
 * a statement rather than a guess. This interface no longer exists to paper
 * over a missing type -- it exists so the readers below (`hlsModeOf`,
 * `hlsPartTargetMs`) accept anything carrying those two fields: a whole
 * `LiveHlsStream`, a `collectScreenTiles` tile, or a test fixture that has
 * no business constructing a full stream.
 *
 * Kept deliberately narrow for a second reason. This client does not
 * validate incoming `channel-live`/`voice-stream` frames against the shared
 * zod schema at all (`client/src/lib/realtime.ts`'s `JSON.parse(...) as
 * ChatServerMessage | VoiceSignalingMessage` is a type assertion, not a
 * parse), so `partTargetMs` arriving as something absurd is a real runtime
 * possibility -- which is what `validPartTargetMs` below is for, and why
 * nothing reads the raw field directly.
 */
export interface LlHlsStreamFields {
  mode?: HlsMode;
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
 *
 * APPLIED AFTER CONSTRUCTION, NEVER IN THE CONSTRUCTOR CONFIG -- see
 * `applyLlLatencyCeiling` for why, and for the production outage that
 * taught it.
 */
export const LL_HLS_MAX_LATENCY_PARTS = 8;

/** The ceiling itself, in seconds, from this party's own part target. */
export function llMaxLatencySeconds(partTargetMs: number): number {
  return (LL_HLS_MAX_LATENCY_PARTS * validPartTargetMs(partTargetMs)) / 1000;
}

/**
 * How much room above the manifest's own `PART-HOLD-BACK` the ceiling keeps.
 *
 * THE CEILING HAS TO SIT ABOVE THE TARGET, AND THE TARGET IS THE MANIFEST'S.
 * `LL_HLS_MAX_LATENCY_PARTS` is a number about the part target and nothing
 * else, which was fine while the two happened to agree: at a 500 ms part
 * target it is 4 s, comfortably above the 1.5 s `PART-HOLD-BACK` the remux
 * advertised on 2026-09-15. Raise the hold-back to ~3 s (the edge's own fix
 * for the same evening's rebuffering) and the pair becomes 3 s of target
 * under a 4 s ceiling: one second of slack, after which
 * `StreamController.synchronizeToLiveEdge` force-seeks the playhead
 * (`currentTime < end - maxLatency`). A viewer who hiccups for a second
 * gets a seek, which empties the tiny LL buffer, which is another hiccup.
 * That is the "struggles until it settles" shape, self-inflicted.
 *
 * So the ceiling is the larger of the two readings, and the manifest one
 * carries six parts of headroom above whatever hold-back the server chose.
 * Six because it is three seconds at the 500 ms target: enough that an
 * ordinary stumble is ridden out by `maxLiveSyncPlaybackRate` instead of a
 * seek, and still far short of the conventional path's 20 s cushion.
 */
export const LL_HLS_LATENCY_CEILING_HEADROOM_PARTS = 6;

/**
 * The LL latency ceiling in seconds, given what the manifest actually says.
 * `partHoldBackSeconds` is hls.js's own `LevelDetails.partHoldBack`, which
 * is only known once a playlist has loaded -- `null`/absent (the attach,
 * before the first `LEVEL_UPDATED`) keeps exactly the part-derived number
 * `llMaxLatencySeconds` always returned.
 */
export function llLatencyCeilingSeconds(
  partTargetMs: number,
  partHoldBackSeconds?: number | null,
): number {
  const floor = llMaxLatencySeconds(partTargetMs);
  if (
    typeof partHoldBackSeconds !== "number" ||
    !Number.isFinite(partHoldBackSeconds) ||
    partHoldBackSeconds <= 0
  ) {
    return floor;
  }
  const headroom =
    (LL_HLS_LATENCY_CEILING_HEADROOM_PARTS * validPartTargetMs(partTargetMs)) /
    1000;
  return Math.max(floor, partHoldBackSeconds + headroom);
}

/**
 * Sets the LL latency ceiling on an ALREADY CONSTRUCTED hls.js instance.
 *
 * THIS IS NOT A STYLE CHOICE, IT IS THE ONLY PLACE hls.js ACCEPTS IT.
 * `mergeConfig` (verified against `hls.mjs` 1.7.2) validates the
 * constructor's own `userConfig` and THROWS on this exact pair:
 *
 *   if (userConfig.liveMaxLatencyDuration !== undefined &&
 *       (userConfig.liveSyncDuration === undefined ||
 *        userConfig.liveMaxLatencyDuration <= userConfig.liveSyncDuration))
 *     throw new Error('Illegal hls.js config: "liveMaxLatencyDuration" must
 *                      be greater than "liveSyncDuration"');
 *
 * and `llHlsConfig` omits `liveSyncDuration` ON PURPOSE, because setting it
 * is precisely what stops hls.js deferring to the manifest's own
 * `PART-HOLD-BACK` (`HlsLLPlayerConfig`'s own comment). The two requirements
 * are only compatible if the ceiling goes on after the merge. It cost a live
 * party: shipped in the constructor config, `new Hls(llHlsConfig(...))` threw
 * for EVERY LL viewer, `attach()` was called as `void attach()` so the
 * rejection was unhandled and silent, `loadSource` was never reached, and a
 * viewer sat on "A transmissão travou, reconectando" having issued not one
 * request for a playlist. Production, 2026-09-15: a two-minute HAR of a
 * viewer holding a correct `mode: "ll"` frame and a correct edge URL contains
 * zero requests to the edge host.
 *
 * `hls.config` is the MERGED config and hls.js reads the ceiling off it
 * (`LatencyController.maxLatency`), not off `userConfig`; hls.js mutates the
 * same object itself when a caller sets `hls.targetLatency`. Typed
 * structurally so this file keeps needing no hls.js import.
 */
export function applyLlLatencyCeiling(
  player: { config: { liveMaxLatencyDuration?: number } },
  partTargetMs: number,
  partHoldBackSeconds?: number | null,
): void {
  player.config.liveMaxLatencyDuration = llLatencyCeilingSeconds(
    partTargetMs,
    partHoldBackSeconds,
  );
}

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

/**
 * WHAT THIS CONFIG DELIBERATELY DOES NOT CONTAIN, AND WHY THAT IS THE WHOLE
 * POINT. `liveSyncDuration`/`liveSyncDurationCount` are left OUT: verified
 * against `hls.mjs`'s `LatencyController.updateTargetLatency`, hls.js only
 * overrides the manifest's `PART-HOLD-BACK`/`HOLD-BACK` when the
 * constructor's OWN `userConfig` set one of those two -- so omitting both is
 * what "defer to the manifest when one is present" (`docs/plans/LL_HLS.md`
 * §4) actually means in hls.js terms, not just a comment.
 *
 * `liveMaxLatencyDuration` is left out too, for a DIFFERENT reason: hls.js
 * refuses a constructor config that carries it without `liveSyncDuration`,
 * and refuses it by throwing. It is still applied, after construction, by
 * `applyLlLatencyCeiling` -- see that function for the outage.
 */
export interface HlsLLPlayerConfig {
  lowLatencyMode: true;
  maxLiveSyncPlaybackRate: number;
  maxBufferLength: number;
  maxMaxBufferLength: number;
  backBufferLength: number;
  startLevel: number;
  /**
   * THE MASTER PLAYLIST OF A WARMING LL SESSION IS A RETRYABLE 503, and
   * hls.js's default budget for that is one retry.
   *
   * The edge Worker answers `503 Retry-After: 1` while `pqp-remux` has not
   * written its first `state.json` for a session -- deliberately, because
   * the alternative is what shipped before: quietly serving the
   * conventional ladder's master for an LL session, whose conventional
   * ladder the API never started (`tools/hls-edge/src/index.ts`,
   * `llNotReady`). Riding that window out is the player's half of the
   * bargain, and hls.js's stock `manifestLoadPolicy.default.errorRetry` is
   * `maxNumRetry: 1` -- two 503s and the manifest load is fatal, which on a
   * session that needs two seconds to subscribe is most of them.
   *
   * Verified against `hls.mjs`: `retryForHttpStatus` retries any status
   * outside 4xx, so a 503 IS retried; only the budget was too small. The
   * delays are paced to the edge's own `Retry-After` rather than as fast as
   * hls.js will go -- see `LL_HLS_MANIFEST_RETRY_DELAY_MS`.
   * Everything but `errorRetry` here is hls.js's own default for this
   * policy, restated because the config is replaced wholesale, not merged.
   * LL only -- the conventional path never sees this branch and keeps the
   * stock policy it has always had.
   */
  manifestLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: number;
      maxLoadTimeMs: number;
      timeoutRetry: { maxNumRetry: number; retryDelayMs: number; maxRetryDelayMs: number };
      errorRetry: { maxNumRetry: number; retryDelayMs: number; maxRetryDelayMs: number };
    };
  };
  /**
   * A TRANSIENT 500 ON A PART MUST NOT COST THE PART THAT FOLLOWS IT.
   *
   * hls.js's stock `fragLoadPolicy` is six error retries paced 1 s, 2 s, 4 s,
   * 8 s, 8 s -- a budget written for 4 s segments, where waiting eight
   * seconds for one is a hiccup. Against 500 ms parts it is a guarantee: by
   * the third retry the part being retried has left the ring, the ones after
   * it have too, and the player emerges from its own backoff behind the
   * window with nothing to ask for. That is exactly what the edge Worker's
   * five sporadic 500s produced on 2026-09-15 (21:29-21:41 UTC).
   *
   * Paced to the part instead: a handful of quick tries inside roughly a
   * second and a half, then let it go fatal, where the live-edge recovery
   * (`isMissingFragmentError`) picks it up and jumps to live rather than
   * grinding through a stale window. Fewer retries than the default and a
   * far better outcome, because failing fast on a live edge is how you stay
   * on it. `timeoutRetry` is hls.js's own default, restated because this
   * policy is replaced wholesale rather than merged.
   */
  fragLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: number;
      maxLoadTimeMs: number;
      timeoutRetry: { maxNumRetry: number; retryDelayMs: number; maxRetryDelayMs: number };
      errorRetry: { maxNumRetry: number; retryDelayMs: number; maxRetryDelayMs: number };
    };
  };
}

/**
 * How many times an LL master load is retried before hls.js calls it fatal,
 * and how long between tries.
 *
 * PACED TO THE EDGE'S OWN `Retry-After`, NOT FASTER (a Farol finding on this
 * PR: a first draft retried every 500 ms, which at party scale is the client
 * half of a thundering herd -- the Worker's not-ready memo bounds what
 * reaches the REMUX, and bounds nothing about what reaches the Worker). The
 * Worker answers `Retry-After: 1`, so the first retry waits a second; hls.js
 * then backs off toward `maxRetryDelayMs`, giving 1 + 2 + 2 + 2 + 2 + 2 ≈
 * 11 s of patience for at most seven requests per viewer. Two hundred people
 * joining a session that takes ten seconds to warm up is therefore ~1400
 * Worker requests spread over eleven seconds, and still one `state.json`
 * fetch a second against the box.
 *
 * Eleven seconds is chosen against what it is waiting FOR: `pqp-remux` has
 * to subscribe to the LiveKit track and write one part. A start slower than
 * that is not a warm-up, and letting the load go fatal hands the viewer to
 * the player's own recovery ladder, which is where a genuinely broken
 * session belongs.
 */
export const LL_HLS_MANIFEST_RETRY_COUNT = 6;
export const LL_HLS_MANIFEST_RETRY_DELAY_MS = 1_000;
export const LL_HLS_MANIFEST_MAX_RETRY_DELAY_MS = 2_000;

/**
 * The part-paced fragment retry budget (`HlsLLPlayerConfig.fragLoadPolicy`).
 * Three tries at 200 ms, 400 ms, 800 ms is ~1.4 s of patience, under three
 * parts of the window -- enough to ride out a Worker blip, short enough that
 * what the player asks for next is still in the ring.
 */
export const LL_HLS_FRAG_RETRY_COUNT = 3;
export const LL_HLS_FRAG_RETRY_DELAY_MS = 200;
export const LL_HLS_FRAG_MAX_RETRY_DELAY_MS = 1_000;

/**
 * The LL hls.js CONSTRUCTOR config: everything hls.js will accept at
 * construction time, and nothing it will not.
 *
 * TAKES NO PART TARGET ANY MORE. The one field that was derived from it,
 * `liveMaxLatencyDuration`, cannot live in a constructor config at all
 * (`applyLlLatencyCeiling`), and everything left here is a fixed choice. A
 * caller that still has a part target hands it to `applyLlLatencyCeiling`
 * right after `new Hls(...)`; §2's "do not hardcode 20 s anywhere on this
 * path" is unchanged, the number just lands one line later.
 */
export function llHlsConfig(): HlsLLPlayerConfig {
  return {
    lowLatencyMode: true,
    maxLiveSyncPlaybackRate: LL_HLS_MAX_LIVE_SYNC_PLAYBACK_RATE,
    maxBufferLength: LL_HLS_MAX_BUFFER_LENGTH_SECONDS,
    maxMaxBufferLength: LL_HLS_MAX_MAX_BUFFER_LENGTH_SECONDS,
    backBufferLength: LL_HLS_BACK_BUFFER_SECONDS,
    startLevel: -1,
    manifestLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: Infinity,
        maxLoadTimeMs: 20_000,
        timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: {
          maxNumRetry: LL_HLS_MANIFEST_RETRY_COUNT,
          retryDelayMs: LL_HLS_MANIFEST_RETRY_DELAY_MS,
          maxRetryDelayMs: LL_HLS_MANIFEST_MAX_RETRY_DELAY_MS,
        },
      },
    },
    fragLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 10_000,
        maxLoadTimeMs: 30_000,
        timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: {
          maxNumRetry: LL_HLS_FRAG_RETRY_COUNT,
          retryDelayMs: LL_HLS_FRAG_RETRY_DELAY_MS,
          maxRetryDelayMs: LL_HLS_FRAG_MAX_RETRY_DELAY_MS,
        },
      },
    },
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
 * The HTTP statuses that mean "what you asked for is not here any more":
 * the edge Worker answers 404 for a part that has left the ring
 * (`hlsEdge.llPartMissing`), and 410 is the same answer said properly.
 */
const MISSING_FRAGMENT_STATUSES = new Set([404, 410]);

/**
 * A fatal error that says the PLAYER fell behind the window, not that the
 * STREAM is gone.
 *
 * §5's rule, which the 2026-09-15 run found the client did not have: a 404
 * on a part or segment is "you are asking for the wrong place", and the
 * remedy for that is to jump to live, not to tell a room full of people the
 * broadcast died. hls.js cannot make that distinction on its own -- a 4xx is
 * never retried (`retryForHttpStatus`), an LL master usually offers no other
 * level to fail over to, so the error controller has nowhere to go but
 * fatal, and the viewer got "A transmissão caiu / Tentar de novo" over a
 * stream that was still running perfectly.
 *
 * Deliberately narrow on two axes. Only a FRAGMENT/part load
 * (`isLlPartLoadErrorDetail`): a 404 on the master or on a level playlist is
 * the session genuinely being gone, and that one must still escalate. And
 * only a status that says "not here" -- a 500 is the Worker having a bad
 * moment on a part that still exists, which the retry budget above owns.
 */
export function isMissingFragmentError(input: {
  fatal: boolean;
  details: string;
  responseCode?: number | null;
}): boolean {
  return (
    input.fatal &&
    isLlPartLoadErrorDetail(input.details) &&
    typeof input.responseCode === "number" &&
    MISSING_FRAGMENT_STATUSES.has(input.responseCode)
  );
}

/**
 * How many live-edge jumps one attach may make, and over what window.
 *
 * BOUNDED, because "jump to live and carry on" is only a recovery while the
 * thing it recovers from is transient. A stream whose parts keep 404ing at
 * the edge is not a viewer who fell behind, and jumping forever would trade
 * a holding screen that says what happened for a silent loop that says
 * nothing -- pitfall 16's lesson, one layer up. Past the budget the error
 * goes back to the stall watchdog's own ladder exactly as it did before,
 * which is what eventually reaches "A transmissão caiu" and a retry button.
 */
export const LL_HLS_EDGE_JUMP_MAX = 2;
export const LL_HLS_EDGE_JUMP_WINDOW_MS = 30_000;

/**
 * Whether another live-edge jump is inside the budget. `timestampsMs` is
 * every jump this attach has already made, ascending; the caller appends
 * only when this says yes.
 */
export function canJumpToLiveEdge(
  timestampsMs: readonly number[],
  now: number,
  windowMs: number = LL_HLS_EDGE_JUMP_WINDOW_MS,
  max: number = LL_HLS_EDGE_JUMP_MAX,
): boolean {
  return timestampsMs.filter((at) => now - at < windowMs).length < max;
}

/**
 * How long after an attach the watchdog's SOFT rules stay quiet on LL.
 *
 * A player in the first seconds of an LL stream is doing exactly what a
 * stalled one looks like: waiting for a manifest the edge may still be
 * answering `503 Retry-After: 1` for (`LL_HLS_MANIFEST_RETRY_COUNT` buys it
 * eleven seconds of that), then filling a six-second buffer from 500 ms
 * parts. `LL_HLS_PART_STUCK_PARTS` is two seconds at that target, so the
 * part rule could fire its nudge -- a `startLoad`, i.e. a reset of the load
 * that was going fine -- before the first part had ever arrived. That is the
 * "struggles until it settles" half the client owns.
 *
 * Six seconds, which is the LL forward buffer plus a part: past that, a
 * player with no picture has a real problem. Only the soft rules are
 * suppressed -- a genuine fatal error still escalates on the tick it
 * arrives, because a source that is gone at second two is gone.
 */
export const LL_HLS_STARTUP_GRACE_MS = 6_000;

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
export function reloadHlsLevelPlaylist(
  hls: HlsRecoveryHandle,
  startPosition: number | null = null,
): void {
  const level = hls.currentLevel;
  hls.stopLoad?.();
  hls.currentLevel = -1;
  if (level >= 0) {
    hls.currentLevel = level;
  }
  hls.startLoad?.(recoveryStartPosition(startPosition));
}

/**
 * `-1` IS NOT "THE LIVE EDGE", AND THAT COST AN LL PARTY.
 *
 * Every step of the ladder used to call `startLoad(-1)` on the strength of
 * the name. Verified against `hls.mjs` 1.7.2, `StreamController.startLoad`
 * does this instead:
 *
 *   if (lastCurrentTime > 0 && startPosition === -1 && ...) {
 *     this.log(`Override startPosition with lastCurrentTime @...`);
 *     startPosition = lastCurrentTime;
 *   }
 *
 * so `-1` means "resume where the playhead was", and only means the live
 * edge on a player that never played. On a conventional stream that is
 * harmless: the playhead is inside a 60 s window and the recovery is over in
 * one segment. On LL it is the bug. The remux keeps parts for the newest
 * three segments (~12 s), so a playhead frozen by an error for even half a
 * minute names a part that left the ring long ago; hls.js asks for it, the
 * edge Worker answers 404, and a 404 is the one status hls.js never retries
 * (`retryForHttpStatus`: no 4xx). Production, 2026-09-15 21:37:47 and again
 * at 21:40:59: `ll/part-699.m4s` requested with the edge at part ~1,400 and
 * ~1,600, both times straight to a fatal network error and "A transmissão
 * caiu".
 *
 * So a live recovery passes the live edge it is about to seek the element to
 * (`liveSeekTarget`), and the loader and the element agree instead of the
 * loader firing one doomed request at the old position first. `null` (VOD,
 * or no live edge known yet) keeps the old `-1`, which is what a replay
 * wants: resume where you were.
 */
function recoveryStartPosition(startPosition: number | null | undefined): number {
  return typeof startPosition === "number" &&
    Number.isFinite(startPosition) &&
    startPosition >= 0
    ? startPosition
    : -1;
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
  startPosition: number | null = null,
): void {
  if (!hls) {
    return;
  }
  const from = recoveryStartPosition(startPosition);
  switch (decision) {
    case "recover-media-error":
      hls.recoverMediaError?.();
      return;
    case "start-load":
      hls.startLoad?.(from);
      return;
    case "restart-load":
      hls.stopLoad?.();
      hls.startLoad?.(from);
      return;
    case "reload-level":
      reloadHlsLevelPlaylist(hls, startPosition);
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
