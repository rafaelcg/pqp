/**
 * THE LL PLAYER'S DELIVERY AND LATENCY GOVERNOR: whether an LL viewer loads
 * parts or whole segments, and how far behind the live edge it sits.
 *
 * WHY THIS EXISTS (2026-09-21 party, ~80 sampled viewer sessions, and the lab
 * rig in `tools/ll-loss-harness`: the real remux, the real Worker playlist,
 * the real player in headless Chromium behind jittery links). The web LL
 * player loaded 500 ms parts and sat 3 s behind the edge with a 6 s buffer.
 * On a clean link that is perfect; on the audience we have (Brazilian
 * residential and mobile uplinks, served through seventeen Cloudflare colos,
 * MIA, LIS, LHR and BOS among them) it froze several times a minute. Two
 * separate mechanisms, both measured:
 *
 * - HOLES. Under ordinary jitter hls.js skips audio parts: the remux stamps
 *   each rendition's `#EXT-X-PROGRAM-DATE-TIME` from the wall clock the part
 *   ARRIVED at, so the audio playlist's PDT sits ~1.5 s away from the video
 *   playlist's for the same media time, hls.js aligns the audio timeline by
 *   PDT, and every time its part chain breaks (a late part, a segment
 *   boundary) it resumes ~1.5 s too far ahead. The gap controller then seeks
 *   over the hole: a `waiting`, a jump, and a second of latency lost for good.
 *   Rewriting the PDTs from the media's own timestamps removed it in the lab
 *   (mobile: 33 stalls a minute to 0.3); that fix belongs in the remux.
 * - STARVATION. A 3 s cushion is one late part away from empty.
 *
 * Loading WHOLE segments from the same LL playlist (`lowLatencyMode: false`)
 * sidesteps both, today, at ~8-10 s of latency: in the lab it was the one
 * configuration that held every profile, bad Wi-Fi included. So that is the
 * web default ("LL-lite", `delivery: "segments"`). Parts stay available
 * behind an opt-in (`LL_PARTS_OPT_IN_KEY`) for measuring the remux fix, and a
 * parts viewer that cannot hold them is moved to segments in place.
 *
 * The rules, all of them "smooth beats fast":
 *
 * 1. START WITH HEADROOM: `LL_SEGMENTS_TARGET_SECONDS` in segments mode,
 *    never under `LL_PARTS_MIN_TARGET_SECONDS` in parts mode, whatever the
 *    manifest's `PART-HOLD-BACK` says.
 * 2. A STALL BUYS PERMANENT ROOM, GIVEN BACK SLOWLY. Each stall episode after
 *    startup raises the target by `LL_TARGET_STEP_SECONDS` (the stall itself
 *    already moved the playhead back; raising the target is what stops the
 *    catch-up from spending that cushion again). A minute with no stall
 *    gives back `LL_TARGET_DECAY_SECONDS`, never below where it started.
 * 3. PARTS THAT CANNOT BE HELD ARE DROPPED IN PLACE. Three stall episodes in
 *    a minute, or two part-load errors in ten seconds (§4's old pin rule),
 *    switch a parts viewer to segments with `hls.lowLatencyMode = false`: no
 *    rebuild, no new instance, no buffer thrown away. The old pin rebuilt the
 *    player at the conventional path's ~25 s cushion to get the same effect.
 *
 * Pure: no hls.js import, no timers, the caller passes `now` and applies
 * what `state()` returns (`hls.targetLatency`, the force-seek ceiling,
 * `hls.lowLatencyMode`).
 */

export type LlDelivery = "parts" | "segments";

/**
 * `localStorage` key that opts this browser into LL part loading ("1").
 * Anything else, or no storage at all, is the segments default.
 */
export const LL_PARTS_OPT_IN_KEY = "pqp:ll-parts";

