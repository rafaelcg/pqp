import { createHash } from "node:crypto";
import { normalizeWords } from "./chunker.js";
import { collapseLoops } from "./metrics.js";
import type { SttSegment } from "./types.js";

/**
 * Subtitles out of a transcription: pure functions, no I/O, so every rule
 * here is a unit test (`captions.test.ts`).
 *
 *   segments (Whisper, absolute seconds)
 *     -> `buildCaptionCues`   readable cues: silence and loops dropped, long
 *                             lines split, times monotonic, short cues held
 *     -> `toWebVtt`           the file a `<track>` reads
 *
 * A translation keeps the cue list and swaps only the words
 * (`applyTranslatedCueTexts`): the timings were measured on the audio, and a
 * model asked to translate text has no business moving them.
 */

export interface CaptionCue {
  /** Seconds from the start of the video. */
  start: number;
  end: number;
  text: string;
}

/** Whisper's own "I heard nothing here" at or above this drops the segment. */
export const CAPTION_NO_SPEECH_THRESHOLD = 0.6;
/** Two lines of 42, the usual broadcast limit. */
export const CAPTION_LINE_CHARS = 42;
export const CAPTION_CUE_CHARS = CAPTION_LINE_CHARS * 2;
/** A cue on screen longer than this is a wall of text; split it. */
export const CAPTION_CUE_MAX_SECONDS = 7;
/** A cue shorter than this flashes; it is held longer when the next one leaves room. */
export const CAPTION_CUE_MIN_SECONDS = 1;
/** Bounds what one video can store: a 30 minute talk is a few hundred cues. */
export const CAPTION_MAX_CUES = 2_000;

/**
 * Lines Whisper is known to invent over music and silence, learned from the
 * subtitle files it was trained on. Matched on the whole cue, normalised, so
 * a person actually saying "obrigado" is never dropped.
 */
const HALLUCINATIONS = new Set(
  [
    "legendas pela comunidade amara org",
    "legenda adriana zanotto",
    "subtitles by the amara org community",
    "subtitulos realizados por la comunidad de amara org",
    "subtitulado por la comunidad de amara org",
  ].map((line) => normalizeWords(line).join(" ")),
);

function isHallucination(text: string): boolean {
  return HALLUCINATIONS.has(normalizeWords(text).join(" "));
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Split `text` into pieces of at most `max` characters, at word boundaries when it can. */
export function splitCueText(text: string, max = CAPTION_CUE_CHARS): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    const piece = word.length > max ? word.slice(0, max) : word;
    if (!line) {
      line = piece;
    } else if (line.length + 1 + piece.length <= max) {
      line = `${line} ${piece}`;
    } else {
      out.push(line);
      line = piece;
    }
  }
  if (line) out.push(line);
  return out;
}

/**
 * Readable cues from Whisper's segments.
 *
 *   * A segment Whisper rated as probably silence, an empty one, and the
 *     known invented lines are dropped.
 *   * Repetition loops ("obrigado obrigado obrigado ...") are collapsed.
 *   * A segment longer than two lines, or longer than seven seconds, is cut
 *     into pieces, its time shared out by the length of each piece.
 *   * Times only move forward: a cue never starts before the previous one
 *     ends, and a very short cue is held up to a second when the next one
 *     leaves room.
 */
export function buildCaptionCues(segments: readonly SttSegment[]): CaptionCue[] {
  const raw: CaptionCue[] = [];
  for (const segment of segments) {
    if (typeof segment.noSpeechProb === "number" && segment.noSpeechProb >= CAPTION_NO_SPEECH_THRESHOLD) continue;
    const text = collapseLoops(segment.text.replace(/\s+/g, " ").trim()).text.trim();
    if (!text || isHallucination(text)) continue;
    const start = Math.max(0, Number.isFinite(segment.start) ? segment.start : 0);
    const end = Math.max(start, Number.isFinite(segment.end) ? segment.end : start);
    const span = end - start;
    const byChars = splitCueText(text);
    const byTime = Math.ceil(span / CAPTION_CUE_MAX_SECONDS);
    const pieces = byChars.length >= byTime ? byChars : splitCueText(text, Math.max(12, Math.ceil(text.length / byTime)));
    const total = pieces.reduce((n, p) => n + p.length, 0) || 1;
    let at = start;
    for (const piece of pieces) {
      const share = span * (piece.length / total);
      raw.push({ start: at, end: at + share, text: piece });
      at += share;
    }
  }

  const cues: CaptionCue[] = [];
  for (const cue of raw) {
    const prev = cues.at(-1);
    const start = prev ? Math.max(cue.start, prev.end) : cue.start;
    const end = Math.max(cue.end, start + 0.2);
    cues.push({ start, end, text: cue.text });
    if (cues.length >= CAPTION_MAX_CUES) break;
  }
  // Hold a short cue a little longer, never into the next one.
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    const next = cues[i + 1];
    if (cue.end - cue.start < CAPTION_CUE_MIN_SECONDS) {
      const limit = next ? next.start : Infinity;
      cue.end = Math.max(cue.end, Math.min(cue.start + CAPTION_CUE_MIN_SECONDS, limit));
    }
    cue.start = round3(cue.start);
    cue.end = round3(cue.end);
  }
  return cues;
}

