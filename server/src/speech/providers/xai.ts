import { loadAudio } from "../audio.js";
import { fetchWithRetry, type RetryOptions } from "../http.js";
import { normalizeLanguage, segmentsFromWords } from "./openrouter.js";
import type { SttOptions, SttProvider, SttResult } from "../types.js";

export type XaiModel = "grok-voice-transcribe-2.0" | "grok-voice-transcribe-1.0";

/** USD per audio hour for batch transcription, as published by xAI ($0.10/hr batch, $0.20/hr streaming). */
export const XAI_BATCH_USD_PER_HOUR = 0.1;

export interface XaiOptions {
  apiKey: string;
  model?: XaiModel;
  baseUrl?: string;
  /** Turn spoken numbers and currency into written form. Needs `language`. */
  format?: boolean;
  fetchImpl?: typeof fetch;
  retry?: Partial<Pick<RetryOptions, "maxAttempts" | "baseDelayMs" | "maxDelayMs" | "sleep" | "onRetry">>;
}

export function xaiCostUsd(durationSeconds: number): number {
  return (durationSeconds / 3600) * XAI_BATCH_USD_PER_HOUR;
}

/** Glossary string ("pqp, Baú; QG") to xAI's repeated `keyterm` fields: at most 100 terms of 50 characters. */
export function toKeyterms(glossary: string | undefined): string[] {
  if (!glossary) return [];
  return glossary
    .split(/[,;\n]/)
    .map((t) => t.trim().slice(0, 50))
    .filter(Boolean)
    .slice(0, 100);
}

interface XaiResponse {
  text?: string;
  language?: string;
  duration?: number;
  words?: Array<{ text?: string; start?: number; end?: number; speaker?: number }>;
}

export function parseXaiResponse(body: XaiResponse): SttResult {
  const segments = segmentsFromWords((body.words ?? []).map((w) => ({ word: w.text, start: w.start, end: w.end })));
  const text = (body.text ?? segments.map((s) => s.text).join(" ")).trim();
  const durationMs = Math.round((body.duration ?? segments.at(-1)?.end ?? 0) * 1000);
  return {
    text,
    segments: segments.length ? segments : text ? [{ start: 0, end: durationMs / 1000, text }] : [],
    language: normalizeLanguage(body.language),
    durationMs,
    costUsd: xaiCostUsd(durationMs / 1000),
  };
}

/**
 * xAI's own speech-to-text endpoint (`POST /v1/stt`, multipart, `file` last).
 * The 2.0 model is only reachable here, OpenRouter carries 1.0 only.
 */
export function createXaiProvider(o: XaiOptions): SttProvider {
  const model = o.model ?? "grok-voice-transcribe-2.0";
  const url = `${o.baseUrl ?? "https://api.x.ai/v1"}/stt`;
  return {
    id: `xai/${model}`,
    async transcribe(audio, opts: SttOptions): Promise<SttResult> {
      const a = await loadAudio(audio, opts.format);
      const build = (): RequestInit => {
        const form = new FormData();
        form.append("model", model);
        if (opts.language) form.append("language", opts.language);
        if (o.format && opts.language) form.append("format", "true");
        for (const t of toKeyterms(opts.prompt)) form.append("keyterm", t);
        // The API requires the file to be the last field.
        form.append("file", new Blob([new Uint8Array(a.bytes)], { type: a.mime }), a.filename);
        return { method: "POST", headers: { Authorization: `Bearer ${o.apiKey}` }, body: form };
      };
      const res = await fetchWithRetry(url, build, { provider: "xai", signal: opts.signal, ...o.retry }, o.fetchImpl);
      return parseXaiResponse((await res.json()) as XaiResponse);
    },
  };
}
