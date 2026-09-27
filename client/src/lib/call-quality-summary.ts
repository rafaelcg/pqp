import type { MediaQualitySummary } from "@pqp/shared";
import type { VoiceStatsSnapshot } from "./voice-stats-probe";
import { isLiveReceiver } from "@/components/voice/inbound-video-rows";

/**
 * Turns the sampler both quality readouts already poll (`sampleVoiceStats()`
 * in `voice-stats-probe.ts`) into the compact `mediaQuality` object a call
 * rating carries.
 *
 * WHY A SEPARATE ACCUMULATOR RATHER THAN READING ONE LAST SNAPSHOT AT THE
 * END. By the time a call ends and the rating prompt would ask, every
 * `RTCPeerConnection` is closed and `sampleVoiceStats()` has nothing left to
 * read -- same reason `call-rating.ts` folds `peerCount` and
 * `hadScreenShare` into a running `CallProgress` while the call is live
 * rather than reading them off at the end. This module is that pattern's
 * counterpart for media quality: samples are folded in on every tick
 * (`sampleQuality`), and only `finishQuality` turns the run into the handful
 * of numbers that leave the machine.
 *
 * NO NEW MEASUREMENT. Every field here is read off `VoiceStatsSnapshot`,
 * which `voice-stats-probe.ts` already produces every two seconds for the
 * outbound and inbound quality readouts, on both transports. This module
 * adds no poller of its own -- a caller samples once per tick and hands the
 * same snapshot to whichever consumers want it.
 *
 * MEDIAN AND P10, NOT THE RAW SAMPLES. See the doc comment on
 * `mediaQualitySchema` in `@pqp/shared` for why: a median says how the share
 * usually looked, a tenth percentile says how bad the worst moments got, and
 * neither requires shipping an unbounded sample list off the machine.
 */

interface StreamSeries {
  fps: number[];
  height: number[];
}

function emptySeries(): StreamSeries {
  return { fps: [], height: [] };
}

function pushSample(series: StreamSeries, fps: number | null, height: number | null): void {
  if (fps !== null) {
    series.fps.push(fps);
  }
  if (height !== null) {
    series.height.push(height);
  }
}

/** Ascending-sorted median. Null on an empty series, never NaN. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The 10th percentile: the reading ninety percent of samples were at or
 * above. Nearest-rank rather than interpolated -- this is a diagnostic, not
 * a statistics package, and the extra precision would not change what an
 * operator does with it.
 *
 * `ceil(n * 0.1) - 1`, not `floor(n * 0.1)`. Nearest-rank defines the k-th
 * percentile as the `ceil(n * k)`-th smallest of n (1-indexed); `floor`
 * quietly skips the true worst reading whenever n is divisible by ten --
 * for ten samples it picked index 1 (the SECOND lowest) rather than index 0,
 * and for twenty it picked index 2 rather than 1, systematically reporting a
 * better-than-actual lower tail on exactly the sample counts a two-second
 * poll produces most often (a 20s, 40s, 60s... call).
 */
function p10(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.1) - 1);
  return sorted[index]!;
}

interface InboundCandidate extends StreamSeries {
  peerId: string;
  sampleCount: number;
  freezeCount: number | null;
  totalFreezesDuration: number | null;
  framesDropped: number | null;
}

export interface QualityAccumulator {
  outbound: StreamSeries;
  /** Latest reading wins: `qualityLimitationDurations` is already cumulative
   *  since the sender was created, so there is nothing to sum across ticks. */
  outboundLimitDurations: Record<string, number> | null;
  hasOutboundScreen: boolean;
  /** Keyed by peer id, so "the share watched most" can be picked at the end
   *  by sample count -- a proxy for time actually spent watching it, over a
   *  five-way call where several peers flashed a window briefly. */
  inbound: Map<string, InboundCandidate>;
  rtt: number[];
  relayedSamples: number;
  totalPathSamples: number;
  lossLost: number;
  lossReceived: number;
  reconnectCount: number;
}

export function createQualityAccumulator(): QualityAccumulator {
  return {
    outbound: emptySeries(),
    outboundLimitDurations: null,
    hasOutboundScreen: false,
    inbound: new Map(),
    rtt: [],
    relayedSamples: 0,
    totalPathSamples: 0,
    lossLost: 0,
    lossReceived: 0,
    reconnectCount: 0,
  };
}

