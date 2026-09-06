/**
 * One number a tile can show: how this path is doing, in three bars.
 *
 * WHY THIS EXISTS. `getStats()` already knew RTT, loss and whether the
 * nominated pair was a TURN relay. Nobody could see any of that: the only
 * chip on screen said "connected", and a broken call looked identical to a
 * healthy one. This file is the translation. The probe keeps measuring; this
 * turns one sample into the same shape the tiles and the status bar both
 * read, so mesh and SFU cannot disagree about what "two bars" means.
 *
 * Relayed is a badge, not a fourth bar. A TURN path can still be excellent.
 * The badge is the thing a person can act on ("this call is going through a
 * relay"), and mixing it into the bars would hide that.
 */

import type { VoiceStatsSnapshot } from "./voice-stats-probe";

/** How many of the three bars are lit. 1 is the worst that still has a path. */
export type VoiceQualityBars = 1 | 2 | 3;

/**
 * LiveKit's `ConnectionQuality` names, spelled as the library emits them.
 *
 * Kept as a string union so the mapper can be tested without constructing a
 * Room. `unknown` and `lost` are real values the client sends; they still
 * have to land on the same three bars.
 */
export type LiveKitConnectionQuality =
  | "excellent"
  | "good"
  | "poor"
  | "lost"
  | "unknown";

export interface VoiceLinkQuality {
  bars: VoiceQualityBars;
  relayed: boolean;
  rttMs: number | null;
  /** 0–100. Null when the sample has no inbound packets to divide. */
  lossPct: number | null;
  /**
   * No reading yet. The meter must stay quiet: not red, not "bad", and not
   * three green bars that look like Excellent.
   */
  unknown: boolean;
}

/** RTT above this is no longer a clean path. Discord's "good" band is nearby. */
const RTT_GOOD_MS = 150;
/** RTT above this is the bottom bar. */
const RTT_OK_MS = 300;
/** Loss below this stays on three bars. */
const LOSS_GOOD_PCT = 2;
/** Loss below this stays on two bars. */
const LOSS_OK_PCT = 8;

function lossPctFromCounts(
  packetsLost: number | null,
  packetsReceived: number | null,
): number | null {
  if (packetsLost === null) {
    return null;
  }
  const received = packetsReceived ?? 0;
  const total = packetsLost + received;
  if (total <= 0) {
    // 0/0 is the first second of a call, not a measured 0% loss.
    return packetsLost > 0 ? 100 : null;
  }
  return (packetsLost / total) * 100;
}

function barsFromRtt(rttMs: number): VoiceQualityBars {
  if (rttMs < RTT_GOOD_MS) {
    return 3;
  }
  if (rttMs < RTT_OK_MS) {
    return 2;
  }
  return 1;
}

function barsFromLoss(lossPct: number): VoiceQualityBars {
  if (lossPct < LOSS_GOOD_PCT) {
    return 3;
  }
  if (lossPct < LOSS_OK_PCT) {
    return 2;
  }
  return 1;
}

function worse(a: VoiceQualityBars, b: VoiceQualityBars): VoiceQualityBars {
  return a < b ? a : b;
}

/**
 * Bars from one mesh sample: RTT, loss, and whether the pair is a relay.
 *
 * Relayed is recorded, not scored. A fibre call through TURN still lights
 * three bars; the badge next to them is what says the path is the expensive
 * one. Scoring it would make every relayed call look sick, which is how
 * people end up resetting a router that was never the problem.
 *
 * Missing numbers do not vote. A sample with RTT and no loss is scored on
 * RTT alone. A sample with nothing yet (the first second of a call) is
 * unknown, not three green bars: "we have a nominated pair" is not a
 * measurement, and it is also not a fault.
 */
