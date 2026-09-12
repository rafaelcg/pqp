import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createScreenMix,
  type AnalyserNodeLike,
  type AudioNodeLike,
  type CompressorNodeLike,
  type GainNodeLike,
} from "./screen-mix";
import { DISPLAY_GAIN_RANGE, MIC_GAIN_RANGE } from "./stream-mix-levels";

// This suite runs in `node`, with no `window`, so `readStreamMixLevels()`
// (screen-mix.ts's source for its initial gains) always falls back to its
// defaults here — deterministic, and exactly what these tests want.

class FakeTrack {
  kind: string;
  stopped = false;
  constructor(kind: string) {
    this.kind = kind;
  }
  stop() {
    this.stopped = true;
  }
}
class FakeStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
}
vi.stubGlobal("MediaStream", FakeStream);

/**
 * A fake context WITHOUT `createAnalyser` — "a fake context without these
 * nodes" the ducking code must tolerate. Every other test uses this one.
 */
function fakeContext() {
  const connections: string[] = [];
  let sources = 0;
  let gainCount = 0;
  const node = (name: string): AudioNodeLike & { name: string } => ({
    name,
    connect: () => {
      connections.push(name);
    },
    disconnect: () => {
      const idx = connections.lastIndexOf(name);
      if (idx !== -1) {
        connections.splice(idx, 1);
      }
    },
  });
  const audioParam = (initial = 0) => ({
    value: initial,
    setTargetAtTime(target: number) {
      this.value = target;
    },
  });
  const gains: (GainNodeLike & { name: string })[] = [];
  const mixed = new FakeTrack("audio");
  const closed = vi.fn();
  const compressor: CompressorNodeLike & { name: string } = {
    ...node("compressor"),
    threshold: audioParam(),
    knee: audioParam(),
    ratio: audioParam(),
    attack: audioParam(),
    release: audioParam(),
  };
  return {
    connections,
    mixed,
    closed,
    gains,
    compressor,
    context: {
      createMediaStreamSource: (stream: FakeStream) =>
        node(`${stream.getAudioTracks().length > 0 ? "src" : "empty"}${sources++}`),
      createMediaStreamDestination: () => ({
        ...node("dest"),
        stream: new FakeStream([mixed]),
      }),
      createGain: () => {
        const g = { ...node(`gain${gainCount++}`), gain: audioParam(1) };
        gains.push(g);
        return g;
      },
      createDynamicsCompressor: () => compressor,
      currentTime: 0,
      close: closed,
    },
  };
}

