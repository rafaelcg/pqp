/**
 * A console-only window onto what the video encoder is actually doing.
 *
 * WHY THIS EXISTS. Every quality report about a call arrives as an impression
 * ("it was awful the second time") and there is no way to turn that into a
 * number after the fact: `getStats()` is per-`RTCPeerConnection`, the objects
 * are gone the moment the call ends, and nothing here was keeping them. So a
 * bad call produced an opinion and no evidence, and the two candidate causes —
 * the encoder giving up resolution under bandwidth pressure, and the media
 * taking a relayed path — look identical from the outside while being opposite
 * fixes.
 *
 * WHAT IT IS NOT. It is not a feature. Nothing renders, nothing is sampled and
 * nothing is timed until somebody types `pqpVoiceStats.report()` into a
 * console; registering a connection costs one `Map.set` and unregistering one
 * `Map.delete`. There is no UI, no toast, no periodic work, and no behaviour
 * change of any kind on the call itself.
 *
 * WHY IT IS NOT GATED TO DEV BUILDS. The defect being chased only happens on
 * real networks between two real houses, which means the hosted build is the
 * only place it can be measured. A dev-only probe would be a probe that can
 * never see the bug. The cost of shipping it is a registry and an unreferenced
 * global, which is smaller than the cost of guessing.
 */

/** Which of the two video senders a track belongs to. */
export type VideoSenderRole = "camera" | "screen" | "unknown";

/**
 * The subset of `getStats()` this reads, declared locally.
 *
 * `lib.dom` disagrees with itself across TypeScript versions about which of
 * these fields exist and which are optional, and a probe is not worth a
 * `skipLibCheck` argument — everything is optional here because everything
 * genuinely is: browsers omit fields freely and the whole point is to report
 * what was actually present.
 */
export interface RtcStatLike {
  id?: string;
  type?: string;
  timestamp?: number;
  [key: string]: unknown;
}

/** One outbound video track, as it looked at the moment of sampling. */
export interface VideoSenderSample {
  peerId: string;
  role: VideoSenderRole;
  /** Sender-side frame size. `null` before the first frame is encoded. */
  width: number | null;
  height: number | null;
  fps: number | null;
  /** Measured from the byte delta since the previous sample, not reported. */
  kbps: number | null;
  /** What the encoder is aiming at right now, which is BWE's verdict. */
  targetKbps: number | null;
  /** The field this whole probe exists for: `bandwidth`, `cpu`, `none`, … */
  limitedBy: string | null;
  /** Seconds spent limited by each reason, since the call began. */
  limitDurations: Record<string, number> | null;
  encoder: string | null;
  framesEncoded: number | null;
  framesSent: number | null;
  keyFramesEncoded: number | null;
  pliCount: number | null;
  nackCount: number | null;
}

/** The path the media is taking, which is the other half of the answer. */
export interface CandidatePairSample {
  peerId: string;
  localType: string | null;
  remoteType: string | null;
  /** True when either end is a TURN allocation: the throughput suspect. */
  relayed: boolean;
  rttMs: number | null;
  availableOutgoingKbps: number | null;
  localAddress: string | null;
  remoteAddress: string | null;
}

export interface VoiceStatsSnapshot {
  senders: VideoSenderSample[];
  paths: CandidatePairSample[];
}