export function qualityFromMesh(input: {
  rttMs: number | null;
  packetsLost?: number | null;
  packetsReceived?: number | null;
  lossPct?: number | null;
  relayed: boolean;
}): VoiceLinkQuality {
  const lossPct =
    input.lossPct ??
    lossPctFromCounts(input.packetsLost ?? null, input.packetsReceived ?? null);
  const unknown = input.rttMs === null && lossPct === null;
  let bars: VoiceQualityBars = 3;
  if (input.rttMs !== null) {
    bars = worse(bars, barsFromRtt(input.rttMs));
  }
  if (lossPct !== null) {
    bars = worse(bars, barsFromLoss(lossPct));
  }
  return {
    bars,
    relayed: input.relayed,
    rttMs: input.rttMs,
    lossPct,
    unknown,
  };
}

/**
 * LiveKit's Excellent / Good / Poor onto the same three bars.
 *
 * `lost` is a path that is still in the room but not carrying media, so it
 * is the bottom bar rather than a hidden tile. `unknown` is "no reading
 * yet": same three-bar slot as Excellent so a later event can fill it, but
 * flagged so the meter does not paint it as a healthy call.
 */
export function qualityFromLiveKit(
  quality: LiveKitConnectionQuality,
  extra?: { relayed?: boolean; rttMs?: number | null; lossPct?: number | null },
): VoiceLinkQuality {
  const unknown = quality === "unknown";
  const bars: VoiceQualityBars =
    quality === "excellent" || unknown
      ? 3
      : quality === "good"
        ? 2
        : 1;
  return {
    bars,
    relayed: extra?.relayed ?? false,
    rttMs: extra?.rttMs ?? null,
    lossPct: extra?.lossPct ?? null,
    unknown,
  };
}

/**
 * One quality row per remote peer in a probe snapshot.
 *
 * A mesh connection is one peer, so the selected path and the inbound
 * counters belong to the same person. Several paths for the same peer
 * (two transports, a restart) keep the worst bars and any relayed flag.
 */
export function qualityByPeerFromSnapshot(
  snapshot: VoiceStatsSnapshot,
): Record<string, VoiceLinkQuality> {
  const byPeer: Record<string, VoiceLinkQuality> = {};
  for (const path of snapshot.paths) {
    const next = qualityFromMesh({
      rttMs: path.rttMs,
      packetsLost: path.packetsLost,
      packetsReceived: path.packetsReceived,
      relayed: path.relayed,
    });
    const prev = byPeer[path.peerId];
    byPeer[path.peerId] = prev ? mergeQuality(prev, next) : next;
  }
  return byPeer;
}

/** Worst bars, Relayed if either side is, freshest numbers that exist. */
export function mergeQuality(
  a: VoiceLinkQuality,
  b: VoiceLinkQuality,
): VoiceLinkQuality {
  return {
    bars: worse(a.bars, b.bars),
    relayed: a.relayed || b.relayed,
    rttMs: b.rttMs ?? a.rttMs,
    lossPct: b.lossPct ?? a.lossPct,
    unknown: a.unknown && b.unknown,
  };
}

/**
 * The status-bar reading: the worst remote path, and Relayed if any is.
 *
 * An empty list is "nobody else is on the call yet", not a broken path.
 */
export function aggregateQuality(
  qualities: Iterable<VoiceLinkQuality>,
): VoiceLinkQuality | null {
  let result: VoiceLinkQuality | null = null;
  for (const quality of qualities) {
    result = result ? mergeQuality(result, quality) : quality;
  }
  return result;
}

/**
 * What the tile and the status bar actually draw.
 *
 * Unknown is quiet: no bars, no alarm. Relayed is a chip even before the
 * numbers arrive, because the nominated pair is already a fact.
 */
export function qualityMeterView(
  quality: VoiceLinkQuality | null,
): { showBars: boolean; showRelayed: boolean } | null {
  if (!quality) {
    return null;
  }
  const showBars = !quality.unknown;
  const showRelayed = quality.relayed;
  if (!showBars && !showRelayed) {
    return null;
  }
  return { showBars, showRelayed };
}