/** Where a segments viewer starts: ~two 4 s segments behind the edge. */
export const LL_SEGMENTS_TARGET_SECONDS = 8;
/** Never closer to the edge than this in parts mode, whatever the manifest says. */
export const LL_PARTS_MIN_TARGET_SECONDS = 5;
/** How much a stall episode raises the target. */
export const LL_TARGET_STEP_SECONDS = 1;
/**
 * The most a stall-driven target can reach. Well inside the remux ring
 * (six segments, 24 s or more), so the target is always still listed.
 */
export const LL_TARGET_MAX_SECONDS = 14;
/** Given back after `LL_TARGET_DECAY_AFTER_MS` of clean playback. */
export const LL_TARGET_DECAY_SECONDS = 0.5;
export const LL_TARGET_DECAY_AFTER_MS = 60_000;
/**
 * The force-seek ceiling (`liveMaxLatencyDuration`) sits this far above the
 * target. Past it hls.js seeks FORWARD to the sync point, which empties the
 * very buffer the cushion is made of, so it stays well clear.
 */
export const LL_CEILING_HEADROOM_SECONDS = 6;

/**
 * Stall episodes inside `LL_DEGRADE_WINDOW_MS` that mean this link cannot
 * hold parts. Three, not two: one stall is weather, two can be one bad
 * moment split by a nudge, three in a minute is the link.
 */
export const LL_DEGRADE_STALLS = 3;
export const LL_DEGRADE_WINDOW_MS = 60_000;
/** Part-load errors inside `LL_DEGRADE_PART_ERROR_WINDOW_MS` that mean the same. */
export const LL_DEGRADE_PART_ERRORS = 2;
export const LL_DEGRADE_PART_ERROR_WINDOW_MS = 10_000;

export interface LlLatencyState {
  delivery: LlDelivery;
  /** Where hls.js should hold the playhead, seconds behind the edge. */
  targetSeconds: number;
  /** `liveMaxLatencyDuration`: past this hls.js seeks to the sync point. */
  ceilingSeconds: number;
}

/**
 * Whether this browser opted into LL part loading. Never throws: storage can
 * be absent, blocked or throwing (a private window, an embedded webview).
 */
