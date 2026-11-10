import { detectOnsets, findPulse, median } from "./xcorr";

/**
 * The latency model's pure half: turning what the capture heard into a round
 * trip, judging how far to trust it, and remembering it per device pair.
 * The half that plays clicks and records them is `calibrate.ts`.
 *
 * Three ways to know the round trip, best first:
 *
 *  1. LOOPBACK. The microphone can hear the output (laptop speakers, a
 *     monitor, or a headphone cup held against the mic). Sweeps are played
 *     and found in the capture by cross-correlation. Measures the exact path
 *     a take uses, to a fraction of a millisecond.
 *  2. TAP-ALONG. The microphone cannot hear the output (headphones, a guitar
 *     straight into an interface). The player claps, taps the mic or hits
 *     muted strings on each click. Measures the same path plus the player's
 *     own timing habit, which is arguably what should be compensated, but it
 *     is a human: a few milliseconds of spread at best.
 *  3. ESTIMATE. What the browser reports: `baseLatency + outputLatency` for
 *     the way out and the track's reported latency for the way in. Free and
 *     instant, and in our reading of the field reports often wrong by tens of
 *     milliseconds (see `docs/JAM_ENGINE.md`), so it is labelled "low".
 */

export type LatencyMethod = "loopback" | "tap-along" | "estimate" | "manual";
export type LatencyConfidence = "high" | "medium" | "low" | "failed";

export interface LatencyResult {
  method: LatencyMethod;
  /** Output + input, milliseconds. NaN when `confidence` is "failed". */
  roundTripMs: number;
  confidence: LatencyConfidence;
  /** Largest deviation of an accepted measurement from the result, ms. */
  spreadMs: number;
  /** How many pulses/taps were usable, of how many were played. */
  accepted: number;
  played: number;
  /** Human-readable reason when confidence is low or failed. */
  note?: string;
  /** Per-pulse lags (ms) for a diagnostics view. */
  samples?: number[];
  /** When it was measured (ms since epoch). */
  at: number;
  /**
   * `outputLatency + baseLatency` (ms) the context reported when this was
   * measured. If the browser later reports something clearly different, the
   * output path changed under the same device ids (the OS switched the
   * default output, a Bluetooth codec renegotiated) and the stored value is
   * stale. Null where the browser reports nothing.
   */
  reportedOutputMs?: number | null;
}

/** How far the reported output latency may move before a stored measurement is stale, ms. */
export const STALE_OUTPUT_DRIFT_MS = 8;

export interface LoopbackAnalysisInput {
  captured: Float32Array;
  /** Context frame of `captured[0]`. */
  captureStartFrame: number;
  /** Context frames at which each reference pulse left the graph. */
  emittedFrames: number[];
  reference: Float32Array;
  sampleRate: number;
  /** Search window for the round trip, ms. Must be shorter than the pulse period. */
  maxLatencyMs: number;
  /** Below this normalised correlation a pulse is "not heard". */
  minQuality?: number;
}

export function analyseLoopback(input: LoopbackAnalysisInput): LatencyResult {
  const { captured, captureStartFrame, emittedFrames, reference, sampleRate } = input;
  const minQuality = input.minQuality ?? 0.2;
  const maxLag = Math.round((input.maxLatencyMs / 1000) * sampleRate);
  const lags: number[] = [];
  const all: number[] = [];
  for (const emitted of emittedFrames) {
    const from = emitted - captureStartFrame;
    const match = findPulse(captured, reference, from, from + maxLag, { sampleRate });
    if (!match) continue;
    const lagMs = ((match.position - from) / sampleRate) * 1000;
    all.push(Math.round(lagMs * 1000) / 1000);
    if (match.quality >= minQuality) lags.push(lagMs);
  }
  return judge("loopback", lags, emittedFrames.length, {
    highSpread: 0.25,
    mediumSpread: 1,
    outlierMs: 1,
    samples: all,
  });
}

