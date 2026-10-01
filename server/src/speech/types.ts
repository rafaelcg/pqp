/**
 * Provider-agnostic speech types. Nothing in here is wired into the product
 * yet: the module exists so the STT bench (`tools/stt-bench`) and, later, the
 * live-subtitle path can swap providers without touching callers.
 */

export interface SttSegment {
  /** Seconds from the start of the audio handed to `transcribe`. */
  start: number;
  end: number;
  text: string;
  /** Whisper-family confidence signals, present when the provider returns them. */
  noSpeechProb?: number;
  avgLogprob?: number;
}

export interface SttOptions {
  /** ISO-639-1 code. Omit to let the provider auto-detect. */
  language?: string;
  /** Glossary / context hint (proper nouns). Providers cap it, Whisper at about 224 tokens. */
  prompt?: string;
  /** Container of an in-memory buffer ("wav", "flac", "ogg", ...). Sniffed when omitted. */
  format?: string;
  signal?: AbortSignal;
}

export interface SttResult {
  text: string;
  segments: SttSegment[];
  language?: string;
  durationMs: number;
  /** Reported by the provider when it says so, otherwise computed from a price table. */
  costUsd?: number;
}

export interface SttProvider {
  id: string;
  /** `audio` is a Buffer or a path to a file on disk. */
  transcribe(audio: Buffer | string, opts: SttOptions): Promise<SttResult>;
}

export interface TranslateResult {
  texts: string[];
  costUsd?: number;
}

export interface Translator {
  id: string;
  /** Same length and order in and out. `from` / `to` are ISO-639-1 codes. */
  translate(texts: string[], from: string, to: string, signal?: AbortSignal): Promise<TranslateResult>;
}

/** Thrown by providers on a non-retryable or exhausted-retry HTTP failure. Never carries a key. */
export class SpeechHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
  ) {
    super(`${provider} HTTP ${status}: ${message}`);
    this.name = "SpeechHttpError";
  }
}
