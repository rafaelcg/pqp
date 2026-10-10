import { describe, expect, it, vi } from "vitest";
import {
  MIC_TEST_MS,
  maxSensitivityPercent,
  sliderToVadThreshold,
  startMicLoopback,
  type MicLoopbackDeps,
  type MicLoopbackOptions,
} from "@/components/settings/voice-section";
import {
  deviceSelectValue,
  loneModifierName,
  mergeDefaultDevice,
  recallDeviceLabel,
  relabelStockBinding,
  rememberDeviceLabel,
  savedDeviceMissing,
} from "@/components/settings/voice-section";
import { defaultPttBinding, type PttBinding } from "@/components/voice/push-to-talk";
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
  it("taps the raw mic for the meter while it plays, and lets go when it stops", async () => {
    const fake = fakeAudio();
    const tap = {
      name: "analyser",
      fftSize: 0,
      connect: () => undefined,
      disconnect: () => undefined,
    };
    Object.assign(fake.context, { createAnalyser: vi.fn(() => tap) });
    const { deps: d } = deps(fake);
    const loop = startMicLoopback(options(), d);
    expect(loop.analyser()).toBeNull();
    await loop.ready;
    expect(loop.analyser()).toBe(tap);
    expect(fake.connections).toContain("source->analyser");
    loop.stop();
    expect(loop.analyser()).toBeNull();
  });

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

describe("mergeDefaultDevice", () => {
  const list = [
    { deviceId: "default", label: "Default - MacBook Pro Microphone (Built-in)" },
    { deviceId: "abc", label: "MacBook Pro Microphone (Built-in)" },
    { deviceId: "def", label: "Yeti Nano" },
  ];

  it("drops the browser's default entry and names the device it points at", () => {
    const merged = mergeDefaultDevice(list);
    expect(merged.devices.map((d) => d.deviceId)).toEqual(["abc", "def"]);
    expect(merged.defaultName).toBe("MacBook Pro Microphone (Built-in)");
  });

  it("reads the name after the browser's own prefix, in any language", () => {
    expect(
      mergeDefaultDevice([{ deviceId: "default", label: "Padrão - Fones" }]).defaultName,
    ).toBe("Fones");
  });

  it("keeps a label with no prefix whole, and never names a bare 'Default'", () => {
    expect(
      mergeDefaultDevice([{ deviceId: "default", label: "Fake Default Audio Input" }])
        .defaultName,
    ).toBe("Fake Default Audio Input");
    expect(
      mergeDefaultDevice([{ deviceId: "default", label: "Default" }]).defaultName,
    ).toBeNull();
  });

  it("leaves a list without the entry alone", () => {
    const only = [{ deviceId: "abc", label: "Mic" }];
    expect(mergeDefaultDevice(only)).toEqual({ devices: only, defaultName: null });
  });

  it("shows a saved 'default' id as the system default", () => {
    expect(deviceSelectValue("default")).toBe("");
    expect(deviceSelectValue("abc")).toBe("abc");
  });
});

describe("savedDeviceMissing", () => {
  const devices = [{ deviceId: "abc", label: "Mic" }];

  it("is true only for a chosen device that a read list no longer holds", () => {
    expect(savedDeviceMissing("gone", devices)).toBe(true);
    expect(savedDeviceMissing("abc", devices)).toBe(false);
  });

  it("is never true for the system default or an empty list", () => {
    expect(savedDeviceMissing("", devices)).toBe(false);
    expect(savedDeviceMissing("default", devices)).toBe(false);
    expect(savedDeviceMissing("gone", [])).toBe(false);
  });
});

