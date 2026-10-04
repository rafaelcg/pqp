import { describe, expect, it, vi } from "vitest";
import {
  MIC_TEST_MS,
  startMicLoopback,
  type MicLoopbackDeps,
  type MicLoopbackOptions,
} from "@/components/settings/voice-section";
import { defaultMicProcessing } from "@/lib/audio-devices";

/** The audio graph, recorded: who connected to whom, and what was closed. */
function fakeAudio() {
  const connections: string[] = [];
  const node = (name: string) => ({
    name,
    connect: (to: { name: string }) => {
      connections.push(`${name}->${to.name}`);
    },
    disconnect: () => undefined,
  });
  const gain = { ...node("gain"), gain: { value: 1 } };
  const destination = { ...node("destination"), stream: { id: "processed" } };
  const context = {
    closed: false,
    createMediaStreamSource: vi.fn(() => node("source")),
    createGain: vi.fn(() => gain),
    createMediaStreamDestination: vi.fn(() => destination),
    close: vi.fn(async () => {
      context.closed = true;
    }),
  };
  const tracks = [
    { stop: vi.fn(), applyConstraints: vi.fn(async () => undefined) },
  ];
  const stream = {
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
  };
  const element = {
    srcObject: null as unknown,
    volume: 1,
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
  };
  return { connections, gain, context, tracks, stream, element };
}

type Fake = ReturnType<typeof fakeAudio>;

function deps(fake: Fake, overrides: Partial<MicLoopbackDeps> = {}) {
  const timers: { run: () => void; ms: number }[] = [];
  const base: MicLoopbackDeps = {
    getUserMedia: vi.fn(async () => fake.stream as unknown as MediaStream),
    createContext: vi.fn(() => fake.context as unknown as AudioContext),
    advancedSupported: () => true,
    createSuppressor: vi.fn(async () => ({
      name: "rnnoise",
      connect: (to: { name: string }) => {
        fake.connections.push(`rnnoise->${to.name}`);
      },
      disconnect: () => undefined,
      destroy: vi.fn(),
    })) as unknown as MicLoopbackDeps["createSuppressor"],
    createAudio: () => fake.element as unknown as HTMLAudioElement,
    setSink: vi.fn(async () => undefined),
    setTimer: (run, ms) => {
      timers.push({ run, ms });
      return timers.length;
    },
    clearTimer: vi.fn(),
  };
  return { deps: { ...base, ...overrides }, timers };
}

const options = (
  overrides: Partial<MicLoopbackOptions> = {},
): MicLoopbackOptions => ({
  deviceId: "mic-1",
  processing: defaultMicProcessing,
  inputVolume: 1.5,
  outputDeviceId: "speakers-2",
  outputVolume: 0.4,
  onEnd: vi.fn(),
  ...overrides,
});

