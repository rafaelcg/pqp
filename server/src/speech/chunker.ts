import type { SttOptions, SttProvider, SttSegment } from "./types.js";

/**
 * Windowing for the live path: the product sends short overlapping windows
 * (about 8 s, 1 s overlap) rather than whole files. This file plans the
 * windows, runs a provider over them and stitches the answers back into one
 * timeline without the doubled words the overlap produces.
 */

export interface WindowSpec {
  windowMs: number;
  overlapMs: number;
}

export const DEFAULT_WINDOW: WindowSpec = { windowMs: 8000, overlapMs: 1000 };

export interface AudioWindow {
  index: number;
  startMs: number;
  endMs: number;
}

export function planWindows(totalMs: number, spec: WindowSpec = DEFAULT_WINDOW): AudioWindow[] {
  if (spec.overlapMs >= spec.windowMs) throw new Error("overlap must be smaller than the window");
  if (totalMs <= 0) return [];
  const stride = spec.windowMs - spec.overlapMs;
  const out: AudioWindow[] = [];
  for (let start = 0; ; start += stride) {
    const end = Math.min(start + spec.windowMs, totalMs);
    // A trailing sliver that is only overlap adds nothing: the previous window already heard it.
    if (out.length > 0 && end - start <= spec.overlapMs) break;
    out.push({ index: out.length, startMs: start, endMs: end });
    if (end >= totalMs) break;
  }
  return out;
}

export interface WindowResult {
  window: AudioWindow;
  /** Seconds, relative to the window's own start (what a provider returns). */
  segments: SttSegment[];
}

/** Lowercase, accent-folded, punctuation-free tokens. Used for overlap matching and by the bench's WER. */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Drop from `next` the words it repeats from the end of `prev`. Only called
 * when the two segments overlap in time, so a speaker legitimately saying
 * "não, não" is not collapsed.
 */
export function dedupeOverlap(prev: string, next: string, maxWords = 12): string {
  const a = normalizeWords(prev);
  const rawNext = next.trim().split(/\s+/).filter(Boolean);
  const b = rawNext.map((w) => normalizeWords(w).join(""));
  const limit = Math.min(maxWords, a.length, b.length);
  for (let n = limit; n >= 1; n--) {
    let same = true;
    for (let i = 0; i < n; i++) {
      if (a[a.length - n + i] !== b[i]) {
        same = false;
        break;
      }
    }
    if (same) return rawNext.slice(n).join(" ");
  }
  return next.trim();
}

/**
 * Merge per-window answers into one absolute timeline. Each window owns the
 * segments whose midpoint lies on its side of the cut (the middle of each
 * overlap), then the text that still repeats across a cut is trimmed.
 */
export function stitchWindows(results: WindowResult[]): SttSegment[] {
  const ordered = [...results].sort((x, y) => x.window.startMs - y.window.startMs);
  const kept: SttSegment[] = [];
  for (let k = 0; k < ordered.length; k++) {
    const cur = ordered[k] as WindowResult;
    const prev = ordered[k - 1];
    const next = ordered[k + 1];
    const lo = prev ? (cur.window.startMs + prev.window.endMs) / 2 / 1000 : -Infinity;
    const hi = next ? (next.window.startMs + cur.window.endMs) / 2 / 1000 : Infinity;
    for (const s of cur.segments) {
      const start = s.start + cur.window.startMs / 1000;
      const end = s.end + cur.window.startMs / 1000;
      const mid = (start + end) / 2;
      if (mid < lo || mid >= hi) continue;
      kept.push({ ...s, start, end });
    }
  }
  const out: SttSegment[] = [];
  for (const seg of kept) {
    const last = out.at(-1);
    if (last && seg.start < last.end + 0.25) {
      const text = dedupeOverlap(last.text, seg.text);
      if (!text) continue;
      out.push({ ...seg, text });
    } else {
      out.push(seg);
    }
  }
  return out;
}

export interface ChunkedWindowInfo {
  window: AudioWindow;
  skipped: boolean;
  latencyMs: number;
  costUsd: number;
  text: string;
}

export interface ChunkedResult {
  text: string;
  segments: SttSegment[];
  windows: ChunkedWindowInfo[];
  requests: number;
  costUsd: number;
}

export interface ChunkedOptions {
  provider: SttProvider;
  windows: AudioWindow[];
  /** Returns the audio of one window as a Buffer or a path. */
  readWindow: (w: AudioWindow) => Promise<Buffer | string>;
  sttOpts?: SttOptions;
  /** Return false to skip the request (energy gate). */
  gate?: (w: AudioWindow, audio: Buffer | string) => boolean | Promise<boolean>;
  /**
   * Feed the tail of what was already heard back as the next prompt. This is
   * the usual streaming trick for continuity, and it makes windows sequential.
   */
  carryPromptChars?: number;
  /** Always sent first in the prompt, ahead of any carried text. */
  glossary?: string;
  signal?: AbortSignal;
  now?: () => number;
}

/** Sequential on purpose: it is what the live path does, and what rate limits see. */
export async function transcribeChunked(o: ChunkedOptions): Promise<ChunkedResult> {
  const now = o.now ?? Date.now;
  const results: WindowResult[] = [];
  const infos: ChunkedWindowInfo[] = [];
  let heard = "";
  let cost = 0;
  let requests = 0;
  for (const w of o.windows) {
    o.signal?.throwIfAborted();
    const audio = await o.readWindow(w);
    if (o.gate && !(await o.gate(w, audio))) {
      infos.push({ window: w, skipped: true, latencyMs: 0, costUsd: 0, text: "" });
      continue;
    }
    const carried = o.carryPromptChars && heard ? heard.slice(-o.carryPromptChars) : "";
    const prompt = [o.glossary, carried].filter(Boolean).join(" ").trim() || undefined;
    const t0 = now();
    const r = await o.provider.transcribe(audio, { ...o.sttOpts, ...(prompt ? { prompt } : {}), signal: o.signal });
    const latencyMs = now() - t0;
    requests += 1;
    cost += r.costUsd ?? 0;
    results.push({ window: w, segments: r.segments });
    infos.push({ window: w, skipped: false, latencyMs, costUsd: r.costUsd ?? 0, text: r.text });
    heard = `${heard} ${r.text}`.trim();
  }
  const segments = stitchWindows(results);
  return { text: segments.map((s) => s.text).join(" ").trim(), segments, windows: infos, requests, costUsd: cost };
}
