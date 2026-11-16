import { encodeFlac } from "./flac";
import { encodeWav } from "./pcm";
import { type StemMix, type StemTiming, effectiveGains, planSegment, songDurationMs } from "./timeline";

/**
 * The whole song (or a stretch of it) rendered offline to a buffer or a
 * file. It schedules through the same `planSegment` as the live player, so
 * what you export is what you heard, to the sample.
 */

export interface MixdownStem {
  id: string;
  buffer: AudioBuffer;
  timing: StemTiming;
  mix: StemMix;
}

export async function renderMixdown(
  stems: ReadonlyArray<MixdownStem>,
  options: { sampleRate?: number; fromMs?: number; toMs?: number; channels?: 1 | 2 } = {},
): Promise<AudioBuffer> {
  const sampleRate = options.sampleRate ?? stems[0]?.buffer.sampleRate ?? 48000;
  const fromMs = Math.max(0, options.fromMs ?? 0);
  const toMs = options.toMs ?? songDurationMs(stems.map((s) => s.timing));
  const frames = Math.max(1, Math.round(((toMs - fromMs) / 1000) * sampleRate));
  const ctx = new OfflineAudioContext(options.channels ?? 2, frames, sampleRate);
  const gains = effectiveGains(stems.map((s) => ({ id: s.id, mix: s.mix })));
  const byId = new Map(stems.map((s) => [s.id, s]));
  for (const entry of planSegment(
    stems.map((s) => ({ id: s.id, timing: s.timing })),
    fromMs,
    toMs,
    sampleRate,
  )) {
    const stem = byId.get(entry.id)!;
    const g = gains.get(entry.id) ?? 0;
    if (g === 0) continue;
    const gain = ctx.createGain();
    gain.gain.value = g;
    gain.connect(ctx.destination);
    const node = ctx.createBufferSource();
    node.buffer = stem.buffer;
    node.connect(gain);
    node.start(entry.startFrame / sampleRate, entry.bufferOffsetFrames / sampleRate, entry.durationFrames / sampleRate);
  }
  return ctx.startRendering();
}

export function bufferChannels(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
}

/** Render and encode. FLAC is lossless and about half the size of WAV. */
export async function exportMixdown(
  stems: ReadonlyArray<MixdownStem>,
  format: "flac" | "wav" = "flac",
  options: Parameters<typeof renderMixdown>[1] = {},
): Promise<Blob> {
  const buffer = await renderMixdown(stems, options);
  const channels = bufferChannels(buffer);
  // a mix can sum past full scale; soft limit is a mastering decision, a
  // clamp is honest (quantize clamps)
  const bytes =
    format === "flac" ? encodeFlac(channels, buffer.sampleRate) : encodeWav(channels, buffer.sampleRate);
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: format === "flac" ? "audio/flac" : "audio/wav" });
}
