import { loadAudio, wavDurationMs } from "../audio.js";
import { fetchWithRetry, type RetryOptions } from "../http.js";
import { parseVerboseJson } from "./groq.js";
import type { SttOptions, SttProvider, SttResult, SttSegment } from "../types.js";

export interface OpenRouterSttOptions {
  apiKey: string;
  /** OpenRouter STT slug, e.g. `openai/whisper-large-v3-turbo`, `openai/gpt-4o-transcribe`, `x-ai/grok-stt-1.0`. */
  model: string;
  baseUrl?: string;
  /**
   * Whether to ask for `verbose_json` (segments with timestamps). The gpt-4o
   * transcribe family refuses it ("Use json instead"), so the default is
   * chosen from the slug and can be overridden.
   */
  verbose?: boolean;
  /**
   * Key under `provider.options` that carries the glossary. It is
   * provider-specific on OpenRouter. Defaults to the slug's vendor prefix,
   * except Whisper slugs, which are served by `groq`, and `x-ai`, served by `xai`.
   */
  promptProviderKey?: string;
  /**
   * How the glossary is sent. `prompt` is Whisper's free-text context,
   * `keyterms` is a list of words to bias towards (the xAI style).
   */
  promptStyle?: "prompt" | "keyterms";
  /** `word` asks for word timestamps, which are regrouped into segments. Grok only returns words. */
  granularity?: "segment" | "word";
  fetchImpl?: typeof fetch;
  retry?: Partial<Pick<RetryOptions, "maxAttempts" | "baseDelayMs" | "maxDelayMs" | "sleep" | "onRetry">>;
}

const LANGUAGE_NAMES: Record<string, string> = {
  portuguese: "pt",
  english: "en",
  spanish: "es",
  french: "fr",
  german: "de",
  italian: "it",
  japanese: "ja",
  korean: "ko",
  chinese: "zh",
  russian: "ru",
  dutch: "nl",
  turkish: "tr",
  polish: "pl",
  arabic: "ar",
};

/** Whisper answers with a language name ("Portuguese") on some routes, a code ("pt") or a tag ("pt-br") on others. */
export function normalizeLanguage(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (!v) return undefined;
  if (LANGUAGE_NAMES[v]) return LANGUAGE_NAMES[v];
  const primary = v.split(/[-_]/)[0] ?? v;
  return primary.length <= 3 ? primary : undefined;
}

export function defaultVerbose(model: string): boolean {
  return !/gpt-4o|gpt-transcribe|chirp|gemini|mai-transcribe/.test(model);
}

export function defaultGranularity(model: string): "segment" | "word" {
  return /^x-ai\//.test(model) ? "word" : "segment";
}

export function defaultPromptStyle(model: string): "prompt" | "keyterms" {
  return /^x-ai\//.test(model) ? "keyterms" : "prompt";
}

export function defaultPromptKey(model: string): string {
  if (/^openai\/whisper/.test(model)) return "groq";
  if (/^x-ai\//.test(model)) return "xai";
  return model.split("/")[0] ?? "openai";
}

export interface OpenRouterSttBody {
  model: string;
  input_audio: { data: string; format: string };
  temperature: number;
  language?: string;
  response_format?: "verbose_json" | "json";
  timestamp_granularities?: string[];
  provider?: { options: Record<string, { prompt: string } | { keyterms: string[] }> };
}

type BodyOptions = Pick<OpenRouterSttOptions, "model" | "verbose" | "promptProviderKey" | "promptStyle" | "granularity">;

/** Pure request builder, exported so the offline tests pin the wire shape. */
export function buildOpenRouterSttBody(
  o: BodyOptions,
  audio: { bytes: Buffer; format: string },
  opts: SttOptions,
): OpenRouterSttBody {
  const verbose = o.verbose ?? defaultVerbose(o.model);
  const style = o.promptStyle ?? defaultPromptStyle(o.model);
  return {
    model: o.model,
    input_audio: { data: audio.bytes.toString("base64"), format: audio.format },
    temperature: 0,
    ...(opts.language ? { language: opts.language } : {}),
    response_format: verbose ? "verbose_json" : "json",
    ...(verbose ? { timestamp_granularities: [o.granularity ?? defaultGranularity(o.model)] } : {}),
    ...(opts.prompt
      ? {
          provider: {
            options: {
              [o.promptProviderKey ?? defaultPromptKey(o.model)]:
                style === "keyterms"
                  ? {
                      keyterms: opts.prompt
                        .split(/[,;\n]/)
                        .map((t) => t.trim())
                        .filter(Boolean)
                        .slice(0, 100),
                    }
                  : { prompt: opts.prompt },
            },
          },
        }
      : {}),
  };
}

interface OpenRouterSttResponse {
  text?: string;
  language?: string;
  duration?: number;
  segments?: Parameters<typeof parseVerboseJson>[0]["segments"];
  words?: Array<{ word?: string; start?: number; end?: number }>;
  usage?: { seconds?: number; cost?: number };
}

/** Regroup word timestamps into sentence-sized segments: break at . ? ! or after a pause. */
export function segmentsFromWords(
  words: Array<{ word?: string; start?: number; end?: number }>,
  maxGapSeconds = 0.8,
): SttSegment[] {
  const out: SttSegment[] = [];
  let cur: { start: number; end: number; parts: string[] } | undefined;
  const flush = () => {
    if (cur) out.push({ start: cur.start, end: cur.end, text: cur.parts.join(" ") });
    cur = undefined;
  };
  for (const w of words) {
    const text = (w.word ?? "").trim();
    if (!text) continue;
    const start = w.start ?? 0;
    const end = w.end ?? start;
    if (cur && start - cur.end > maxGapSeconds) flush();
    if (!cur) cur = { start, end, parts: [] };
    cur.parts.push(text);
    cur.end = end;
    if (/[.?!]$/.test(text)) flush();
  }
  flush();
  return out;
}

export function parseOpenRouterStt(body: OpenRouterSttResponse, fallbackDurationMs: number): SttResult {
  const parsed = parseVerboseJson(body);
  const seconds = body.duration ?? body.usage?.seconds;
  const durationMs = Math.round(((seconds ?? 0) || fallbackDurationMs / 1000) * 1000);
  const text = parsed.text;
  const fromWords = body.words?.length && parsed.segments.length <= 1 ? segmentsFromWords(body.words) : [];
  // json (non-verbose) models return text only: surface it as one segment so callers never see an empty list.
  const segments = fromWords.length
    ? fromWords
    : parsed.segments.length
      ? parsed.segments
      : text
        ? [{ start: 0, end: durationMs / 1000, text }]
        : [];
  return {
    text,
    segments,
    language: normalizeLanguage(parsed.language),
    durationMs,
    costUsd: body.usage?.cost,
  };
}

export function createOpenRouterSttProvider(o: OpenRouterSttOptions): SttProvider {
  const url = `${o.baseUrl ?? "https://openrouter.ai/api/v1"}/audio/transcriptions`;
  return {
    id: `openrouter/${o.model}`,
    async transcribe(audio, opts: SttOptions): Promise<SttResult> {
      const a = await loadAudio(audio, opts.format);
      const body = JSON.stringify(buildOpenRouterSttBody(o, a, opts));
      const res = await fetchWithRetry(
        url,
        () => ({
          method: "POST",
          headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
          body,
        }),
        { provider: "openrouter", signal: opts.signal, ...o.retry },
        o.fetchImpl,
      );
      return parseOpenRouterStt((await res.json()) as OpenRouterSttResponse, wavDurationMs(a.bytes) ?? 0);
    },
  };
}