/** Same as `fakeContext()`, plus a controllable `AnalyserNode` for ducking. */
function fakeContextWithAnalyser(level: { value: number }) {
  const base = fakeContext();
  const analyser: AnalyserNodeLike & { name: string } = {
    name: "analyser",
    fftSize: 32,
    connect: () => {},
    disconnect: () => {},
    getFloatTimeDomainData: (buffer: Float32Array) => {
      buffer.fill(level.value);
    },
  };
  return {
    ...base,
    analyser,
    context: {
      ...base.context,
      createAnalyser: () => analyser,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createScreenMix", () => {
  it("publishes the display video with ONE mixed audio track", () => {
    const f = fakeContext();
    const video = new FakeTrack("video");
    const display = new FakeStream([video, new FakeTrack("audio")]);
    const mic = new FakeStream([new FakeTrack("audio")]);
    const mix = createScreenMix(
      display as unknown as MediaStream,
      mic as unknown as MediaStream,
      () => f.context as never,
    );
    expect((mix.stream as unknown as FakeStream).getVideoTracks()).toEqual([video]);
    expect((mix.stream as unknown as FakeStream).getAudioTracks()).toEqual([f.mixed]);
    // Bus wiring: compressor->dest, both gains->compressor, both
    // sources->their gain. Five connections, not the old two, now that each
    // branch has a gain stage feeding a shared limiter.
    expect(f.connections).toHaveLength(5);
    expect(mix.micIn()).toBe(true);
  });

  it("is the microphone alone when the capture had no audio", () => {
    const f = fakeContext();
    const display = new FakeStream([new FakeTrack("video")]);
    const mic = new FakeStream([new FakeTrack("audio")]);
    const mix = createScreenMix(display as never, mic as never, () => f.context as never);
    // compressor->dest, both gains->compressor, mic source->mic gain.
    expect(f.connections).toHaveLength(4);
    expect(mix.micIn()).toBe(true);
  });

  it("swaps the microphone branch on a device change, and drops it on null", () => {
    const f = fakeContext();
    const display = new FakeStream([new FakeTrack("video"), new FakeTrack("audio")]);
    const mix = createScreenMix(display as never, null, () => f.context as never);
    expect(mix.micIn()).toBe(false);
    mix.setMic(new FakeStream([new FakeTrack("audio")]) as never);
    expect(mix.micIn()).toBe(true);
    expect(f.connections).toHaveLength(5);
    mix.setMic(null);
    expect(mix.micIn()).toBe(false);
    expect(f.connections).toHaveLength(4);
  });

  it("closes the context, disconnects the whole bus and stops the mixed track", () => {
    const f = fakeContext();
    const display = new FakeStream([new FakeTrack("video"), new FakeTrack("audio")]);
    const mix = createScreenMix(display as never, null, () => f.context as never);
    mix.close();
    expect(f.mixed.stopped).toBe(true);
    expect(f.closed).toHaveBeenCalled();
    expect(f.connections).toHaveLength(0);
  });

  it("applies the default gains and limiter settings to the bus", () => {
    const f = fakeContext();
    const display = new FakeStream([new FakeTrack("video"), new FakeTrack("audio")]);
    const mic = new FakeStream([new FakeTrack("audio")]);
    createScreenMix(display as never, mic as never, () => f.context as never);
    const [displayGainNode, micGainNode] = f.gains;
    expect(displayGainNode.gain.value).toBeCloseTo(0.7);
    expect(micGainNode.gain.value).toBeCloseTo(2.0);
    expect(f.compressor.threshold.value).toBe(-6);
    expect(f.compressor.knee.value).toBe(6);
    expect(f.compressor.ratio.value).toBe(12);
    expect(f.compressor.attack.value).toBe(0.003);
    expect(f.compressor.release.value).toBe(0.25);
  });

  it("setMicGain applies live and clamps to 0.5 - 4", () => {
    const f = fakeContext();
    const display = new FakeStream([new FakeTrack("video")]);
    const mic = new FakeStream([new FakeTrack("audio")]);
    const mix = createScreenMix(display as never, mic as never, () => f.context as never);
    const [, micGainNode] = f.gains;
    mix.setMicGain(3);
    expect(micGainNode.gain.value).toBe(3);
    mix.setMicGain(100);
    expect(micGainNode.gain.value).toBe(MIC_GAIN_RANGE.max);
    mix.setMicGain(-1);
    expect(micGainNode.gain.value).toBe(MIC_GAIN_RANGE.min);
  });

  it("setDisplayGain applies live and clamps to 0.25 - 1", () => {
    const f = fakeContext();
    const display = new FakeStream([new FakeTrack("video"), new FakeTrack("audio")]);
    const mix = createScreenMix(display as never, null, () => f.context as never);
    const [displayGainNode] = f.gains;
    mix.setDisplayGain(0.9);
    expect(displayGainNode.gain.value).toBe(0.9);
    mix.setDisplayGain(5);
    expect(displayGainNode.gain.value).toBe(DISPLAY_GAIN_RANGE.max);
    mix.setDisplayGain(0);
    expect(displayGainNode.gain.value).toBe(DISPLAY_GAIN_RANGE.min);
  });

  it("ducks the display branch while the mic is loud, and restores it after 600ms of silence", () => {
    vi.useFakeTimers();
    const level = { value: 0 };
    const f = fakeContextWithAnalyser(level);
    const display = new FakeStream([new FakeTrack("video"), new FakeTrack("audio")]);
    const mic = new FakeStream([new FakeTrack("audio")]);
    const mix = createScreenMix(display as never, mic as never, () => f.context as never);
    const [displayGainNode] = f.gains;
    const base = displayGainNode.gain.value;
    expect(base).toBeCloseTo(0.7);

    // Quiet: no ducking yet.
    vi.advanceTimersByTime(50);
    expect(displayGainNode.gain.value).toBeCloseTo(base);

    // Loud (well above -40 dBFS): ducks by another -6 dB.
    level.value = 0.5;
    vi.advanceTimersByTime(50);
    expect(displayGainNode.gain.value).toBeCloseTo(base * 0.5);

    // Quiet again, but not for 600ms yet: stays ducked.
    level.value = 0;
    vi.advanceTimersByTime(300);
    expect(displayGainNode.gain.value).toBeCloseTo(base * 0.5);

    // 600ms of silence since the last loud sample: restores.
    vi.advanceTimersByTime(300);
    expect(displayGainNode.gain.value).toBeCloseTo(base);

    mix.close();
  });
});
