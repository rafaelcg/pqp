/** Shared helpers for WebRTC ICE / speaking detection. */

const SPEAKING_THRESHOLD = 0.045;
const SPEAKING_HANGOVER_MS = 280;

/**
 * Chrome caps a page at roughly six AudioContexts. Creating one per remote peer
 * meant a full mesh could exhaust the budget and silently stop metering, so all
 * analysers share a single context.
 */
let sharedContext: AudioContext | null = null;
let sharedContextRefs = 0;

function acquireContext(): AudioContext {
  if (!sharedContext || sharedContext.state === "closed") {
    sharedContext = new AudioContext();
  }
  sharedContextRefs += 1;
  return sharedContext;
}

function releaseContext(): void {
  sharedContextRefs = Math.max(0, sharedContextRefs - 1);
  if (sharedContextRefs === 0 && sharedContext) {
    const context = sharedContext;
    sharedContext = null;
    void context.close().catch(() => {});
  }
}

/** Reused across frames — the meter runs on every animation frame. */
const levelBuffers = new WeakMap<AnalyserNode, Uint8Array<ArrayBuffer>>();

export function readAnalyserLevel(analyser: AnalyserNode): number {
  let data = levelBuffers.get(analyser);
  if (!data || data.length !== analyser.frequencyBinCount) {
    data = new Uint8Array(analyser.frequencyBinCount);
    levelBuffers.set(analyser, data);
  }
  analyser.getByteFrequencyData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i]!;
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
  const context = acquireContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.65;
  source.connect(analyser);

  let disposed = false;
  return {
    analyser,
    context,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        // Context may already be closing.
      }
      releaseContext();
    },
  };
}