/** Byte/timestamp pair kept between samples so a bitrate can be derived. */
interface ByteMark {
  bytesSent: number;
  timestamp: number;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Turn one `getStats()` report into rows.
 *
 * Pure and separately testable on purpose: the interesting part is the joining
 * — outbound-rtp → media-source → track id → sender role, and transport →
 * selected candidate pair → local/remote candidate — and none of that needs a
 * browser to be wrong in an interesting way.
 *
 * `previous` is read *and written*: the caller owns it so that consecutive
 * samples of the same connection can produce a real bitrate rather than the
 * cumulative average since the call started, which is the number that makes a
 * collapse invisible.
 */
export function summariseStats(
  peerId: string,
  stats: Iterable<RtcStatLike>,
  roleOfTrack: (trackId: string) => VideoSenderRole,
  previous: Map<string, ByteMark>,
): VoiceStatsSnapshot {
  const byId = new Map<string, RtcStatLike>();
  const all: RtcStatLike[] = [];
  for (const stat of stats) {
    all.push(stat);
    if (typeof stat.id === "string") {
      byId.set(stat.id, stat);
    }
  }

  const senders: VideoSenderSample[] = [];
  for (const stat of all) {
    if (stat.type !== "outbound-rtp" || stat.kind !== "video") {
      continue;
    }
    // The track id is only reachable through the media-source stat; the
    // outbound-rtp itself carries no `trackIdentifier` in current browsers.
    const source = byId.get(str(stat.mediaSourceId) ?? "");
    const trackId = str(source?.trackIdentifier);
    const key = `${peerId}:${str(stat.id) ?? "?"}`;
    const bytesSent = num(stat.bytesSent);
    const timestamp = num(stat.timestamp);
    const mark = previous.get(key);
    let kbps: number | null = null;
    if (
      mark &&
      bytesSent !== null &&
      timestamp !== null &&
      timestamp > mark.timestamp
    ) {
      const seconds = (timestamp - mark.timestamp) / 1000;
      kbps = Math.round(((bytesSent - mark.bytesSent) * 8) / seconds / 1000);
    }
    if (bytesSent !== null && timestamp !== null) {
      previous.set(key, { bytesSent, timestamp });
    }

    const durations = stat.qualityLimitationDurations;
    senders.push({
      peerId,
      role: trackId ? roleOfTrack(trackId) : "unknown",
      width: num(stat.frameWidth),
      height: num(stat.frameHeight),
      fps: num(stat.framesPerSecond),
      kbps,
      targetKbps:
        num(stat.targetBitrate) === null
          ? null
          : Math.round(num(stat.targetBitrate)! / 1000),
      limitedBy: str(stat.qualityLimitationReason),
      limitDurations:
        durations && typeof durations === "object"
          ? (durations as Record<string, number>)
          : null,
      encoder: str(stat.encoderImplementation),
      framesEncoded: num(stat.framesEncoded),
      framesSent: num(stat.framesSent),
      keyFramesEncoded: num(stat.keyFramesEncoded),
      pliCount: num(stat.pliCount),
      nackCount: num(stat.nackCount),
    });
  }

  // The transport's own pointer is the authoritative "which pair won"; the
  // nominated-and-succeeded scan is the fallback for browsers that omit it.
  const selectedIds = new Set<string>();
  for (const stat of all) {
    if (stat.type === "transport") {
      const selected = str(stat.selectedCandidatePairId);
      if (selected) {
        selectedIds.add(selected);
      }
    }
  }
  const pairs = all.filter((stat) => {
    if (stat.type !== "candidate-pair") {
      return false;
    }
    if (selectedIds.size > 0) {
      return selectedIds.has(str(stat.id) ?? "");
    }
    return stat.nominated === true && stat.state === "succeeded";
  });

  const paths: CandidatePairSample[] = pairs.map((pair) => {
    const local = byId.get(str(pair.localCandidateId) ?? "");
    const remote = byId.get(str(pair.remoteCandidateId) ?? "");
    const localType = str(local?.candidateType);
    const remoteType = str(remote?.candidateType);
    const available = num(pair.availableOutgoingBitrate);
    const rtt = num(pair.currentRoundTripTime);
    return {
      peerId,
      localType,
      remoteType,
      relayed: localType === "relay" || remoteType === "relay",
      rttMs: rtt === null ? null : Math.round(rtt * 1000),
      availableOutgoingKbps:
        available === null ? null : Math.round(available / 1000),
      localAddress: str(local?.address) ?? str(local?.ip),
      remoteAddress: str(remote?.address) ?? str(remote?.ip),
    };
  });

  return { senders, paths };
}

interface Registration {
  peerId: string;
  pc: RTCPeerConnection;
  roleOfTrack: (trackId: string) => VideoSenderRole;
}

const registrations = new Map<RTCPeerConnection, Registration>();
const byteMarks = new Map<string, ByteMark>();
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * The console surface. Deliberately tiny and deliberately verb-shaped, because
 * it is typed by a person mid-call with one hand.
 */
export interface VoiceStatsConsole {
  /** Sample every live connection once and print it. Returns the rows too. */
  report(): Promise<VoiceStatsSnapshot>;
  /** Sample every `ms` until `stop()`. This is how a collapse gets caught. */
  start(ms?: number): string;
  stop(): string;
  /** Everything sampled so far as JSON, for pasting into an issue. */
  dump(): Promise<string>;
}

/**
 * One silent sample of every live connection.
 *
 * The same work `report()` does without the printing, so a UI readout and the
 * console tool cannot disagree about what is being sent. Callers share the
 * byte marks, which means two consumers sampling at different intervals will
 * each see a bitrate measured from whichever sample came last. That is fine
 * for a readout and would not be for billing.
 */
export function sampleVoiceStats(): Promise<VoiceStatsSnapshot> {
  return sampleAll();
}

async function sampleAll(): Promise<VoiceStatsSnapshot> {
  const senders: VideoSenderSample[] = [];
  const paths: CandidatePairSample[] = [];
  for (const registration of registrations.values()) {
    try {
      const report = await registration.pc.getStats();
      const snapshot = summariseStats(
        registration.peerId,
        // `.values()`, NOT the report itself, and the difference is the whole
        // of a bug that shipped. `RTCStatsReport` is Map-shaped: iterating it
        // directly yields `[id, stat]` PAIRS, so `stat.type` is `undefined` on
        // every one of them, nothing matches `outbound-rtp`, and the sampler
        // returns an empty snapshot from a call that is sending perfectly well.
        // The old `as unknown as Iterable<RtcStatLike>` was what let that past
        // the compiler, and the unit tests could not see it because they pass a
        // plain array — which iterates the way this code assumed a report did.
        // Visible as `pqpVoiceStats.report()` printing "not in a call?" during
        // a call, and as the in-call readout saying it has nothing to measure
        // beside a camera that is plainly running.
        report.values() as Iterable<RtcStatLike>,
        registration.roleOfTrack,
        byteMarks,
      );
      senders.push(...snapshot.senders);
      paths.push(...snapshot.paths);
    } catch {
      // A connection closed between the iteration and the call. Nothing to say.
    }
  }
  return { senders, paths };
}

/* eslint-disable no-console -- the console IS the output of this module; there
   is nothing else for it to write to, and warn/error would misrepresent a
   measurement as a fault. */
function print(snapshot: VoiceStatsSnapshot): void {
  const time = new Date().toLocaleTimeString();
  if (snapshot.senders.length === 0 && snapshot.paths.length === 0) {
    console.log(`[pqp voice ${time}] no mesh connections — not in a call?`);
    return;
  }
  console.log(`[pqp voice ${time}] outbound video`);
  console.table(
    snapshot.senders.map((sender) => ({
      peer: sender.peerId.slice(0, 8),
      role: sender.role,
      size:
        sender.width && sender.height ? `${sender.width}x${sender.height}` : "-",
      fps: sender.fps ?? "-",
      kbps: sender.kbps ?? "-",
      target: sender.targetKbps ?? "-",
      limitedBy: sender.limitedBy ?? "-",
      encoder: sender.encoder ?? "-",
      pli: sender.pliCount ?? "-",
    })),
  );
  console.table(
    snapshot.paths.map((path) => ({
      peer: path.peerId.slice(0, 8),
      pair: `${path.localType ?? "?"} -> ${path.remoteType ?? "?"}`,
      relayed: path.relayed,
      rttMs: path.rttMs ?? "-",
      availKbps: path.availableOutgoingKbps ?? "-",
    })),
  );
  // Printed apart from the table because it is the cumulative field: it says
  // how much of the call so far was spent starved, which a single-instant
  // `limitedBy` cannot.
  for (const sender of snapshot.senders) {
    if (sender.limitDurations) {
      console.log(
        `  ${sender.peerId.slice(0, 8)} ${sender.role} limited (s):`,
        sender.limitDurations,
      );
    }
  }
}
/* eslint-enable no-console */

const api: VoiceStatsConsole = {
  async report() {
    const snapshot = await sampleAll();
    print(snapshot);
    return snapshot;
  },
  start(ms = 2000) {
    if (timer) {
      clearInterval(timer);
    }
    timer = setInterval(() => {
      void sampleAll().then(print);
    }, ms);
    return `pqp voice stats: sampling every ${ms}ms — pqpVoiceStats.stop() to end`;
  },
  stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    return "pqp voice stats: stopped";
  },
  async dump() {
    return JSON.stringify(await sampleAll(), null, 2);
  },
};

/**
 * Hand the console the handle, once.
 *
 * Attached on the first registration rather than at import time so that a
 * build which never opens a call never touches `window` at all, and so the
 * global is absent (rather than present and empty) outside a call.
 */
function exposeConsole(): void {
  if (typeof window === "undefined" || window.pqpVoiceStats) {
    return;
  }
  window.pqpVoiceStats = api;
}

/**
 * Track one peer connection for the duration of its life.
 *
 * `roleOfTrack` is a callback rather than a snapshot because the senders are
 * swapped underneath us: `replaceTrack` gives the same sender a new track id
 * every time a camera or a share restarts, and a captured id would start
 * labelling everything "unknown" the moment that happened.
 */
export function registerVoiceConnection(
  peerId: string,
  pc: RTCPeerConnection,
  roleOfTrack: (trackId: string) => VideoSenderRole,
): void {
  registrations.set(pc, { peerId, pc, roleOfTrack });
  exposeConsole();
}

export function unregisterVoiceConnection(pc: RTCPeerConnection): void {
  registrations.delete(pc);
}
