/**
 * Getting a watch-party share back to full size after Chrome's encoder
 * adaptation has wedged it at the floor.
 *
 * WHAT HAPPENS, measured in a real Chromium against a real LiveKit with
 * WebRTC verbose logging (2026-09-25, reproducing production rehearsal F):
 *
 *   1. A fresh peer connection (every presenter reload) starts its bandwidth
 *      estimate at ~300 kbit/s. The share goes up under `maintain-framerate`,
 *      and the quality scaler's initial frame dropper walks the resolution
 *      down one notch per dropped frame. Each renegotiation (the camera going
 *      up, a layer trim) re-arms it ("Resetting initial_framedrop_ due to
 *      changed stream parameters"), so it can walk four notches, 1120x720 to
 *      280x180, in a few hundred milliseconds.
 *   2. For a display capture Chrome applies that restriction AT THE CAPTURER:
 *      `getSettings()` on the screen track itself reports 280x180, and the
 *      frames WebRTC receives are already that size.
 *   3. The quality scaler then sees a low QP and asks for one notch up
 *      ("Scaling up resolution, max pixels: 201600 target_pixels_per_frame=
 *      84000 ... Adapted up successfully"). The capturer does not deliver a
 *      larger frame for that request, and libwebrtc's `VideoStreamAdapter`
 *      will not adapt again until one arrives: every later upscale answers
 *      "Not adapting up because VideoStreamAdapter returned
 *      kAwaitingPreviousAdaptation", for the rest of the share.
 *
 * Nothing in the page ever asked for 280x180 and nothing in the page can see
 * the wait, so production watched it for the whole second half of the show.
 *
 * WHAT GETS IT OUT. Changing the sender's `degradationPreference` to
 * `balanced` and straight back clears the adapter's restrictions (libwebrtc
 * `VideoStreamAdapter::SetDegradationPreference` calls `ClearRestrictions()`
 * on any switch into or out of balanced), so the capture returns to its own
 * size at once, and the quality scaler starts over from there. Measured: the
 * wedged 280x180 share was 1400x900 two seconds after the toggle.
 *
 * WHY NOT `maintain-resolution`, which would never walk down in the first
 * place: PR 668 measured what it costs. Under a real uplink dip it held the
 * pixels and let the frame rate collapse to 1-3 fps, and every viewer stalled.
 * A share that drops resolution under real pressure is right; one that stays
 * dropped after the pressure is gone is the bug, and that is all this undoes.
 *
 * WHEN IT KICKS, and every clause is there so it never fights a real squeeze:
 *   - the top layer is encoding at 80% of its intended height or less (one
 *     adaptation notch is 75%);
 *   - Chrome says bandwidth is what limits it (not CPU: a starved CPU is a
 *     real reason to stay small);
 *   - the encoder is NOT spending its own budget (sent under 80% of its
 *     target). A share squeezed by a real uplink spends every bit it is
 *     given; the wedged one had 891 kbit/s granted and sent 390;
 *   - it has held that way, without climbing on its own, for
 *     `SCREEN_RESOLUTION_STUCK_MS`;
 *   - and the last kick was long enough ago (`nextKickDelayMs`), so a link
 *     that genuinely cannot carry the full size costs at most one brief
 *     attempt a minute.
 */

/** One reading of the share's top layer, off the sender's own getStats(). */
export interface ScreenEncodeSample {
  /** `performance.now()`-style clock, ms. */
  at: number;
  /** `outbound-rtp.frameHeight` of the top layer, if it is encoding. */
  frameHeight: number | null;
  /** `outbound-rtp.targetBitrate`, bit/s. */
  targetBitrate: number | null;
  /** `outbound-rtp.bytesSent`, cumulative. */
  bytesSent: number | null;
  /** `outbound-rtp.qualityLimitationReason`. */
  qualityLimitationReason: string | null;
}

