import { join } from "node:path";
import {
  ChunkedTranscribeError,
  DEFAULT_WINDOW,
  planWindows,
  transcribeChunked,
  type AudioWindow,
  type ChunkedResult,
} from "../../../server/src/speech/chunker.js";
import { energyGate } from "../../../server/src/speech/gate.js";
import type { SttProvider, SttResult } from "../../../server/src/speech/types.js";
import type { BenchKeys } from "./env.js";
import { CLIPS, decodePcm16k, pcmToWav, slicePcm } from "./media.js";
import { CONFIGS, type ConfigName, type Lane, type ProviderSpec } from "./matrix.js";
import { runKey, type Mode, type RunRecord, type Store } from "./store.js";

export const SPEECH_CLIPS = ["dense1", "dense2", "dense3", "mic60", "mixed"];
export const HALLUCINATION_CLIPS = ["silence", "quiet", "noise", "film"];

interface Job {
  clip: string;
  mode: Mode;
  config: ConfigName;
}

export function jobsFor(spec: ProviderSpec): Job[] {
  const jobs: Job[] = [];
  const speechConfigs: ConfigName[] = spec.glossary ? ["pt", "auto", "gloss"] : ["pt", "auto"];
  for (const clip of SPEECH_CLIPS) for (const config of speechConfigs) jobs.push({ clip, mode: "whole", config });
  for (const config of speechConfigs) jobs.push({ clip: "names", mode: "whole", config });
  jobs.push({ clip: "dense1", mode: "chunked", config: "pt" });
  jobs.push({ clip: "dense1", mode: "chunked-gated", config: "pt" });
  if (spec.glossary && /turbo/.test(spec.id)) jobs.push({ clip: "dense1", mode: "chunked-carry", config: "gloss" });
  if (spec.glossary && /turbo|large-v3$|gpt-4o-transcribe/.test(spec.id)) {
    jobs.push({ clip: "dense1", mode: "chunked-gated-gloss", config: "gloss" });
    jobs.push({ clip: "dense1", mode: "chunked-gated-carry", config: "gloss" });
  }
  // Groq's free tier is 20 requests a minute: one request per 3.2 s never trips it, which is what a product would do.
  if (spec.lane === "groq") jobs.push({ clip: "dense1", mode: "chunked-paced", config: "pt" });
  // Window-size sweep on the two Whisper turbo candidates (gated, forced pt).
  if (spec.id === "groq/whisper-large-v3-turbo" || spec.id === "whisper-cpp/large-v3-turbo") {
    for (const mode of ["chunked-w6o1", "chunked-w10o1", "chunked-w10o2"]) jobs.push({ clip: "dense1", mode, config: "pt" });
  }
  for (const clip of HALLUCINATION_CLIPS) {
    jobs.push({ clip, mode: "whole", config: "pt" });
    jobs.push({ clip, mode: "chunked", config: "pt" });
    jobs.push({ clip, mode: "chunked-gated", config: "pt" });
    jobs.push({ clip, mode: "whole", config: "auto" });
  }
  return jobs;
}

export interface SttRunOptions {
  specs: ProviderSpec[];
  keys: BenchKeys;
  clipsDir: string;
  store: Store<RunRecord>;
  /** Stop starting paid OpenRouter work once this much has been spent (USD, all stages). */
  spendCapUsd: number;
  spentSoFar: () => number;
  only?: { providers?: string[]; clips?: string[]; modes?: string[] };
  log: (line: string) => void;
}

class SpendCapReached extends Error {}

