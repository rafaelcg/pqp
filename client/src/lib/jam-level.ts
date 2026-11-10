/**
 * The studio's level meter: how loud what the microphone hears is, and what to
 * tell the player about it. The meter reads the input's own stream through an
 * analyser on the engine's context; it never touches what the engine records.
 */

export type JamLevelVerdict = "silent" | "low" | "good" | "hot";

/**
 * A peak in 0..1 (full scale is 1) as advice. Below a whisper is "silent" (the
 * wrong input, a muted device, nothing plugged in); a take recorded that low
 * is mostly noise floor. Within a few percent of full scale is "hot": a note
 * that clips cannot be repaired afterwards.
 */
export function levelVerdict(peak: number): JamLevelVerdict {
  if (!(peak > 0.01)) {
    return "silent";
  }
  if (peak < 0.08) {
    return "low";
  }
  if (peak >= 0.97) {
    return "hot";
  }
  return "good";
}

/**
 * The meter's bar, 0..1, from a peak. A square root so quiet playing moves it:
 * a linear bar leaves a soft guitar at a few percent of the width, which reads
 * as "nothing is coming in".
 */
export function levelBar(peak: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, peak)));
}

export interface JamLevelMeter {
  /** The loudest sample since the last read, 0..1. */
  read(): number;
  close(): void;
}

export function createLevelMeter(context: AudioContext, stream: MediaStream): JamLevelMeter {
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  // An analyser nothing pulls on is not always processed; a muted tail to the
  // destination makes it run without a sound leaving the speakers.
  const mute = context.createGain();
  mute.gain.value = 0;
  analyser.connect(mute);
  mute.connect(context.destination);
  const buffer = new Float32Array(analyser.fftSize);
  return {
    read() {
      analyser.getFloatTimeDomainData(buffer);
      let peak = 0;
      for (let i = 0; i < buffer.length; i++) {
        const value = Math.abs(buffer[i] ?? 0);
        if (value > peak) {
          peak = value;
        }
      }
      return peak;
    },
    close() {
      try {
        source.disconnect();
        analyser.disconnect();
        mute.disconnect();
      } catch {
        // Already gone.
      }
    },
  };
}