export interface TapAnalysisInput {
  captured: Float32Array;
  captureStartFrame: number;
  /** Context frames at which each click the player tapped along to left the graph. */
  clickFrames: number[];
  sampleRate: number;
  maxLatencyMs?: number;
  /** The first taps are the player finding the beat; ignore this many. */
  warmup?: number;
}

export function analyseTapAlong(input: TapAnalysisInput): LatencyResult {
  const { captured, captureStartFrame, clickFrames, sampleRate } = input;
  const warmup = input.warmup ?? 2;
  const maxLag = ((input.maxLatencyMs ?? 450) / 1000) * sampleRate;
  // A tap can be early: people anticipate a beat by tens of milliseconds.
  const early = 0.08 * sampleRate;
  const onsets = detectOnsets(captured, sampleRate).map((o) => o + captureStartFrame);
  // Each onset belongs to at most one click, the nearest one whose window it
  // falls in: a missed tap must not let the next click's tap count twice.
  const owner = new Map<number, number>();
  onsets.forEach((o, oi) => {
    let best = -1;
    let bestDist = Infinity;
    clickFrames.forEach((click, ci) => {
      if (o < click - early || o > click + maxLag) return;
      const dist = Math.abs(o - click);
      if (dist < bestDist) {
        bestDist = dist;
        best = ci;
      }
    });
    if (best >= 0 && !owner.has(best)) owner.set(best, oi);
  });
  const lags: number[] = [];
  const all: number[] = [];
  clickFrames.forEach((click, i) => {
    const oi = owner.get(i);
    if (oi === undefined) return;
    const lagMs = ((onsets[oi] - click) / sampleRate) * 1000;
    all.push(Math.round(lagMs * 10) / 10);
    if (i >= warmup) lags.push(lagMs);
  });
  const result = judge("tap-along", lags, Math.max(0, clickFrames.length - warmup), {
    // a human: a 4 ms spread is a good drummer, 15 ms an ordinary one
    highSpread: -1,
    mediumSpread: 6,
    outlierMs: 25,
    samples: all,
  });
  if (result.confidence !== "failed" && result.spreadMs < 0.5) {
    result.note =
      "The taps line up to the sample: the microphone is probably hearing the clicks themselves. The loopback calibration is the better tool here.";
  }
  return result;
}

function judge(
  method: LatencyMethod,
  lags: number[],
  played: number,
  t: { highSpread: number; mediumSpread: number; outlierMs: number; samples: number[] },
): LatencyResult {
  const at = Date.now();
  const base = { method, played, samples: t.samples, at };
  const minAccepted = Math.max(3, Math.ceil(played * 0.5));
  if (lags.length < 3) {
    return {
      ...base,
      roundTripMs: NaN,
      confidence: "failed",
      spreadMs: NaN,
      accepted: lags.length,
      note:
        method === "loopback"
          ? "The microphone did not hear the clicks. Turn the speakers up, or hold a headphone cup against the microphone."
          : "Not enough taps were heard. Tap louder, closer to the microphone, on every click.",
    };
  }
  const m = median(lags);
  const inliers = lags.filter((l) => Math.abs(l - m) <= t.outlierMs);
  const result = median(inliers);
  const spread = inliers.reduce((s, l) => Math.max(s, Math.abs(l - result)), 0);
  let confidence: LatencyConfidence;
  if (inliers.length < minAccepted) confidence = "low";
  else if (spread <= t.highSpread) confidence = "high";
  else if (spread <= t.mediumSpread) confidence = "medium";
  else confidence = "low";
  const r: LatencyResult = {
    ...base,
    roundTripMs: Math.round(result * 1000) / 1000,
    confidence,
    spreadMs: Math.round(spread * 1000) / 1000,
    accepted: inliers.length,
  };
  if (confidence === "low") {
    r.note =
      inliers.length < minAccepted
        ? "Only some of the clicks were found; the result may be off."
        : "The measurements disagree with each other by more than expected.";
  }
  return r;
}