export async function runStt(o: SttRunOptions): Promise<void> {
  const pcmCache = new Map<string, Int16Array>();
  const pcmOf = async (clip: string) => {
    let p = pcmCache.get(clip);
    if (!p) {
      p = await decodePcm16k(join(o.clipsDir, `${clip}.flac`));
      pcmCache.set(clip, p);
    }
    return p;
  };

  const lanes = new Map<Lane, ProviderSpec[]>();
  for (const s of o.specs) {
    if (o.only?.providers && !o.only.providers.some((p) => s.id.includes(p))) continue;
    lanes.set(s.lane, [...(lanes.get(s.lane) ?? []), s]);
  }

  // One stop flag and one reservation total shared by every lane: a lane that reaches the cap
  // stops all of them from starting new work, and requests already in flight are counted before
  // they finish, so parallel paid lanes cannot each see "below the cap" and overshoot it together.
  let stopped = false;
  let reservedUsd = 0;
  const estimateUsd = (spec: ProviderSpec, job: Job) => {
    const clipMs = (CLIPS.find((c) => c.id === job.clip)?.seconds ?? 0) * 1000;
    // Chunked runs bill overlap and per-request minimums, so reserve with headroom.
    const factor = job.mode === "whole" ? 1 : 1.5;
    return (clipMs / 3_600_000) * spec.usdPerHour * factor;
  };

  async function runLane(specs: ProviderSpec[]) {
    for (const spec of specs) {
      if (stopped) return;
      let retries = 0;
      let provider: SttProvider;
      try {
        provider = spec.make(o.keys, (status) => {
          if (status === 429) retries += 1;
        });
      } catch (e) {
        o.log(`SKIP ${spec.id}: ${(e as Error).message}`);
        continue;
      }
      let consecutiveErrors = 0;
      for (const job of jobsFor(spec)) {
        if (o.only?.clips && !o.only.clips.includes(job.clip)) continue;
        if (o.only?.modes && !o.only.modes.includes(job.mode)) continue;
        const key = runKey(spec.id, job.clip, job.mode, job.config);
        if (o.store.has(key)) continue;
        if (stopped) return;
        const reserve = spec.paid ? estimateUsd(spec, job) : 0;
        if (spec.paid && o.spentSoFar() + reservedUsd + reserve > o.spendCapUsd) {
          o.log(`STOP ${spec.id}: spend cap ${o.spendCapUsd} USD reached`);
          stopped = true;
          throw new SpendCapReached();
        }
        const before = retries;
        reservedUsd += reserve;
        let rec: RunRecord;
        try {
          rec = await runJob(spec, provider, job, key, pcmOf, o.clipsDir);
          rec.retries429 = retries - before;
          o.store.put(rec);
        } finally {
          // The record (with its real cost) is stored first, so spentSoFar never dips in between.
          reservedUsd -= reserve;
        }
        o.log(
          `${rec.error ? "FAIL" : "ok  "} ${spec.id} ${job.clip} ${job.mode} ${job.config} ` +
            (rec.error ? rec.error.slice(0, 120) : `${(rec.latencyMs / 1000).toFixed(1)}s $${rec.costUsd.toFixed(4)} ${rec.text.length} chars`),
        );
        consecutiveErrors = rec.error ? consecutiveErrors + 1 : 0;
        if (consecutiveErrors >= 4) {
          o.log(`GIVE UP ${spec.id}: 4 failures in a row`);
          break;
        }
      }
    }
  }

  // Wait for every lane to settle before returning, so the caller never builds a report
  // while a lane is still writing results. A spend-cap stop is not an error.
  const settled = await Promise.allSettled([...lanes.values()].map(runLane));
  const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected" && !(r.reason instanceof SpendCapReached));
  if (failure) throw failure.reason;
}

/** Cost of a chunked run: what providers reported, topped up from the price table for requests that did not say. */
function chunkedCost(res: ChunkedResult, spec: ProviderSpec, windowMs: number): { costUsd: number; computed: boolean } {
  if (res.costUsd !== undefined) return { costUsd: res.costUsd, computed: false };
  const perRequest = (windowMs / 3_600_000) * spec.usdPerHour;
  return { costUsd: res.knownCostUsd + res.unknownCostRequests * perRequest, computed: true };
}