export interface ScreenResolutionRecoveryState {
  /** The previous sample, for the send rate and "is it climbing". */
  last: ScreenEncodeSample | null;
  /** When the share was first seen wedged in the current run, or null. */
  stuckSince: number | null;
  /** The height it was wedged at when `stuckSince` was set. */
  stuckHeight: number | null;
  /** Kicks since the share was last healthy for `SCREEN_RESOLUTION_HEALTHY_MS`. */
  kicks: number;
  lastKickAt: number | null;
  /** When the share was last seen at (or near) its intended size. */
  healthySince: number | null;
}

/**
 * At or under this share of the intended height counts as reduced. One
 * adaptation notch is 3/4 of the height, so a share wedged a single notch
 * down (the local rig's go-live: 980x630 under a 1400x900 capture, the next notch
 * refused by libwebrtc's BitrateConstraint while the bandwidth estimate sat
 * in the application-limited trap) is caught too.
 */
export const SCREEN_RESOLUTION_STUCK_FRACTION = 0.8;
export const SCREEN_RESOLUTION_STUCK_MS = 6_000;
export const SCREEN_RESOLUTION_HEADROOM = 0.8;
/** Healthy this long and the backoff starts over. */
export const SCREEN_RESOLUTION_HEALTHY_MS = 60_000;
const KICK_BACKOFF_MS = [0, 15_000, 30_000, 60_000] as const;

export function initialScreenResolutionRecovery(): ScreenResolutionRecoveryState {
  return {
    last: null,
    stuckSince: null,
    stuckHeight: null,
    kicks: 0,
    lastKickAt: null,
    healthySince: null,
  };
}

/** Minimum wait after the `kicks`-th kick before another one. */
export function nextKickDelayMs(kicks: number): number {
  return KICK_BACKOFF_MS[Math.min(kicks, KICK_BACKOFF_MS.length - 1)]!;
}

export interface ScreenResolutionDecision {
  state: ScreenResolutionRecoveryState;
  kick: boolean;
  /** Why not, or why; for the console line and the tests. */
  reason:
    | "no-reading"
    | "healthy"
    | "not-bandwidth"
    | "spending-budget"
    | "climbing"
    | "holding"
    | "backoff"
    | "kick";
}

/**
 * Feed one sample; get back the next state and whether to kick now.
 *
 * `intendedHeight` is the height the top layer is meant to encode at: the
 * capture's own height under the plan's ceiling. Null means "unknown", and an
 * unknown target never kicks.
 */
export function decideScreenResolutionRecovery(
  state: ScreenResolutionRecoveryState,
  sample: ScreenEncodeSample,
  intendedHeight: number | null,
): ScreenResolutionDecision {
  const last = state.last;
  const base = { ...state, last: sample };
  const height = sample.frameHeight;
  if (
    height === null ||
    height <= 0 ||
    intendedHeight === null ||
    intendedHeight <= 0
  ) {
    return {
      state: { ...base, stuckSince: null, stuckHeight: null },
      kick: false,
      reason: "no-reading",
    };
  }
  if (height > intendedHeight * SCREEN_RESOLUTION_STUCK_FRACTION) {
    const healthySince = state.healthySince ?? sample.at;
    const settled = sample.at - healthySince >= SCREEN_RESOLUTION_HEALTHY_MS;
    return {
      state: {
        ...base,
        stuckSince: null,
        stuckHeight: null,
        healthySince,
        kicks: settled ? 0 : state.kicks,
      },
      kick: false,
      reason: "healthy",
    };
  }
  const notHealthy = { ...base, healthySince: null };
  if (sample.qualityLimitationReason !== "bandwidth") {
    return {
      state: { ...notHealthy, stuckSince: null, stuckHeight: null },
      kick: false,
      reason: "not-bandwidth",
    };
  }
  const sentBps =
    last !== null &&
    last.bytesSent !== null &&
    sample.bytesSent !== null &&
    sample.at > last.at &&
    sample.bytesSent >= last.bytesSent
      ? ((sample.bytesSent - last.bytesSent) * 8 * 1000) / (sample.at - last.at)
      : null;
  if (
    sentBps === null ||
    sample.targetBitrate === null ||
    sample.targetBitrate <= 0 ||
    sentBps >= sample.targetBitrate * SCREEN_RESOLUTION_HEADROOM
  ) {
    // Unmeasured, or genuinely using what it is given: a real squeeze.
    return {
      state: { ...notHealthy, stuckSince: null, stuckHeight: null },
      kick: false,
      reason: "spending-budget",
    };
  }
  if (state.stuckHeight !== null && height > state.stuckHeight) {
    // Coming back by itself. Start the clock over at the new height.
    return {
      state: { ...notHealthy, stuckSince: sample.at, stuckHeight: height },
      kick: false,
      reason: "climbing",
    };
  }
  const stuckSince = state.stuckSince ?? sample.at;
  const stuckHeight = state.stuckHeight ?? height;
  const held = { ...notHealthy, stuckSince, stuckHeight };
  if (sample.at - stuckSince < SCREEN_RESOLUTION_STUCK_MS) {
    return { state: held, kick: false, reason: "holding" };
  }
  if (
    state.lastKickAt !== null &&
    sample.at - state.lastKickAt < nextKickDelayMs(state.kicks)
  ) {
    return { state: held, kick: false, reason: "backoff" };
  }
  return {
    state: {
      ...notHealthy,
      stuckSince: null,
      stuckHeight: null,
      kicks: state.kicks + 1,
      lastKickAt: sample.at,
    },
    kick: true,
    reason: "kick",
  };
}

