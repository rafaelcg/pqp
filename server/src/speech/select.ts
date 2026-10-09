import { createGroqProvider } from "./providers/groq.js";
import { createReplayProvider } from "./providers/replay.js";
import { createWorkersAiProvider } from "./providers/workers-ai.js";
import type { SttProvider } from "./types.js";

/**
 * Which speech-to-text provider the product uses, from `VOICE_STT_PROVIDER`:
 *
 *   * `none` (or unset): no provider. Every transcription job settles as
 *     `unavailable`, with no network call. The default, and what a self-host
 *     gets until its operator picks one.
 *   * `workers-ai`: Cloudflare Workers AI, `@cf/openai/whisper-large-v3-turbo`
 *     (the hosted choice). Needs `CLOUDFLARE_AI_ACCOUNT_ID` and
 *     `CLOUDFLARE_AI_API_TOKEN`.
 *   * `groq`: Groq's `whisper-large-v3-turbo`. Needs `GROQ_API_KEY`.
 *   * `replay`: canned text (`VOICE_STT_REPLAY_TEXT`), for the multi-process
 *     tests, which cannot inject a fake into a child. Refused under
 *     `NODE_ENV=production`, so it can never answer for a real recording.
 *
 * A name with its credentials missing is `none`, said once in the log: the
 * failure of a missing secret must be "no transcripts", never a crash loop.
 * Read on every call (it is a handful of env reads) so a test can switch it.
 *
 * The keys live on the worker only (`tools/api-host/compose.yaml`): the API
 * never calls a provider, it only queues jobs.
 */

export type SttProviderName = "none" | "workers-ai" | "groq" | "replay";

export interface SelectedSttProvider {
  name: Exclude<SttProviderName, "none">;
  provider: SttProvider;
}

let warned = new Set<string>();
let override: SttProvider | null | undefined;
let cached: { key: string; selected: SelectedSttProvider | null } | null = null;

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[speech] ${message}`);
}

export function sttProviderName(env: NodeJS.ProcessEnv = process.env): SttProviderName {
  const raw = (env.VOICE_STT_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "" || raw === "none" || raw === "off") return "none";
  if (raw === "workers-ai" || raw === "groq" || raw === "replay") return raw;
  warnOnce(`unknown VOICE_STT_PROVIDER=${raw}; transcription is off. Supported: none, workers-ai, groq.`);
  return "none";
}

function build(env: NodeJS.ProcessEnv): SelectedSttProvider | null {
  const name = sttProviderName(env);
  switch (name) {
    case "none":
      return null;
    case "workers-ai": {
      const accountId = env.CLOUDFLARE_AI_ACCOUNT_ID?.trim();
      const apiToken = env.CLOUDFLARE_AI_API_TOKEN?.trim();
      if (!accountId || !apiToken) {
        warnOnce("VOICE_STT_PROVIDER=workers-ai without CLOUDFLARE_AI_ACCOUNT_ID / CLOUDFLARE_AI_API_TOKEN; transcription is off.");
        return null;
      }
      return {
        name,
        // Cloudflare's own voice activity detection first: Whisper invents
        // text on silence, and a voice note can be mostly breath.
        provider: createWorkersAiProvider({ accountId, apiToken, vadFilter: true, retry: { maxAttempts: 3 } }),
      };
    }
    case "groq": {
      const apiKey = env.GROQ_API_KEY?.trim();
      if (!apiKey) {
        warnOnce("VOICE_STT_PROVIDER=groq without GROQ_API_KEY; transcription is off.");
        return null;
      }
      return {
        name,
        provider: createGroqProvider({ apiKey, model: "whisper-large-v3-turbo", retry: { maxAttempts: 3 } }),
      };
    }
    case "replay": {
      if (env.NODE_ENV === "production") {
        warnOnce("VOICE_STT_PROVIDER=replay is for tests and is refused in production; transcription is off.");
        return null;
      }
      const text = env.VOICE_STT_REPLAY_TEXT ?? "";
      return {
        name,
        provider: createReplayProvider({
          cues: text ? [{ start: 0, end: 1, text, noSpeechProb: 0.01 }] : [],
          language: env.VOICE_STT_REPLAY_LANGUAGE || "pt",
        }),
      };
    }
  }
}

/** The configured provider, or null for `none` (jobs then settle `unavailable`). */
export function selectSttProvider(env: NodeJS.ProcessEnv = process.env): SelectedSttProvider | null {
  if (override !== undefined) {
    return override ? { name: "replay", provider: override } : null;
  }
  const key = [
    env.VOICE_STT_PROVIDER,
    env.CLOUDFLARE_AI_ACCOUNT_ID,
    env.CLOUDFLARE_AI_API_TOKEN,
    env.GROQ_API_KEY,
    env.VOICE_STT_REPLAY_TEXT,
    env.VOICE_STT_REPLAY_LANGUAGE,
    env.NODE_ENV,
  ].join("\u0000");
  if (cached?.key !== key) {
    cached = { key, selected: build(env) };
  }
  return cached.selected;
}

/**
 * Tests only: a fake in place of whatever the environment names. `null` means
 * "no provider" (the `none` path); `undefined` puts the environment back.
 */
export function setSttProviderForTests(provider: SttProvider | null | undefined): void {
  override = provider;
  cached = null;
  warned = new Set();
}
