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
};

export function languageLabel(code: string): string {
  return LANGUAGE_LABEL[code.toLowerCase()] ?? code;
}

export const DEFAULT_KEEP_NAMES = ["pqp", "pqp.gg", "Baú", "QG", "watch party", "MoonKase", "LiveKit", "Discord", "Twitch"];

export function buildSystemPrompt(from: string, to: string, keepNames: string[]): string {
  return [
    `You translate ${languageLabel(from)} into ${languageLabel(to)}.`,
    "The input is a JSON array of strings. Reply with ONLY a JSON array of strings: same length, same order, one translation per input string. No code fences, no keys, no notes.",
    "Translate meaning and tone, not word for word. Keep slang, jokes, exclamations and the speaker's register; use the natural equivalent slang in the target language when there is one.",
    `Never translate or alter these proper nouns and product words: ${keepNames.join(", ")}. Keep usernames, @handles, URLs, emoji and numbers exactly as they are.`,
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
    return { content: json.choices?.[0]?.message?.content ?? "", cost: json.usage?.cost ?? 0 };
  }

  return {
    id: `openrouter-chat/${o.model}`,
    async translate(texts, from, to, signal): Promise<TranslateResult> {
      if (texts.length === 0) return { texts: [], costUsd: 0 };
      let cost = 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await call(texts, from, to, signal);
        cost += r.cost;
        const parsed = parseStringArray(r.content);
        if (parsed && parsed.length === texts.length) return { texts: parsed, costUsd: cost };
      }
      // The model keeps merging or splitting entries: fall back to one request per string, which cannot misalign.
      const out: string[] = [];
      for (const t of texts) {
        const r = await call([t], from, to, signal);
        cost += r.cost;
        const parsed = parseStringArray(r.content);
        out.push(parsed?.length === 1 ? (parsed[0] as string) : r.content.trim());
      }
      return { texts: out, costUsd: cost };
    },
  };
}
