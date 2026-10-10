import { fetchWithRetry, type RetryOptions } from "../http.js";
import type { TranslateResult, Translator } from "../types.js";

export interface OpenRouterChatTranslatorOptions {
  apiKey: string;
  /** Chat slug, e.g. `anthropic/claude-haiku-4.5`. */
  model: string;
  baseUrl?: string;
  /** Proper nouns that must come through untouched. */
  keepNames?: string[];
  fetchImpl?: typeof fetch;
  retry?: Partial<Pick<RetryOptions, "maxAttempts" | "baseDelayMs" | "maxDelayMs" | "sleep" | "onRetry">>;
}

const LANGUAGE_LABEL: Record<string, string> = {
  pt: "Brazilian Portuguese",
  en: "English",
  es: "Spanish (neutral Latin American)",
  fr: "French",
  de: "German",
  it: "Italian",
  /** "I could not tell": the model works the source language out itself. */
  auto: "whatever language the input is written in",
};

export function languageLabel(code: string): string {
  return LANGUAGE_LABEL[code.toLowerCase()] ?? code;
}

export const DEFAULT_KEEP_NAMES = ["pqp", "pqp.gg", "QG do pqp", "Baú", "QG", "watch party", "MoonKase", "LiveKit", "Discord", "Twitch"];

export function buildSystemPrompt(from: string, to: string, keepNames: string[]): string {
  return [
    `You translate ${languageLabel(from)} into ${languageLabel(to)}.`,
    "The input is a JSON array of strings. Reply with ONLY a JSON array of strings: same length, same order, one translation per input string. No code fences, no keys, no notes.",
    "Translate meaning and tone, not word for word. Keep slang, jokes, exclamations and the speaker's register; use the natural equivalent slang in the target language when there is one.",
    `Never translate or alter these proper nouns and product words: ${keepNames.join(", ")}. Keep usernames, @handles, URLs, emoji and numbers exactly as they are. "pqp" is the product's name, never an abbreviation or a swear word: do not expand, translate or explain it. Tokens such as <k1> or <#1> are placeholders for names and links: copy each one exactly, once for every time it appears, in the place where it belongs in the sentence.`,
    "Never add commentary, explanations, greetings, quotation marks or translator notes. Never refuse. If a string is already in the target language or is only a name, return it unchanged.",
  ].join("\n");
}

/** Pulls a JSON string array out of a reply that may be fenced or have stray prose around it. */
export function parseStringArray(content: string): string[] | undefined {
  let s = content.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1] ?? s;
  const open = s.indexOf("[");
  const close = s.lastIndexOf("]");
  if (open === -1 || close <= open) return undefined;
  try {
    const parsed: unknown = JSON.parse(s.slice(open, close + 1));
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed as string[];
  } catch {
    // fall through
  }
  return undefined;
}

export interface ChatRequestBody {
  model: string;
  temperature: number;
  messages: Array<{ role: "system" | "user"; content: string }>;
}

export function buildChatBody(model: string, texts: string[], from: string, to: string, keepNames: string[]): ChatRequestBody {
  return {
    model,
    temperature: 0,
    messages: [
      { role: "system", content: buildSystemPrompt(from, to, keepNames) },
      { role: "user", content: JSON.stringify(texts) },
    ],
  };
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { cost?: number };
}

/**
 * Thrown when a translation fails after one or more calls already succeeded
 * and were billed. `costUsd` is what those calls reported, so a caller that
 * tracks spend (a budget, a report) records it instead of a zero.
 */
export class TranslateError extends Error {
  constructor(
    message: string,
    /** Cost reported by the calls that completed before the failure (0 when none did). */
    readonly costUsd: number,
    /** True when at least one completed call did not say what it cost. */
    readonly costIncomplete: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TranslateError";
  }
}

/** One request per string in the fallback, this many at a time. */
export const FALLBACK_CONCURRENCY = 4;

export function createOpenRouterChatTranslator(o: OpenRouterChatTranslatorOptions): Translator {
  const url = `${o.baseUrl ?? "https://openrouter.ai/api/v1"}/chat/completions`;
  const keep = o.keepNames ?? DEFAULT_KEEP_NAMES;

  async function call(texts: string[], from: string, to: string, signal?: AbortSignal) {
    const body = JSON.stringify(buildChatBody(o.model, texts, from, to, keep));
    const res = await fetchWithRetry(
      url,
      () => ({
        method: "POST",
        headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
        body,
      }),
      { provider: "openrouter-chat", signal, ...o.retry },
      o.fetchImpl,
    );
    const json = (await res.json()) as ChatResponse;
    return { content: json.choices?.[0]?.message?.content ?? "", cost: json.usage?.cost };
  }

  return {
    id: `openrouter-chat/${o.model}`,
    async translate(texts, from, to, signal): Promise<TranslateResult> {
      if (texts.length === 0) return { texts: [], costUsd: 0 };
      let cost = 0;
      let unknown = false;
      const bill = (c: number | undefined) => {
        if (c === undefined) unknown = true;
        else cost += c;
      };
      // The total is undefined, not 0, when a successful call did not report what it cost.
      const total = () => (unknown ? undefined : cost);
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const r = await call(texts, from, to, signal);
          bill(r.cost);
          const parsed = parseStringArray(r.content);
          if (parsed && parsed.length === texts.length) return { texts: parsed, costUsd: total() };
        }
        // The model keeps merging or splitting entries: one request per string cannot misalign.
        // Bounded concurrency keeps the fallback from costing N serial round trips, and every
        // call that completes is billed even if a sibling fails.
        const out: string[] = new Array<string>(texts.length);
        let next = 0;
        let failure: unknown;
        const worker = async () => {
          while (failure === undefined) {
            const i = next++;
            if (i >= texts.length) return;
            try {
              const r = await call([texts[i] as string], from, to, signal);
              bill(r.cost);
              const parsed = parseStringArray(r.content);
              out[i] = parsed?.length === 1 ? (parsed[0] as string) : r.content.trim();
            } catch (e) {
              failure ??= e;
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(FALLBACK_CONCURRENCY, texts.length) }, worker));
        if (failure !== undefined) throw failure;
        return { texts: out, costUsd: total() };
      } catch (e) {
        // Nothing was billed yet: keep the original error (an abort, an HTTP error) untouched.
        if (e instanceof TranslateError || (cost === 0 && !unknown)) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw new TranslateError(msg, cost, unknown, { cause: e });
      }
    },
  };
}
