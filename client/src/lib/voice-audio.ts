/** Shared helpers for WebRTC ICE / speaking detection. */

const SPEAKING_THRESHOLD = 0.045;
const SPEAKING_HANGOVER_MS = 280;

export function readAnalyserLevel(analyser: AnalyserNode): number {
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  let sum = 0;
  for (const value of data) {
    sum += value;
  }
  return sum / data.length / 255;
}

export function createSpeakingTracker(options?: {
  threshold?: number;
  hangoverMs?: number;
}) {
  const threshold = options?.threshold ?? SPEAKING_THRESHOLD;
  const hangoverMs = options?.hangoverMs ?? SPEAKING_HANGOVER_MS;
  const lastSpokeAt = new Map<string, number>();

  function update(id: string, level: number, active: boolean): boolean {
    if (!active) {
      lastSpokeAt.delete(id);
      return false;
    }
    const now = performance.now();
    if (level >= threshold) {
      lastSpokeAt.set(id, now);
      return true;
    }
    const last = lastSpokeAt.get(id);
    if (last !== undefined && now - last < hangoverMs) {
      return true;
    }
    lastSpokeAt.delete(id);
    return false;
  }

  function clear() {
    lastSpokeAt.clear();
  }

  return { update, clear };
}

export function createStreamAnalyser(stream: MediaStream): {
  analyser: AnalyserNode;
  context: AudioContext;
  dispose: () => void;
} | null {
  const track = stream.getAudioTracks()[0];
  if (!track) {
    return null;
  }
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.65;
  source.connect(analyser);
  return {
    analyser,
    context,
    dispose() {
      void context.close();
    },
  };
}
