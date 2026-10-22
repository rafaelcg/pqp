import type { FeedbackVoiceLink } from "@pqp/shared";
import { isLiveReceiver } from "@/components/voice/inbound-video-rows";
import type { VoiceStatsSnapshot } from "./voice-stats-probe";

/**
 * The last ~30 seconds of the call's link, kept so a feedback report sent
 * mid-call can say what the path was and how it had been doing.
 *
 * NO NEW MEASUREMENT, NO NEW POLL. `useCallRating` already subscribes to the
 * one shared `sampleVoiceStats()` tick for the whole length of a call and
 * hands every snapshot here too; this only remembers the few numbers a
 * report needs (round trip, inbound loss counts, the selected pair's path)
 * and drops anything older than the window. Nothing in it names an address:
 * `CandidatePairSample` carries the local and remote IPs for the console, and
 * this module deliberately never copies them.
 *
 * WHAT THE NUMBERS MEAN. `rttMsAvg` is the round trip of the selected ICE
 * pair, which is you to the OTHER PERSON in the call (through the relay, if
 * there is one), not to a pqp server. `lossPctAvg` is inbound loss only.
 */

export const LINK_WINDOW_MS = 30_000;

interface LinkSample {
  at: number;
  rtt: number | null;
  lost: number;
  received: number;
  relayed: boolean;
  relayProtocol: "udp" | "tcp" | "tls" | null;
  relayHost: string | null;
  hasPath: boolean;
  sharing: boolean;
}

let recent: LinkSample[] = [];

export function resetLinkWindow(): void {
  recent = [];
}

function prune(now: number): void {
  const cutoff = now - LINK_WINDOW_MS;
  while (recent.length > 0 && recent[0]!.at < cutoff) {
    recent.shift();
  }
}

/** Fold one `sampleVoiceStats()` tick in. Cheap: it runs every two seconds. */
export function noteLinkSample(snapshot: VoiceStatsSnapshot, now = Date.now()): void {
  const rtts: number[] = [];
  let lost = 0;
  let received = 0;
  let relayedPath: (typeof snapshot.paths)[number] | undefined;
  for (const path of snapshot.paths) {
    if (path.rttMs !== null) {
      rtts.push(path.rttMs);
    }
    if (path.packetsLost !== null && path.packetsReceived !== null) {
      lost += path.packetsLost;
      received += path.packetsReceived;
    }
    if (path.relayed && !relayedPath) {
      relayedPath = path;
    }
  }
  const sharing =
    snapshot.senders.some((s) => s.role === "screen") ||
    snapshot.receivers.some((r) => r.role === "screen" && isLiveReceiver(r));
  recent.push({
    at: now,
    rtt: rtts.length > 0 ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null,
    lost,
    received,
    relayed: relayedPath !== undefined,
    relayProtocol: relayedPath?.relayProtocol ?? null,
    relayHost: relayedPath?.relayHost ?? null,
    hasPath: snapshot.paths.length > 0,
    sharing,
  });
  prune(now);
}

/** `navigator.connection`, where the browser has it (Chromium and so Electron). */
function networkInformation(): Pick<FeedbackVoiceLink, "effectiveType" | "downlinkMbps"> {
  const out: Pick<FeedbackVoiceLink, "effectiveType" | "downlinkMbps"> = {};
  const connection =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & {
          connection?: { effectiveType?: unknown; downlink?: unknown };
        }).connection;
  if (!connection) {
    return out;
  }
  if (typeof connection.effectiveType === "string" && connection.effectiveType) {
    out.effectiveType = connection.effectiveType.slice(0, 16);
  }
  if (typeof connection.downlink === "number" && Number.isFinite(connection.downlink)) {
    out.downlinkMbps = Math.max(0, connection.downlink);
  }
  return out;
}

/**
 * What a report attaches while in a call. Null when nothing was sampled in
 * the window (a call that has only just connected), in which case only the
 * browser's own network type is worth sending, and that is returned alone.
 */
export function currentLinkSummary(now = Date.now()): FeedbackVoiceLink {
  prune(now);
  const net = networkInformation();
  const samples = recent;
  if (samples.length === 0) {
    return net;
  }
  const latest = samples[samples.length - 1]!;
  const link: FeedbackVoiceLink = { ...net, samples: samples.length, sharing: latest.sharing };
  if (latest.hasPath) {
    link.relayed = latest.relayed;
    if (latest.relayed) {
      if (latest.relayProtocol) {
        link.relayProtocol = latest.relayProtocol;
      }
      if (latest.relayHost) {
        link.relayHost = latest.relayHost;
      }
    }
  }
  const rtts = samples.flatMap((s) => (s.rtt === null ? [] : [s.rtt]));
  if (rtts.length > 0) {
    link.rttMsAvg = Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length);
  }
  const lost = samples.reduce((a, s) => a + s.lost, 0);
  const received = samples.reduce((a, s) => a + s.received, 0);
  if (lost + received > 0) {
    link.lossPctAvg = Math.round((lost / (lost + received)) * 1000) / 10;
  }
  return link;
}