export function llPartsOptedIn(
  storage: Pick<Storage, "getItem"> | null | undefined = browserStorage(),
): boolean {
  try {
    return storage?.getItem(LL_PARTS_OPT_IN_KEY) === "1";
  } catch {
    return false;
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export class LlLatencyGovernor {
  private delivery: LlDelivery;
  private floorSeconds: number;
  private targetSeconds: number;
  private stallTimes: number[] = [];
  private partErrorTimes: number[] = [];
  private lastEventAt: number;

  constructor(input: { delivery: LlDelivery; now: number }) {
    this.delivery = input.delivery;
    this.floorSeconds =
      input.delivery === "parts"
        ? LL_PARTS_MIN_TARGET_SECONDS
        : LL_SEGMENTS_TARGET_SECONDS;
    this.targetSeconds = this.floorSeconds;
    this.lastEventAt = input.now;
  }

  /**
   * What the manifest said about its own hold-back (hls.js's
   * `LevelDetails.partHoldBack`). Parts mode obeys a manifest that asks for
   * MORE than the floor and ignores one that asks for less; segments mode
   * has its own floor and ignores it entirely.
   */
  onManifest(input: { partHoldBackSeconds?: number | null }): void {
    const phb = input.partHoldBackSeconds;
    if (
      this.delivery !== "parts" ||
      typeof phb !== "number" ||
      !Number.isFinite(phb) ||
      phb <= this.floorSeconds
    ) {
      return;
    }
    this.floorSeconds = Math.min(LL_TARGET_MAX_SECONDS, phb);
    this.targetSeconds = Math.max(this.targetSeconds, this.floorSeconds);
  }

  /**
   * One stall episode (a `waiting` that was not already inside one) AFTER
   * startup: the caller never reports the attach's own first buffering.
   * Returns true when this stall is the one that moves parts to segments.
   */
  onStall(now: number): boolean {
    this.lastEventAt = now;
    this.stallTimes = this.stallTimes.filter(
      (at) => now - at < LL_DEGRADE_WINDOW_MS,
    );
    this.stallTimes.push(now);
    this.targetSeconds = Math.min(
      LL_TARGET_MAX_SECONDS,
      this.targetSeconds + LL_TARGET_STEP_SECONDS,
    );
    if (
      this.delivery === "parts" &&
      this.stallTimes.length >= LL_DEGRADE_STALLS
    ) {
      this.toSegments();
      return true;
    }
    return false;
  }

  /**
   * A part failed to load (`isLlPartLoadErrorDetail`). Two inside ten
   * seconds moves parts to segments. Returns true when this error does.
   */
  onPartLoadError(now: number): boolean {
    this.partErrorTimes = this.partErrorTimes.filter(
      (at) => now - at <= LL_DEGRADE_PART_ERROR_WINDOW_MS,
    );
    this.partErrorTimes.push(now);
    if (
      this.delivery === "parts" &&
      this.partErrorTimes.length >= LL_DEGRADE_PART_ERRORS
    ) {
      this.toSegments();
      return true;
    }
    return false;
  }

  /** The slow give-back while healthy. Call on the watchdog's tick. */
  tick(now: number): void {
    if (now - this.lastEventAt < LL_TARGET_DECAY_AFTER_MS) {
      return;
    }
    this.lastEventAt = now;
    this.targetSeconds = Math.max(
      this.floorSeconds,
      this.targetSeconds - LL_TARGET_DECAY_SECONDS,
    );
  }

  state(): LlLatencyState {
    return {
      delivery: this.delivery,
      targetSeconds: round3(this.targetSeconds),
      ceilingSeconds: round3(this.targetSeconds + LL_CEILING_HEADROOM_SECONDS),
    };
  }

  private toSegments(): void {
    this.delivery = "segments";
    this.floorSeconds = Math.max(this.floorSeconds, LL_SEGMENTS_TARGET_SECONDS);
    this.targetSeconds = Math.max(this.targetSeconds, this.floorSeconds);
  }
}

/**
 * LL-lite's own rate controller, both directions, because hls.js runs none at
 * all once `lowLatencyMode` is off.
 *
 * GIVING ROOM, NOT ONLY TAKING IT (lab, 2026-09-23). On whole segments the
 * latency is fixed where the attach synced, and a short stall adds only its
 * own length: the governor raised its target after each stall and the
 * viewer stayed exactly as close to the edge as before, stalling again on
 * the next late segment. So when the viewer sits more than half a second
 * closer than the target, playback runs at 0.95x (tempo only: browsers keep
 * the pitch by default) until the cushion is there. The other way it is
 * 1.05x, only past a full second behind and only with buffer to spare, so
 * the catch-up can never be what empties it.
 */
export const LL_SEGMENTS_CATCH_UP_RATE = 1.05;
export const LL_SEGMENTS_SLOW_DOWN_RATE = 0.95;
export const LL_SEGMENTS_CATCH_UP_MIN_BUFFER_SECONDS = 4;

export function llSegmentsCatchUpRate(input: {
  latencySeconds: number | null | undefined;
  targetSeconds: number | null | undefined;
  bufferAheadSeconds: number;
}): number {
  const { latencySeconds, targetSeconds, bufferAheadSeconds } = input;
  if (
    typeof latencySeconds !== "number" ||
    typeof targetSeconds !== "number" ||
    !Number.isFinite(latencySeconds) ||
    !Number.isFinite(targetSeconds) ||
    latencySeconds <= 0
  ) {
    return 1;
  }
  if (latencySeconds < targetSeconds - 0.5) {
    return LL_SEGMENTS_SLOW_DOWN_RATE;
  }
  if (
    latencySeconds - targetSeconds > 1 &&
    bufferAheadSeconds >= LL_SEGMENTS_CATCH_UP_MIN_BUFFER_SECONDS
  ) {
    return LL_SEGMENTS_CATCH_UP_RATE;
  }
  return 1;
}

function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