/** `HH:MM:SS.mmm`, the one timestamp form every WebVTT parser accepts. */
export function vttTimestamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(h)}:${two(m)}:${two(s)}.${String(rest).padStart(3, "0")}`;
}

/** At most two lines, broken at the space nearest the middle. */
export function wrapCueText(text: string, lineChars = CAPTION_LINE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= lineChars) return flat;
  const middle = flat.length / 2;
  let best = -1;
  for (let i = 0; i < flat.length; i++) {
    if (flat[i] === " " && (best === -1 || Math.abs(i - middle) < Math.abs(best - middle))) best = i;
  }
  return best === -1 ? flat : `${flat.slice(0, best)}\n${flat.slice(best + 1)}`;
}

/**
 * Cue text is markup in WebVTT (`<b>`, `<v Name>`, entities), and a line that
 * holds `-->` is read as a timing line. Escaping `&`, `<` and `>` covers all
 * three: what a speaker said is always shown as text.
 */
export function escapeCueText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function toWebVtt(cues: readonly CaptionCue[]): string {
  const blocks = cues
    .filter((cue) => cue.text.trim() && cue.end > cue.start)
    .map((cue, i) => `${i + 1}\n${vttTimestamp(cue.start)} --> ${vttTimestamp(cue.end)}\n${escapeCueText(wrapCueText(cue.text))}`);
  return `WEBVTT\n\n${blocks.join("\n\n")}${blocks.length ? "\n" : ""}`;
}

/** md5 of the cues a translation is made from. An edit of the source (a new transcription) changes it. */
export function captionCuesHash(cues: readonly CaptionCue[]): string {
  return createHash("md5")
    .update(JSON.stringify(cues.map((cue) => [cue.start, cue.end, cue.text])), "utf8")
    .digest("hex");
}

/**
 * Batches of cue texts for one translation call each: small enough that a
 * model keeps the array aligned, big enough that a ten minute video is a
 * handful of calls.
 */
export function batchCueTexts(texts: readonly string[], maxItems = 60, maxChars = 3_000): string[][] {
  const out: string[][] = [];
  let batch: string[] = [];
  let chars = 0;
  for (const text of texts) {
    if (batch.length > 0 && (batch.length >= maxItems || chars + text.length > maxChars)) {
      out.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(text);
    chars += text.length;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

export class CaptionTranslationMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptionTranslationMismatch";
  }
}

/**
 * The translated words on the source's timings. Same length in and out or it
 * throws (a cue that moved would show the wrong line at the wrong moment); an
 * empty answer for a cue that had words is also a failure. A model that
 * answers one cue with an essay is cut to a sane length rather than trusted.
 */
export function applyTranslatedCueTexts(source: readonly CaptionCue[], texts: readonly string[]): CaptionCue[] {
  if (texts.length !== source.length) {
    throw new CaptionTranslationMismatch(`expected ${source.length} cue texts, got ${texts.length}`);
  }
  return source.map((cue, i) => {
    const text = (texts[i] ?? "").replace(/\s+/g, " ").trim();
    if (!text && cue.text.trim()) {
      throw new CaptionTranslationMismatch(`cue ${i} came back empty`);
    }
    return { start: cue.start, end: cue.end, text: text.slice(0, cue.text.length * 3 + 40) };
  });
}

/** Defensive read of a stored `cues` JSONB value. */
export function parseStoredCues(value: unknown): CaptionCue[] {
  if (!Array.isArray(value)) return [];
  const out: CaptionCue[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { start, end, text } = item as Record<string, unknown>;
    if (typeof start === "number" && typeof end === "number" && typeof text === "string") {
      out.push({ start, end, text });
    }
  }
  return out;
}