describe("startMicLoopback (Ouvir meu mic)", () => {
  it("opens the chosen mic with the call's processing and plays it to the chosen output", async () => {
    const fake = fakeAudio();
    const { deps: d } = deps(fake);
    const loop = startMicLoopback(options(), d);
    await loop.ready;

    expect(d.getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: { exact: "mic-1" },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    expect(fake.gain.gain.value).toBe(1.5);
    expect(fake.connections).toEqual(["source->gain", "gain->destination"]);
    expect(fake.element.srcObject).toEqual({ id: "processed" });
    expect(fake.element.volume).toBe(0.4);
    expect(d.setSink).toHaveBeenCalledWith(fake.element, "speakers-2");
    expect(fake.element.play).toHaveBeenCalled();
    expect(d.createSuppressor).not.toHaveBeenCalled();
  });

  it("stops by itself after five seconds and releases the mic", async () => {
    const fake = fakeAudio();
    const { deps: d, timers } = deps(fake);
    const opts = options();
    const loop = startMicLoopback(opts, d);
    await loop.ready;

    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(MIC_TEST_MS);
    expect(MIC_TEST_MS).toBe(5000);
    expect(opts.onEnd).not.toHaveBeenCalled();

    timers[0]!.run();

    expect(fake.tracks[0]!.stop).toHaveBeenCalled();
    expect(fake.context.close).toHaveBeenCalled();
    expect(fake.element.pause).toHaveBeenCalled();
    expect(fake.element.srcObject).toBeNull();
    expect(opts.onEnd).toHaveBeenCalledTimes(1);
  });

  it("stops early on demand, once", async () => {
    const fake = fakeAudio();
    const { deps: d } = deps(fake);
    const opts = options();
    const loop = startMicLoopback(opts, d);
    await loop.ready;

    loop.stop();
    loop.stop();

    expect(d.clearTimer).toHaveBeenCalledTimes(1);
    expect(fake.tracks[0]!.stop).toHaveBeenCalledTimes(1);
    expect(opts.onEnd).toHaveBeenCalledTimes(1);
  });

  it("releases a mic that opens after it was already stopped", async () => {
    const fake = fakeAudio();
    let grant: (stream: MediaStream) => void = () => undefined;
    const { deps: d } = deps(fake, {
      getUserMedia: () =>
        new Promise<MediaStream>((resolve) => {
          grant = resolve;
        }),
    });
    const opts = options();
    const loop = startMicLoopback(opts, d);

    loop.stop();
    expect(opts.onEnd).toHaveBeenCalledTimes(1);

    grant(fake.stream as unknown as MediaStream);
    await loop.ready;

    expect(fake.tracks[0]!.stop).toHaveBeenCalled();
    expect(d.createContext).not.toHaveBeenCalled();
    expect(fake.element.play).not.toHaveBeenCalled();
  });

  it("runs Voz limpa between the mic and the gain when it is on", async () => {
    const fake = fakeAudio();
    const { deps: d } = deps(fake);
    const loop = startMicLoopback(
      options({
        processing: { ...defaultMicProcessing, noiseSuppression: "advanced" },
      }),
      d,
    );
    await loop.ready;

    // The browser's suppressor is off in advanced mode; RNNoise does the job.
    expect(d.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.objectContaining({ noiseSuppression: false }),
      }),
    );
    expect(d.createContext).toHaveBeenCalledWith(true);
    expect(fake.connections).toEqual([
      "source->rnnoise",
      "rnnoise->gain",
      "gain->destination",
    ]);
  });

  it("falls back to the browser's suppressor when Voz limpa cannot load", async () => {
    const fake = fakeAudio();
    const { deps: d } = deps(fake, {
      createSuppressor: async () => {
        throw new Error("no worklet");
      },
    });
    const loop = startMicLoopback(
      options({
        processing: { ...defaultMicProcessing, noiseSuppression: "advanced" },
      }),
      d,
    );
    await loop.ready;

    expect(fake.tracks[0]!.applyConstraints).toHaveBeenCalledWith({
      noiseSuppression: true,
    });
    expect(fake.connections).toEqual(["source->gain", "gain->destination"]);
  });

  it("rejects and ends when the mic cannot be opened", async () => {
    const fake = fakeAudio();
    const { deps: d } = deps(fake, {
      getUserMedia: async () => {
        throw new DOMException("denied", "NotAllowedError");
      },
    });
    const opts = options();
    const loop = startMicLoopback(opts, d);

    await expect(loop.ready).rejects.toThrow("denied");
    expect(opts.onEnd).toHaveBeenCalledTimes(1);
    expect(fake.element.play).not.toHaveBeenCalled();
  });

  it("uses the system default devices when none is chosen", async () => {
    const fake = fakeAudio();
    const { deps: d } = deps(fake);
    const loop = startMicLoopback(
      options({ deviceId: "", outputDeviceId: "" }),
      d,
    );
    await loop.ready;

    const call = (d.getUserMedia as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.audio).not.toHaveProperty("deviceId");
    expect(d.setSink).toHaveBeenCalledWith(fake.element, "");
  });
});
