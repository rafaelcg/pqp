import { loadAudio } from "../audio.js";
import { fetchWithRetry, type RetryOptions } from "../http.js";
import type { SttOptions, SttProvider, SttResult, SttSegment } from "../types.js";

export type GroqModel = "whisper-large-v3-turbo" | "whisper-large-v3";

/** USD per audio hour, from console.groq.com/docs/speech-to-text. Billed with a 10 s minimum per request. */
export const GROQ_USD_PER_HOUR: Record<GroqModel, number> = {
  "whisper-large-v3-turbo": 0.04,
  "whisper-large-v3": 0.111,
};
export const GROQ_MIN_BILLED_SECONDS = 10;

export interface GroqOptions {
  apiKey: string;
  model: GroqModel;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  retry?: Partial<Pick<RetryOptions, "maxAttempts" | "baseDelayMs" | "maxDelayMs" | "sleep" | "onRetry">>;
}

export function groqCostUsd(model: GroqModel, durationSeconds: number): number {
  return (Math.max(durationSeconds, GROQ_MIN_BILLED_SECONDS) / 3600) * GROQ_USD_PER_HOUR[model];
}

interface VerboseJson {
  text?: string;
  language?: string;
  duration?: number;
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
    avg_logprob?: number;
    no_speech_prob?: number;
  }>;
}

/** Shared by Groq and any OpenAI-shaped verbose_json: seconds in, trimmed segments out. */
export function parseVerboseJson(body: VerboseJson): { text: string; segments: SttSegment[]; language?: string; duration?: number } {
  const segments: SttSegment[] = (body.segments ?? []).map((s) => ({
    start: s.start ?? 0,
    end: s.end ?? s.start ?? 0,
    text: (s.text ?? "").trim(),
    ...(s.no_speech_prob !== undefined ? { noSpeechProb: s.no_speech_prob } : {}),
    ...(s.avg_logprob !== undefined ? { avgLogprob: s.avg_logprob } : {}),
  }));
  return {
    text: (body.text ?? segments.map((s) => s.text).join(" ")).trim(),
    segments,
    language: body.language,
    duration: body.duration,
  };
}

export function createGroqProvider(o: GroqOptions): SttProvider {
  const url = `${o.baseUrl ?? "https://api.groq.com/openai/v1"}/audio/transcriptions`;
  return {
    id: `groq/${o.model}`,
    async transcribe(audio, opts: SttOptions): Promise<SttResult> {
      const a = await loadAudio(audio, opts.format);
      const build = (): RequestInit => {
        const form = new FormData();
        form.set("file", new Blob([new Uint8Array(a.bytes)], { type: a.mime }), a.filename);
        form.set("model", o.model);
        form.set("response_format", "verbose_json");
        form.set("temperature", "0");
        if (opts.language) form.set("language", opts.language);
        if (opts.prompt) form.set("prompt", opts.prompt);
        return { method: "POST", headers: { Authorization: `Bearer ${o.apiKey}` }, body: form };
      };
      const res = await fetchWithRetry(url, build, { provider: "groq", signal: opts.signal, ...o.retry }, o.fetchImpl);
      const parsed = parseVerboseJson((await res.json()) as VerboseJson);
      const durationMs = Math.round((parsed.duration ?? parsed.segments.at(-1)?.end ?? 0) * 1000);
      return {
        text: parsed.text,
        segments: parsed.segments,
        language: parsed.language,
        durationMs,
        costUsd: groqCostUsd(o.model, durationMs / 1000),
      };
    },
  };
}
