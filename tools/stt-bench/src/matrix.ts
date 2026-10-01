import { join } from "node:path";
import { createGroqProvider } from "../../../server/src/speech/providers/groq.js";
import { createOpenRouterSttProvider } from "../../../server/src/speech/providers/openrouter.js";
import { createWhisperCppProvider } from "../../../server/src/speech/providers/whisper-cpp.js";
import { createXaiProvider } from "../../../server/src/speech/providers/xai.js";
import type { SttProvider } from "../../../server/src/speech/types.js";
import type { BenchKeys } from "./env.js";

export type ConfigName = "auto" | "pt" | "gloss";

/** Words the product cares about: names Whisper has never seen. */
export const GLOSSARY = "pqp, watch party, MoonKase, Baú, QG, Discord, LiveKit";

export const CONFIGS: Record<ConfigName, { language?: string; prompt?: string }> = {
  auto: {},
  pt: { language: "pt" },
  gloss: { language: "pt", prompt: GLOSSARY },
};

export type Lane = "local" | "groq" | "openrouter" | "xai";

export interface ProviderSpec {
  /** Stable id used in results and the report. */
  id: string;
  lane: Lane;
  /** Notional or real price in USD per audio hour, for the report's cost column. */
  usdPerHour: number;
  priceNote: string;
  /** Whether the glossary parameter is meaningful (and accepted) for this provider. */
  glossary: boolean;
  /** Longest single request the provider accepts; longer clips are sent in back-to-back pieces. */
  maxRequestSeconds?: number;
  /** Counts toward the paid cap. */
  paid: boolean;
  make(keys: BenchKeys, onRetry: (status: number) => void): SttProvider;
}

export interface MatrixOptions {
  modelsDir: string;
  /** Only the whisper.cpp models actually present are offered. */
  whisperModels: Array<{ name: string; file: string }>;
  /** Direct xAI endpoint (Grok Voice Transcribe 2.0). Off unless the operator opts in with --xai. */
  includeXai?: boolean;
}

/**
 * Prices are what the provider documents or what OpenRouter's catalog lists at
 * the time of the run. The report also shows the cost each OpenRouter response
 * reported, which is the number that counts.
 */
export function buildMatrix(m: MatrixOptions): ProviderSpec[] {
  const out: ProviderSpec[] = [];
  for (const w of m.whisperModels) {
    out.push({
      id: `whisper-cpp/${w.name}`,
      lane: "local",
      usdPerHour: 0,
      priceNote: "free, local (Apple M5 Max, Metal)",
      glossary: true,
      paid: false,
      make: () => createWhisperCppProvider({ modelPath: join(m.modelsDir, w.file), modelName: w.name, threads: 8 }),
    });
  }
  for (const [model, price] of [
    ["whisper-large-v3-turbo", 0.04],
    ["whisper-large-v3", 0.111],
  ] as const) {
    out.push({
      id: `groq/${model}`,
      lane: "groq",
      usdPerHour: price,
      priceNote: "Groq list price; 10 s minimum billed per request; free tier is 20 req/min and 7.2k audio s/hour",
      glossary: true,
      paid: false,
      make: (keys, onRetry) =>
        createGroqProvider({
          apiKey: need(keys.GROQ, "GROQ"),
          model,
          retry: { maxAttempts: 8, maxDelayMs: 10 * 60_000, onRetry: (i) => onRetry(i.status) },
        }),
    });
  }
  for (const [model, price, gloss] of [
    ["openai/whisper-large-v3-turbo", 0.012, true],
    ["openai/whisper-large-v3", 0.027, true],
    ["openai/whisper-1", 0.36, true],
    ["openai/gpt-4o-transcribe", 0.13, true],
    ["openai/gpt-4o-mini-transcribe", 0.05, true],
    ["google/chirp-3", 0.96, false],
    ["x-ai/grok-stt-1.0", 0.1, true],
  ] as const) {
    out.push({
      id: `openrouter/${model}`,
      lane: "openrouter",
      usdPerHour: price,
      priceNote: "OpenRouter catalog rate; the real figure is each response's usage.cost",
      glossary: gloss,
      // Chirp 3 answers 400 past about a minute of audio (synchronous recognize limit).
      ...(model === "google/chirp-3" ? { maxRequestSeconds: 55 } : {}),
      paid: true,
      make: (keys, onRetry) =>
        createOpenRouterSttProvider({
          apiKey: need(keys.OPENROUTER, "OPENROUTER"),
          model,
          retry: { onRetry: (i) => onRetry(i.status) },
        }),
    });
  }
  if (m.includeXai) {
    for (const model of ["grok-voice-transcribe-2.0", "grok-voice-transcribe-1.0"] as const) {
      out.push({
        id: `xai/${model}`,
        lane: "xai",
        usdPerHour: 0.1,
        priceNote: "xAI published batch price, $0.10/hr (streaming $0.20/hr)",
        glossary: true,
        paid: true,
        make: (keys, onRetry) =>
          createXaiProvider({
            apiKey: need(keys.GROK, "GROK"),
            model,
            retry: { onRetry: (i) => onRetry(i.status) },
          }),
      });
    }
  }
  return out;
}

function need(v: string | undefined, name: string): string {
  if (!v) throw new Error(`${name} is not set in ~/.config/pqp/stt-bench.env`);
  return v;
}