/** Fold one `sampleVoiceStats()` tick into the running accumulator. Mutates
 *  in place, same convention `voice-stats-probe.ts`'s own byte marks use. */
export function sampleQuality(
  acc: QualityAccumulator,
  snapshot: VoiceStatsSnapshot,
): void {
  const outboundScreen = snapshot.senders.find((s) => s.role === "screen");
  if (outboundScreen) {
    acc.hasOutboundScreen = true;
    pushSample(acc.outbound, outboundScreen.fps, outboundScreen.height);
    if (outboundScreen.limitDurations) {
      acc.outboundLimitDurations = outboundScreen.limitDurations;
    }
  }

  for (const receiver of snapshot.receivers) {
    if (receiver.role !== "screen") {
      continue;
    }
    // A mesh `getStats()` report carries one `inbound-rtp` row per video
    // m-line whether or not anything is actually arriving on it -- the same
    // fact `isLiveReceiver` exists to filter for the readout. Without this,
    // an idle screen m-line (nobody sharing, or a share that ended) can win
    // "watched most" by sample count alone, or pull the chosen peer's rates
    // toward zero with readings that were never really there. An SFU row is
    // exempt the same way the readout exempts it: `attached: true` is the
    // server's own word that the picture is flowing, true from the first
    // sample before the decoder has reported anything.
    if (!isLiveReceiver(receiver)) {
      continue;
    }
    let candidate = acc.inbound.get(receiver.peerId);
    if (!candidate) {
      candidate = {
        peerId: receiver.peerId,
        sampleCount: 0,
        fps: [],
        height: [],
        freezeCount: null,
        totalFreezesDuration: null,
        framesDropped: null,
      };
      acc.inbound.set(receiver.peerId, candidate);
    }
    pushSample(candidate, receiver.fps, receiver.height);
    candidate.sampleCount += 1;
    // Lifetime counters: latest reading wins, same reasoning as
    // `outboundLimitDurations`.
    if (receiver.freezeCount !== null) {
      candidate.freezeCount = receiver.freezeCount;
    }
    if (receiver.totalFreezesDuration !== null) {
      candidate.totalFreezesDuration = receiver.totalFreezesDuration;
    }
    if (receiver.framesDropped !== null) {
      candidate.framesDropped = receiver.framesDropped;
    }
  }

  for (const path of snapshot.paths) {
    acc.totalPathSamples += 1;
    if (path.relayed) {
      acc.relayedSamples += 1;
    }
    if (path.rttMs !== null) {
      acc.rtt.push(path.rttMs);
    }
    if (path.packetsLost !== null && path.packetsReceived !== null) {
      acc.lossLost += path.packetsLost;
      acc.lossReceived += path.packetsReceived;
    }
  }
}

/**
 * `sampleQuality`, but dropped when it no longer belongs to the call it was
 * meant for.
 *
 * WHY A CALL "GENERATION" AT ALL. `subscribeVoiceStats` reading its
 * `listeners` set fresh at delivery time already keeps an UNSUBSCRIBED
 * caller from being handed a late sample -- but a call-rating accumulator is
 * reset and reused (`createQualityAccumulator()` starts a fresh one) rather
 * than reconstructed per call, and a subscription can, in principle, still
 * be live across the exact moment a call ends and a new one begins (a fast
 * hangup-and-rejoin inside one poll tick). Without a generation check, a
 * sample that was in flight for the OLD call would fold into the NEW call's
 * `QualityAccumulator`, understating or overstating a rating that has
 * nothing to do with what actually happened on it.
 *
 * `sampleGeneration` is the generation the caller captured when it started
 * listening for this call; `currentGeneration` is read live at the moment
 * this runs. A caller bumps its generation counter each time a fresh call
 * starts (see `useCallRating`), so a mismatch here means exactly one thing:
 * the call this sample was meant for is not the call in progress anymore.
 */
export function sampleQualityIfCurrent(
  acc: QualityAccumulator,
  snapshot: VoiceStatsSnapshot,
  sampleGeneration: number,
  currentGeneration: number,
): void {
  if (sampleGeneration !== currentGeneration) {
    return;
  }
  sampleQuality(acc, snapshot);
}

/** One more reconnect happened during this call. Callers drive this from
 *  whatever the transport already tracks (see `trackReconnects` below for
 *  the shared-across-transports version fed from `RemotePeer.connectionState`). */
