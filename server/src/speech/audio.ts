import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export interface LoadedAudio {
  bytes: Buffer;
  format: string;
  mime: string;
  filename: string;
}

const MIME: Record<string, string> = {
  wav: "audio/wav",
  flac: "audio/flac",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  webm: "audio/webm",
  aac: "audio/aac",
};

/** Container from magic bytes, or undefined when it is not one we know. */
export function sniffFormat(b: Buffer): string | undefined {
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE") return "wav";
  if (b.length >= 4 && b.toString("ascii", 0, 4) === "fLaC") return "flac";
  if (b.length >= 4 && b.toString("ascii", 0, 4) === "OggS") return "ogg";
  if (b.length >= 3 && b.toString("ascii", 0, 3) === "ID3") return "mp3";
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "mp3";
  if (b.length >= 12 && b.toString("ascii", 4, 8) === "ftyp") return "m4a";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  return undefined;
}

/** Accepts a Buffer or a file path; resolves the container from the hint, magic bytes or extension. */
export async function loadAudio(audio: Buffer | string, formatHint?: string): Promise<LoadedAudio> {
  const bytes = typeof audio === "string" ? await readFile(audio) : audio;
  const fromPath = typeof audio === "string" ? extname(audio).slice(1).toLowerCase() : "";
  const format = (formatHint ?? sniffFormat(bytes) ?? (fromPath || "wav")).toLowerCase();
  return { bytes, format, mime: MIME[format] ?? "application/octet-stream", filename: `audio.${format}` };
}

/** Duration of a PCM WAV from its header, a fallback for when a provider omits it. */
export function wavDurationMs(b: Buffer): number | undefined {
  if (sniffFormat(b) !== "wav" || b.length < 44) return undefined;
  const byteRate = b.readUInt32LE(28);
  if (!byteRate) return undefined;
  return Math.round(((b.length - 44) / byteRate) * 1000);
}
