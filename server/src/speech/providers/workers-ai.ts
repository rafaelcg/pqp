import { loadAudio } from "../audio.js";
import { fetchWithRetry, type RetryOptions } from "../http.js";
import { normalizeLanguage } from "./openrouter.js";
import { SpeechHttpError, type SttOptions, type SttProvider, type SttResult, type SttSegment } from "../types.js";

export const WORKERS_AI_MODEL = "@cf/openai/whisper-large-v3-turbo";

/** USD per audio minute, from developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo. */
export const WORKERS_AI_USD_PER_MINUTE = 0.000513;

/** A call that has not finished by now is abandoned, retries included. */
export const WORKERS_AI_DEFAULT_TIMEOUT_MS = 30_000;

export interface WorkersAiOptions {
  accountId: string;
  apiToken: string;
  baseUrl?: string;
  /** Run Cloudflare's voice activity detection first, which cuts text invented on silence. Their default is off. */
  vadFilter?: boolean;
  /** Overall budget for one `transcribe` call, retries included. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  retry?: Partial<Pick<RetryOptions, "maxAttempts" | "baseDelayMs" | "maxDelayMs" | "sleep" | "onRetry">>;
}

export function workersAiCostUsd(durationSeconds: number): number {
  return (durationSeconds / 60) * WORKERS_AI_USD_PER_MINUTE;
}

export interface WorkersAiBody {
  audio: string;
  task: "transcribe";
  language?: string;
  initial_prompt?: string;
  vad_filter?: boolean;
}

/** Pure request builder, exported so the offline tests pin the wire shape. */
export function buildWorkersAiBody(
  o: Pick<WorkersAiOptions, "vadFilter">,
  audio: { bytes: Buffer },
  opts: SttOptions,
): WorkersAiBody {
  return {
    audio: audio.bytes.toString("base64"),
    task: "transcribe",
    ...(opts.language ? { language: opts.language } : {}),
    ...(opts.prompt ? { initial_prompt: opts.prompt } : {}),
    ...(o.vadFilter !== undefined ? { vad_filter: o.vadFilter } : {}),
  };
}

interface WorkersAiResult {
  text?: string;
  transcription_info?: { language?: string; duration?: number };
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
    avg_logprob?: number;
    no_speech_prob?: number;
  }>;
}

/** The REST API wraps the model output in `result`; the Workers binding does not. Both parse. */
interface WorkersAiEnvelope extends WorkersAiResult {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: WorkersAiResult;
}

export function parseWorkersAiResponse(body: WorkersAiEnvelope): SttResult {
  const r = body.result ?? body;
  const segments: SttSegment[] = (r.segments ?? [])
    .map((s) => ({
      start: s.start ?? 0,
      end: s.end ?? s.start ?? 0,
      text: (s.text ?? "").trim(),
      ...(s.no_speech_prob !== undefined ? { noSpeechProb: s.no_speech_prob } : {}),
      ...(s.avg_logprob !== undefined ? { avgLogprob: s.avg_logprob } : {}),
    }))
    .filter((s) => s.text);
  const durationMs = Math.round((r.transcription_info?.duration ?? segments.at(-1)?.end ?? 0) * 1000);
  return {
    text: (r.text ?? segments.map((s) => s.text).join(" ")).trim(),
    segments,
    language: normalizeLanguage(r.transcription_info?.language),
    durationMs,
    costUsd: workersAiCostUsd(durationMs / 1000),
  };
}

/**
 * Cloudflare Workers AI over REST (`POST .../ai/run/@cf/openai/whisper-large-v3-turbo`,
 * JSON with base64 audio). Segments carry `no_speech_prob` and `avg_logprob`.
 */
export function createWorkersAiProvider(o: WorkersAiOptions): SttProvider {
  const url = `${o.baseUrl ?? "https://api.cloudflare.com/client/v4"}/accounts/${encodeURIComponent(o.accountId)}/ai/run/${WORKERS_AI_MODEL}`;
  return {
    id: `workers-ai/${WORKERS_AI_MODEL}`,
    async transcribe(audio, opts: SttOptions): Promise<SttResult> {
      const a = await loadAudio(audio, opts.format);
      const body = JSON.stringify(buildWorkersAiBody(o, a, opts));
      const timeout = AbortSignal.timeout(o.timeoutMs ?? WORKERS_AI_DEFAULT_TIMEOUT_MS);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      const res = await fetchWithRetry(
        url,
        () => ({
          method: "POST",
          headers: { Authorization: `Bearer ${o.apiToken}`, "Content-Type": "application/json" },
          body,
        }),
        { provider: "workers-ai", ...o.retry, signal },
        o.fetchImpl,
      );
      const parsed = (await res.json()) as WorkersAiEnvelope;
      // The API can answer 200 with success:false for a model error.
      if (parsed.success === false) {
        throw new SpeechHttpError("workers-ai", res.status, (parsed.errors?.[0]?.message ?? "request failed").slice(0, 300));
      }
      return parseWorkersAiResponse(parsed);
    },
  };
}