export interface ReportedLatencies {
  /** AudioContext.baseLatency, seconds (undefined where not implemented). */
  baseLatency?: number;
  /** AudioContext.outputLatency, seconds (0 or undefined where not implemented). */
  outputLatency?: number;
  /**
   * MediaStreamTrack.stats.latency (Chrome 125+), MILLISECONDS: the spec
   * types it DOMHighResTimeStamp, unlike every other number here.
   */
  trackStatsLatencyMs?: number;
  /** MediaTrackSettings.latency, seconds. Chrome has been seen reporting a fixed 0.01. */
  settingsLatency?: number;
}

export interface LatencyEstimate extends LatencyResult {
  method: "estimate";
  breakdown: {
    baseMs: number | null;
    outputMs: number | null;
    inputMs: number | null;
    inputSource: "track-stats" | "settings" | "assumed";
  };
}

/** Input latency to assume when the browser reports nothing (a typical capture buffer). */
export const ASSUMED_INPUT_MS = 10;

export function estimateFromReported(r: ReportedLatencies): LatencyEstimate {
  const ms = (s: number | undefined) =>
    typeof s === "number" && Number.isFinite(s) && s > 0 ? s * 1000 : null;
  const baseMs = ms(r.baseLatency);
  const outputMs = ms(r.outputLatency);
  let inputMs =
    typeof r.trackStatsLatencyMs === "number" && Number.isFinite(r.trackStatsLatencyMs) && r.trackStatsLatencyMs > 0
      ? r.trackStatsLatencyMs
      : null;
  let inputSource: LatencyEstimate["breakdown"]["inputSource"] = "track-stats";
  if (inputMs === null) {
    inputMs = ms(r.settingsLatency);
    inputSource = "settings";
  }
  if (inputMs === null) {
    inputMs = ASSUMED_INPUT_MS;
    inputSource = "assumed";
  }
  const total = (baseMs ?? 0) + (outputMs ?? 0) + inputMs;
  const notes: string[] = [];
  if (outputMs === null) notes.push("this browser does not report its output latency");
  if (inputSource === "assumed") notes.push(`input latency is not reported, ${ASSUMED_INPUT_MS} ms assumed`);
  return {
    method: "estimate",
    roundTripMs: Math.round(total * 1000) / 1000,
    // Never better than low: no browser promises these numbers add up to the
    // real round trip, and the browser's input FIFO is in none of them.
    confidence: "low",
    spreadMs: NaN,
    accepted: 0,
    played: 0,
    at: Date.now(),
    note: notes.length ? `Estimate only: ${notes.join("; ")}.` : "Estimate from what the browser reports.",
    breakdown: { baseMs, outputMs, inputMs, inputSource },
  };
}

/**
 * Which latency to compensate with: a stored measurement for this device
 * pair when it is usable, otherwise the estimate. Loopback beats tap-along
 * beats estimate; a manual value (the harness's nudge) beats everything,
 * because a person who typed a number meant it.
 */
export function chooseLatency(
  stored: LatencyResult[],
  estimate: LatencyEstimate,
  currentReportedOutputMs: number | null = null,
): LatencyResult {
  const usable = stored.filter(
    (r) =>
      r.confidence !== "failed" &&
      Number.isFinite(r.roundTripMs) &&
      !isStale(r, currentReportedOutputMs),
  );
  const rank: Record<LatencyMethod, number> = { manual: 0, loopback: 1, "tap-along": 2, estimate: 3 };
  usable.sort((a, b) => rank[a.method] - rank[b.method] || b.at - a.at);
  return usable[0] ?? estimate;
}

export function isStale(r: LatencyResult, currentReportedOutputMs: number | null): boolean {
  if (r.method === "manual") return false;
  if (typeof r.reportedOutputMs !== "number" || currentReportedOutputMs === null) return false;
  return Math.abs(r.reportedOutputMs - currentReportedOutputMs) > STALE_OUTPUT_DRIFT_MS;
}