async function runJob(
  spec: ProviderSpec,
  provider: SttProvider,
  job: Job,
  key: string,
  pcmOf: (clip: string) => Promise<Int16Array>,
  clipsDir: string,
): Promise<RunRecord> {
  const cfg = CONFIGS[job.config];
  const clipMs = (CLIPS.find((c) => c.id === job.clip)?.seconds ?? 0) * 1000;
  const base: RunRecord = {
    key,
    provider: spec.id,
    clip: job.clip,
    mode: job.mode,
    config: job.config,
    text: "",
    segments: [],
    audioMs: clipMs,
    latencyMs: 0,
    requests: 0,
    skipped: 0,
    windowLatenciesMs: [],
    costUsd: 0,
    costKind: spec.lane === "local" ? "free" : spec.lane === "openrouter" ? "reported" : "computed",
    retries429: 0,
    at: new Date().toISOString(),
  };
  try {
    if (job.mode === "whole" && spec.maxRequestSeconds && clipMs > spec.maxRequestSeconds * 1000) {
      // The provider cannot take the clip in one request: send back-to-back pieces, no overlap.
      const pcm = await pcmOf(job.clip);
      const windows = planWindows(clipMs, { windowMs: spec.maxRequestSeconds * 1000, overlapMs: 0 });
      const res = await transcribeChunked({
        provider,
        windows,
        readWindow: async (w) => pcmToWav(slicePcm(pcm, w.startMs, w.endMs)),
        sttOpts: { language: cfg.language, format: "wav" },
        glossary: cfg.prompt,
      });
      return {
        ...base,
        text: res.text,
        segments: res.segments,
        latencyMs: res.windows.reduce((a, w) => a + w.latencyMs, 0),
        requests: res.requests,
        costUsd: chunkedCost(res, spec, spec.maxRequestSeconds * 1000).costUsd,
        costKind: chunkedCost(res, spec, spec.maxRequestSeconds * 1000).computed ? "computed" : base.costKind,
      };
    }
    if (job.mode === "whole") {
      const t0 = Date.now();
      const r: SttResult = await provider.transcribe(join(clipsDir, `${job.clip}.flac`), cfg);
      const latencyMs = Date.now() - t0;
      return {
        ...base,
        text: r.text,
        segments: r.segments,
        language: r.language,
        latencyMs,
        requests: 1,
        costUsd: r.costUsd ?? (clipMs / 3_600_000) * spec.usdPerHour,
        costKind: r.costUsd === undefined && spec.lane === "openrouter" ? "computed" : base.costKind,
      };
    }
    const pcm = await pcmOf(job.clip);
    const sweep = /^chunked-w(\d+)o(\d+)$/.exec(job.mode);
    const windows = planWindows(clipMs, sweep ? { windowMs: Number(sweep[1]) * 1000, overlapMs: Number(sweep[2]) * 1000 } : DEFAULT_WINDOW);
    const wavFor = (w: AudioWindow) => pcmToWav(slicePcm(pcm, w.startMs, w.endMs));
    const pace = job.mode === "chunked-paced" || (sweep && spec.lane === "groq") ? paced(provider, 3200) : undefined;
    const res = await transcribeChunked({
      provider: pace?.provider ?? provider,
      windows,
      readWindow: async (w) => wavFor(w),
      sttOpts: { language: cfg.language, format: "wav" },
      glossary: cfg.prompt,
      carryPromptChars: /carry$/.test(job.mode) ? 160 : undefined,
      gate:
        job.mode.startsWith("chunked-gated") || sweep
          ? (w) => energyGate(slicePcm(pcm, w.startMs, w.endMs), 16_000).speech
          : undefined,
    });
    const sent = res.windows.filter((w) => !w.skipped);
    const cost = chunkedCost(res, spec, DEFAULT_WINDOW.windowMs);
    return {
      ...base,
      text: res.text,
      segments: res.segments,
      latencyMs: (pace?.latencies ?? sent.map((w) => w.latencyMs)).reduce((a, b) => a + b, 0),
      requests: res.requests,
      skipped: res.windows.length - res.requests,
      windowLatenciesMs: pace?.latencies ?? sent.map((w) => w.latencyMs),
      windows: res.windows.map((w) => ({ startMs: w.window.startMs, endMs: w.window.endMs, skipped: w.skipped, text: w.text, latencyMs: pace ? 0 : w.latencyMs })),
      costUsd: cost.costUsd,
      costKind: cost.computed && spec.lane !== "local" ? "computed" : base.costKind,
    };
  } catch (e) {
    // A chunked run that failed part-way already paid for its completed windows: keep that spend on the record.
    // Requests that completed without a reported cost are priced from the table, so none vanish from spend.
    const first = e instanceof ChunkedTranscribeError ? e.partial.windows[0]?.window : undefined;
    const spent =
      e instanceof ChunkedTranscribeError
        ? chunkedCost(e.partial, spec, first ? first.endMs - first.startMs : DEFAULT_WINDOW.windowMs).costUsd
        : 0;
    return { ...base, costUsd: spent, requests: e instanceof ChunkedTranscribeError ? e.partial.requests : 0, error: scrub((e as Error).message) };
  }
}

/** Space request starts at least `ms` apart. */
function paced(p: SttProvider, ms: number): { provider: SttProvider; latencies: number[] } {
  let last = 0;
  const latencies: number[] = [];
  return {
    latencies,
    provider: {
      id: p.id,
      async transcribe(audio, opts) {
        const wait = last + ms - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        last = Date.now();
        try {
          return await p.transcribe(audio, opts);
        } finally {
          // The request's own time, without the pacing wait that transcribeChunked would count.
          latencies.push(Date.now() - last);
        }
      },
    },
  };
}

/** Defence in depth: provider errors never carry a header, but nothing key-shaped is stored either. */
function scrub(msg: string): string {
  return msg.replace(/(gsk_|sk-or-|sk-)[A-Za-z0-9_-]{8,}/g, "[redacted]").slice(0, 400);
}