/**
 * How many refused kicks in a row are handed back before one is allowed to
 * cost its backoff. A browser that refuses the toggle every time must not be
 * asked on every 2 s tick for the rest of the party.
 */
export const SCREEN_RESOLUTION_REFUND_LIMIT = 2;

/**
 * A kick whose writes the browser refused did not happen. Give it back: the
 * state from before the kick, with the newer sample kept so the send rate
 * stays measured, so the next tick may try again instead of leaving the
 * share wedged for a backoff interval it never earned (Farol on PR 829).
 * `refundsInARow` past `SCREEN_RESOLUTION_REFUND_LIMIT` keeps the attempt,
 * backoff and all.
 */
export function refundScreenResolutionKick(
  before: ScreenResolutionRecoveryState,
  attempted: ScreenResolutionRecoveryState,
  refundsInARow: number,
): ScreenResolutionRecoveryState {
  if (refundsInARow > SCREEN_RESOLUTION_REFUND_LIMIT) {
    return attempted;
  }
  return { ...before, last: attempted.last };
}

/** The outbound-rtp fields this module reads, as `getStats()` reports them. */
interface OutboundVideoLike {
  type?: string;
  kind?: string;
  rid?: string;
  frameHeight?: number;
  targetBitrate?: number;
  bytesSent?: number;
  qualityLimitationReason?: string;
}

/**
 * The top layer's reading out of a sender's `getStats()` report.
 *
 * The top layer is the encoding the egress and the remux take: `topRid` is
 * the rid of the sender's LAST encoding (livekit-client orders them smallest
 * first), undefined for a single-encoding share.
 */
export function readScreenEncodeSample(
  report: Iterable<unknown>,
  topRid: string | undefined,
  at: number,
): ScreenEncodeSample | null {
  for (const entry of report) {
    const stat = (Array.isArray(entry) ? entry[1] : entry) as OutboundVideoLike;
    if (stat?.type !== "outbound-rtp" || stat.kind !== "video") {
      continue;
    }
    if ((stat.rid || undefined) !== (topRid || undefined)) {
      continue;
    }
    return {
      at,
      frameHeight:
        typeof stat.frameHeight === "number" ? stat.frameHeight : null,
      targetBitrate:
        typeof stat.targetBitrate === "number" ? stat.targetBitrate : null,
      bytesSent: typeof stat.bytesSent === "number" ? stat.bytesSent : null,
      qualityLimitationReason: stat.qualityLimitationReason ?? null,
    };
  }
  return null;
}