// ---------------------------------------------------------------------------
// Devices

export interface DevicePair {
  input: { deviceId: string; label: string; groupId?: string };
  output: { deviceId: string; label: string };
  sampleRate: number;
}

/**
 * The key a calibration is stored under. Labels are in it because "default"
 * is a deviceId that silently changes meaning when somebody plugs in
 * headphones; the default output's label in Chrome names the real device
 * ("Default - AirPods Pro"). The sample rate is in it because a different
 * rate is a different driver setup with a different buffer.
 */
export function devicePairKey(p: DevicePair): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return [
    `in:${p.input.deviceId}|${norm(p.input.label)}`,
    `out:${p.output.deviceId}|${norm(p.output.label)}`,
    `sr:${p.sampleRate}`,
  ].join(" ");
}

const BLUETOOTH_LABEL =
  /bluetooth|airpods|beats|buds|\bbose\b|wh-1000|wf-1000|jabra|soundcore|\bjbl\b|sony wh|sony wf|powerbeats|hands-free|handsfree|\bhfp\b|\ba2dp\b|\(bt\)|\bbt\b/i;

export type OutputSuitability = "ok" | "bluetooth" | "unknown";

export interface OutputAssessment {
  suitability: OutputSuitability;
  reason: string;
}

/**
 * Bluetooth headphones add 100 to 300 ms that changes from session to
 * session (and sometimes within one), which no calibration can hold. Playing
 * back is fine; recording over them is not. There is no API that says
 * "Bluetooth", so this reads the label and the reported output latency.
 */
export function assessOutput(outputLabel: string, outputLatencySec?: number): OutputAssessment {
  if (BLUETOOTH_LABEL.test(outputLabel)) {
    return { suitability: "bluetooth", reason: `"${outputLabel}" looks like a Bluetooth device.` };
  }
  if (typeof outputLatencySec === "number" && outputLatencySec > 0.1) {
    return {
      suitability: "bluetooth",
      reason: `The browser reports ${Math.round(outputLatencySec * 1000)} ms of output latency, which is what Bluetooth looks like.`,
    };
  }
  if (!outputLabel) {
    return { suitability: "unknown", reason: "The browser does not say which output is in use." };
  }
  return { suitability: "ok", reason: "" };
}

// ---------------------------------------------------------------------------
// Storage

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORE_KEY = "pqp:jam:latency:v1";

/**
 * Calibrations per device pair, in localStorage: a per-viewer convenience.
 * Every access is wrapped, because storage can be missing or throw (private
 * windows, blocked site data) and losing a calibration only costs a re-run.
 */
export class LatencyStore {
  constructor(private readonly store: KeyValueStore | null = safeLocalStorage()) {}

  private readAll(): Record<string, LatencyResult[]> {
    try {
      const raw = this.store?.getItem(STORE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, LatencyResult[]>) : {};
    } catch {
      return {};
    }
  }

  private writeAll(all: Record<string, LatencyResult[]>) {
    try {
      this.store?.setItem(STORE_KEY, JSON.stringify(all));
    } catch {
      /* a lost calibration is a re-run, not an error */
    }
  }

  get(key: string): LatencyResult[] {
    const list = this.readAll()[key];
    return Array.isArray(list) ? list : [];
  }

  /** Keep the newest result per method for this pair. */
  save(key: string, result: LatencyResult) {
    const all = this.readAll();
    const kept = (all[key] ?? []).filter((r) => r.method !== result.method);
    all[key] = [...kept, { ...result, samples: undefined }];
    this.writeAll(all);
  }

  clear(key?: string) {
    if (!key) {
      try {
        this.store?.removeItem(STORE_KEY);
      } catch {
        /* nothing to do */
      }
      return;
    }
    const all = this.readAll();
    delete all[key];
    this.writeAll(all);
  }
}

function safeLocalStorage(): KeyValueStore | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}
