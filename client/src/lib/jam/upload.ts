import { encodeFlacAsync } from "./flac";
import { computePeaks } from "./peaks";
import type { JamTake } from "./recorder";

/**
 * A take turned into what the server stores per track. Field names follow
 * the server contract (`offset_ms`, `trim_start_ms`, ...) in camelCase; the
 * caller maps them onto the request.
 *
 * Audio is FLAC, 16-bit, mono, at the context's sample rate: lossless, so the
 * round trip through the server moves the audio by exactly zero samples in
 * every browser we measured, where every lossy codec we measured moved it
 * by a codec- and browser-dependent amount (see docs/JAM_ENGINE.md for the
 * table). The cost is size: roughly 2.5 to 5 MB a minute of playing, a lot
 * less for a part with rests in it.
 */
export interface JamStemUpload {
  audio: Blob;
  /** The camera file, its own audio still inside (never played; the player mutes it). */
  video: Blob | null;
  offsetMs: number;
  trimStartMs: number;
  trimEndMs: number;
  /** Whole buffer, ms (may be fractional; the server can round, a sub-ms tail is inaudible). */
  durationMs: number;
  sampleRate: number;
  gain: number;
  peaks: number[];
}

export const STEM_AUDIO_MIME = "audio/flac";

export async function prepareStemUpload(
  take: Pick<JamTake, "samples" | "sampleRate" | "offsetMs" | "trimStartMs" | "trimEndMs" | "video">,
  options: { gain?: number; bitsPerSample?: 16 | 24 } = {},
): Promise<JamStemUpload> {
  const bytes = await encodeFlacAsync([take.samples], take.sampleRate, {
    bitsPerSample: options.bitsPerSample ?? 16,
  });
  return {
    audio: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: STEM_AUDIO_MIME }),
    video: take.video?.blob ?? null,
    offsetMs: take.offsetMs,
    trimStartMs: Math.round(take.trimStartMs),
    trimEndMs: Math.round(take.trimEndMs),
    durationMs: Math.round((take.samples.length / take.sampleRate) * 1000 * 1000) / 1000,
    sampleRate: take.sampleRate,
    gain: options.gain ?? 1,
    peaks: computePeaks([take.samples]),
  };
}