export function noteReconnect(acc: QualityAccumulator): void {
  acc.reconnectCount += 1;
}

/**
 * `frameHeightFieldSchema` in `@pqp/shared` requires an integer -- a real
 * `getStats()` `frameHeight` always is one, but `median()` averages the two
 * middle readings on an even-sized sample and can land on a `.5`, which
 * would fail validation and lose the whole rating over one field. `p10`
 * always returns an original sampled value (nearest-rank, not interpolated),
 * so this is a no-op there in practice; rounding it too costs nothing and
 * keeps both height fields under the same rule rather than one being an
 * accident of how the other is computed.
 */
function roundHeight(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

function finishOutbound(
  acc: QualityAccumulator,
): MediaQualitySummary["outboundScreenShare"] {
  if (!acc.hasOutboundScreen) {
    return null;
  }
  const durations = acc.outboundLimitDurations;
  return {
    frameRateMedian: median(acc.outbound.fps),
    frameRateP10: p10(acc.outbound.fps),
    frameHeightMedian: roundHeight(median(acc.outbound.height)),
    frameHeightP10: roundHeight(p10(acc.outbound.height)),
    bandwidthLimitedSeconds: durations?.bandwidth ?? null,
    cpuLimitedSeconds: durations?.cpu ?? null,
  };
}

function finishInbound(
  acc: QualityAccumulator,
): MediaQualitySummary["inboundScreenShare"] {
  let best: InboundCandidate | null = null;
  for (const candidate of acc.inbound.values()) {
    if (!best || candidate.sampleCount > best.sampleCount) {
      best = candidate;
    }
  }
  if (!best) {
    return null;
  }
  return {
    frameRateMedian: median(best.fps),
    frameRateP10: p10(best.fps),
    frameHeightMedian: roundHeight(median(best.height)),
    frameHeightP10: roundHeight(p10(best.height)),
    freezeCount: best.freezeCount,
    freezeSeconds: best.totalFreezesDuration,
    framesDropped: best.framesDropped,
  };
}

/** Freeze the run into the compact object the rating carries. Pure -- does
 *  not mutate `acc`, so a caller that keeps sampling after showing the
 *  prompt (there is no reason to, but nothing here forbids it) is safe. */
export function finishQuality(acc: QualityAccumulator): MediaQualitySummary {
  const lossTotal = acc.lossLost + acc.lossReceived;
  return {
    outboundScreenShare: finishOutbound(acc),
    inboundScreenShare: finishInbound(acc),
    packetLossPercent:
      lossTotal > 0 ? Math.round((acc.lossLost / lossTotal) * 1000) / 10 : null,
    rttMsMedian: median(acc.rtt),
    relayed:
      acc.totalPathSamples > 0
        ? acc.relayedSamples / acc.totalPathSamples > 0.5
        : null,
    reconnectCount: acc.reconnectCount,
  };
}

/**
 * Reconnect counting shared across both transports, fed from
 * `RemotePeer.connectionState` -- the same field the roster and the tiles
 * already read, so this adds no instrumentation to either
 * `peer-connection-manager.ts` or `livekit-session.ts`.
 *
 * ONLY COUNTS A PEER THAT WAS ALREADY CONNECTED ONCE. A fresh peer joining
 * the room passes through "connecting" on its way to "connected" too, and
 * that is a join, not a reconnect; counting it would make "how many people
 * came and went" look identical to "how many times did the link drop".
 */
export interface ReconnectTracker {
  everConnected: Set<string>;
  currentlyDown: Set<string>;
  reconnectCount: number;
}

export function createReconnectTracker(): ReconnectTracker {
  return {
    everConnected: new Set(),
    currentlyDown: new Set(),
    reconnectCount: 0,
  };
}

export function trackReconnects(
  tracker: ReconnectTracker,
  peers: readonly { peerId: string; connectionState: string }[],
): void {
  for (const peer of peers) {
    if (peer.connectionState === "connected") {
      if (tracker.currentlyDown.has(peer.peerId)) {
        tracker.currentlyDown.delete(peer.peerId);
        tracker.reconnectCount += 1;
      }
      tracker.everConnected.add(peer.peerId);
    } else if (tracker.everConnected.has(peer.peerId)) {
      tracker.currentlyDown.add(peer.peerId);
    }
  }
}