describe("remembered device names", () => {
  it("brings back the name a device had, but only for that device", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
    rememberDeviceLabel("input", "abc", "Yeti Nano");
    expect(recallDeviceLabel("input", "abc")).toBe("Yeti Nano");
    expect(recallDeviceLabel("input", "other")).toBeNull();
    expect(recallDeviceLabel("camera", "abc")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("survives storage that throws", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(() => rememberDeviceLabel("input", "abc", "Mic")).not.toThrow();
    expect(recallDeviceLabel("input", "abc")).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("loneModifierName", () => {
  const key = (code: string, extra: Partial<PttBinding> = {}): PttBinding => ({
    ...defaultPttBinding(),
    code,
    label: code,
    ...extra,
  });

  it("names a modifier bound on its own", () => {
    expect(loneModifierName(key("ControlLeft"))).toBe("Ctrl");
    expect(loneModifierName(key("ShiftRight"))).toBe("Shift");
    expect(loneModifierName(key("AltLeft"))).toBe("Alt");
    expect(loneModifierName(key("MetaLeft"), true)).toBe("Cmd");
  });

  it("calls the fourth modifier the Windows key off Apple, whatever label it was saved with", () => {
    expect(loneModifierName(key("MetaLeft", { label: "Left Cmd" }), false)).toBe("Win");
    expect(loneModifierName(key("MetaRight", { label: "Right Cmd" }), false)).toBe("Win");
  });

  it("leaves ordinary keys, F keys, mouse buttons and AltGr alone", () => {
    expect(loneModifierName(key("KeyV"))).toBeNull();
    expect(loneModifierName(key("F13"))).toBeNull();
    expect(loneModifierName(key("ControlLeft", { device: "mouse" }))).toBeNull();
    expect(loneModifierName(key("AltRight"))).toBeNull();
  });
});

describe("relabelStockBinding", () => {
  const abnt2 = { get: (code: string) => (code === "Backquote" ? "'" : undefined) };

  it("draws the factory backquote with the name the person's keyboard prints", () => {
    const shown = relabelStockBinding(defaultPttBinding(), abnt2);
    expect(shown.label).toBe("'");
    expect(shown.code).toBe("Backquote");
  });

  it("is the same object when nothing changes, so the field keeps its refusal", () => {
    const stock = defaultPttBinding();
    expect(relabelStockBinding(stock, null)).toBe(stock);
    expect(relabelStockBinding(stock, { get: () => "`" })).toBe(stock);
    expect(relabelStockBinding(stock, { get: () => undefined })).toBe(stock);
  });

  it("never renames a key the person bound themselves", () => {
    const own: PttBinding = { ...defaultPttBinding(), code: "KeyV", label: "V" };
    expect(relabelStockBinding(own, abnt2)).toBe(own);
    const chord: PttBinding = { ...defaultPttBinding(), ctrl: true };
    expect(relabelStockBinding(chord, abnt2)).toBe(chord);
  });
});

describe("startMicLoopback live volumes", () => {
  it("applies the input and output volume to the running loop", async () => {
    const fake = fakeAudio();
    const { deps: d } = deps(fake);
    const loop = startMicLoopback(options(), d);
    await loop.ready;
    expect(fake.gain.gain.value).toBe(1.5);
    expect(fake.element.volume).toBe(0.4);

    loop.setInputVolume(0.5);
    loop.setOutputVolume(0.9);
    expect(fake.gain.gain.value).toBe(0.5);
    expect(fake.element.volume).toBe(0.9);

    // The same ceilings the call uses.
    loop.setInputVolume(5);
    loop.setOutputVolume(5);
    expect(fake.gain.gain.value).toBe(2);
    expect(fake.element.volume).toBe(1);
  });

  it("keeps a volume set before the microphone opened, and uses it", async () => {
    const fake = fakeAudio();
    const { deps: d } = deps(fake);
    const loop = startMicLoopback(options(), d);
    loop.setInputVolume(0.25);
    loop.setOutputVolume(0.75);
    await loop.ready;
    expect(fake.gain.gain.value).toBe(0.25);
    expect(fake.element.volume).toBe(0.75);
  });

  it("ignores a volume after it ended", async () => {
    const fake = fakeAudio();
    const { deps: d } = deps(fake);
    const loop = startMicLoopback(options(), d);
    await loop.ready;
    loop.stop();
    expect(() => loop.setInputVolume(0.1)).not.toThrow();
    expect(() => loop.setOutputVolume(0.1)).not.toThrow();
  });
});

describe("maxSensitivityPercent", () => {
  it("is as far right as the bar reaches at that input volume", () => {
    expect(maxSensitivityPercent(0.3)).toBe(54);
    expect(maxSensitivityPercent(1)).toBe(100);
    expect(maxSensitivityPercent(2)).toBe(100);
    // The volume floor keeps the line from pinning to the left edge.
    expect(maxSensitivityPercent(0)).toBe(27);
  });

  it("is the largest percent that still maps to a threshold the gate can use", () => {
    for (const volume of [0.1, 0.3, 0.5, 0.9, 1.5]) {
      const max = maxSensitivityPercent(volume);
      expect(sliderToVadThreshold(max, volume)).toBeLessThanOrEqual(1);
      // One step past it would clamp, which is the dead stretch the slider had.
      if (max < 100) {
        expect(sliderToVadThreshold(max + 2, volume)).toBe(1);
      }
    }
  });
});
