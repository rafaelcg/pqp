/**
 * A cheap energy gate to sit in front of a Whisper-family provider. Whisper
 * invents text ("Obrigado por assistir", subtitle credits) when it is handed
 * silence or room noise, so a window with no real speech should never be sent.
 * This is deliberately not a VAD: it counts frames above an absolute level.
 */

export interface GateOptions {
  frameMs?: number;
  /** Frames at or above this level (dBFS, RMS over one frame) count as speech. */
  thresholdDbfs?: number;
  /** Total speech needed in a window before it is worth a request. */
  minSpeechMs?: number;
}

export interface GateResult {
  speech: boolean;
  speechMs: number;
  windowMs: number;
  rmsDbfs: number;
}

export const GATE_DEFAULTS = { frameMs: 20, thresholdDbfs: -45, minSpeechMs: 400 } as const;

/** s16le PCM, mono. */
export function toInt16(pcm: Int16Array | Buffer): Int16Array {
  if (pcm instanceof Int16Array) return pcm;
  return new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
}

function dbfs(sumSquares: number, n: number): number {
  if (n === 0 || sumSquares === 0) return -Infinity;
  return 20 * Math.log10(Math.sqrt(sumSquares / n) / 32768);
}

export function energyGate(pcm: Int16Array | Buffer, sampleRate: number, o: GateOptions = {}): GateResult {
  const samples = toInt16(pcm);
  const frameMs = o.frameMs ?? GATE_DEFAULTS.frameMs;
  const threshold = o.thresholdDbfs ?? GATE_DEFAULTS.thresholdDbfs;
  const minSpeechMs = o.minSpeechMs ?? GATE_DEFAULTS.minSpeechMs;
  const frame = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  let loud = 0;
  let total = 0;
  let all = 0;
  for (let i = 0; i < samples.length; i += frame) {
    const end = Math.min(samples.length, i + frame);
    let ss = 0;
    for (let j = i; j < end; j++) {
      const v = samples[j] as number;
      ss += v * v;
    }
    all += ss;
    total += end - i;
    if (dbfs(ss, end - i) >= threshold) loud += 1;
  }
  const speechMs = loud * frameMs;
  return {
    speech: speechMs >= minSpeechMs,
    speechMs,
    windowMs: Math.round((samples.length / sampleRate) * 1000),
    rmsDbfs: dbfs(all, total),
  };
}
