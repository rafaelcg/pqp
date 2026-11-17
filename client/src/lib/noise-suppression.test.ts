import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advancedNoiseSuppressionSupported,
  browserNoiseSuppression,
  connectMicChain,
  createRnnoiseNode,
  loadRnnoiseBinary,
  parseNoiseSuppressionMode,
  type MicChainGate,
  type MicChainNode,
} from "./noise-suppression";

/** What `RnnoiseWorkletNode` was actually constructed with, across calls. */
const receivedWasmBinaries: ArrayBuffer[] = [];

const loadRnnoiseMock = vi.hoisted(() => vi.fn());

vi.mock("@sapphi-red/web-noise-suppressor", () => ({
  loadRnnoise: loadRnnoiseMock,
  RnnoiseWorkletNode: class {
    destroy = vi.fn();
    constructor(
      _context: unknown,
      options: { maxChannels: number; wasmBinary: ArrayBuffer },
    ) {
      receivedWasmBinaries.push(options.wasmBinary);
    }
  },
}));

/** Enough of an `AudioContext` for `createRnnoiseNode` to wire up a worklet. */
function fakeAudioContext(): AudioContext {
  return {
    audioWorklet: { addModule: vi.fn(async () => undefined) },
  } as unknown as AudioContext;
}

describe("parseNoiseSuppressionMode", () => {
  it("migrates the boolean every existing browser has stored", () => {
    // This setting shipped as a tick box. `true` was the browser's own
    // suppressor and `false` was none, and a blob written by any build before
    // Sep 2026 says exactly one of those.
    expect(parseNoiseSuppressionMode(true)).toBe("browser");
    expect(parseNoiseSuppressionMode(false)).toBe("off");
  });

  it("reads back each of the three modes", () => {
    expect(parseNoiseSuppressionMode("off")).toBe("off");
    expect(parseNoiseSuppressionMode("browser")).toBe("browser");
    expect(parseNoiseSuppressionMode("advanced")).toBe("advanced");
  });

  it("falls back to the default rather than to nothing", () => {
    // A missing key is what the old loader read as on, and hand-edited
    // storage must never leave somebody with a mode nothing can honour.
    expect(parseNoiseSuppressionMode(undefined)).toBe("browser");
    expect(parseNoiseSuppressionMode(null)).toBe("browser");
    expect(parseNoiseSuppressionMode("rnnoise")).toBe("browser");
    expect(parseNoiseSuppressionMode(1)).toBe("browser");
  });
});

describe("browserNoiseSuppression", () => {
  it("turns the constraint OFF for advanced so the two never stack", () => {
    expect(browserNoiseSuppression("browser")).toBe(true);
    expect(browserNoiseSuppression("off")).toBe(false);
    expect(browserNoiseSuppression("advanced")).toBe(false);
  });
});

describe("advancedNoiseSuppressionSupported", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is false without AudioWorklet (old Safari, insecure context)", () => {
    vi.stubGlobal("AudioWorkletNode", undefined);
    expect(advancedNoiseSuppressionSupported()).toBe(false);
  });

  it("is true when the worklet and wasm are both there", () => {
    vi.stubGlobal("AudioWorkletNode", class {});
    expect(advancedNoiseSuppressionSupported()).toBe(true);
  });
});

/** A node that only records what it was wired to, like screen-mix's fakes. */
function fakeNode(name: string) {
  const wiredTo: string[] = [];
  const node: MicChainNode & { name: string; wiredTo: string[] } = {
    name,
    wiredTo,
    connect: (destination: never) => {
      wiredTo.push((destination as unknown as { name: string }).name);
    },
    disconnect: () => {
      wiredTo.length = 0;
    },
  };
  return node;
}

describe("createRnnoiseNode", () => {
  afterEach(() => {
    receivedWasmBinaries.length = 0;
    vi.clearAllMocks();
  });

  it("hands each worklet instance its own copy of the cached binary", async () => {
    // The real cache in `loadRnnoiseBinary` returns ONE `ArrayBuffer` shared
    // by every advanced pipeline in the page. The worklet transfers whatever
    // it is given to the render thread and detaches it, so passing the
    // cached buffer itself would leave it unusable (byteLength 0) for the
    // next pipeline. See noise-suppression.ts pitfall notes on
    // `createRnnoiseNode`.
    const cached = new ArrayBuffer(8);
    const context = fakeAudioContext();

    await createRnnoiseNode(context, cached);
    await createRnnoiseNode(context, cached);

    expect(receivedWasmBinaries).toHaveLength(2);
    // Neither copy IS the cached buffer...
    expect(receivedWasmBinaries[0]).not.toBe(cached);
    expect(receivedWasmBinaries[1]).not.toBe(cached);
    // ...and the two worklets do not share one either, so detaching one
    // (simulated here by transferring it) cannot affect the other or the
    // cache.
    expect(receivedWasmBinaries[0]).not.toBe(receivedWasmBinaries[1]);
    expect(cached.byteLength).toBe(8);
  });
});

describe("loadRnnoiseBinary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loadRnnoiseMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on a load that never settles, and lets the next call retry fresh", async () => {
    // Farol #517: without a timeout, a stalled fetch (a dropped connection
    // with no error, a service worker gone quiet) left the cached promise
    // pending forever, and every advanced join after the stuck one — not
    // just the one that started it — awaited that same promise and never
    // opened the call either.
    loadRnnoiseMock.mockImplementationOnce(() => new Promise(() => {}));

    const stalled = loadRnnoiseBinary();
    const assertion = expect(stalled).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    // The cache was cleared on the timeout, so this is a fresh attempt, not
    // the same dead promise.
    loadRnnoiseMock.mockImplementationOnce(async () => new ArrayBuffer(4));
    await expect(loadRnnoiseBinary()).resolves.toBeInstanceOf(ArrayBuffer);
    expect(loadRnnoiseMock).toHaveBeenCalledTimes(2);
  });
});

describe("connectMicChain", () => {
  it("puts the suppressor between the microphone and the gain node", () => {
    const source = fakeNode("source");
    const suppressor = fakeNode("rnnoise");
    const gain = fakeNode("gain");

    connectMicChain({ source, suppressor, gain });

    // Everything downstream of gain — the level meter, the mute gate, the
    // published stream and the watch-party mix — is suppressed for free.
    expect(source.wiredTo).toEqual(["rnnoise"]);
    expect(suppressor.wiredTo).toEqual(["gain"]);
  });

  it("wires source straight to gain with no suppressor", () => {
    const source = fakeNode("source");
    const gain = fakeNode("gain");

    connectMicChain({ source, suppressor: null, gain });

    // The exact graph the pipeline had before this feature existed: off and
    // browser mode must not gain a node.
    expect(source.wiredTo).toEqual(["gain"]);
  });

  describe("with the voice gate", () => {
    /** A node that records which input of which node it was wired into. */
    function wiredNode(name: string) {
      const edges: string[] = [];
      const node: MicChainGate & { name: string; edges: string[] } = {
        name,
        edges,
        onprocessorerror: null,
        connect: (destination: never, output = 0, input = 0) => {
          edges.push(
            `${(destination as unknown as { name: string }).name}:${output}>${input}`,
          );
        },
        disconnect: (destination?: never) => {
          if (destination === undefined) {
            edges.length = 0;
            return;
          }
          const target = (destination as unknown as { name: string }).name;
          for (let i = edges.length - 1; i >= 0; i--) {
            if (edges[i].startsWith(`${target}:`)) {
              edges.splice(i, 1);
            }
          }
        },
      };
      return node;
    }

    it("feeds the gate the suppressor's audio and the raw microphone as its sidechain", () => {
      const source = wiredNode("source");
      const suppressor = wiredNode("rnnoise");
      const gate = wiredNode("gate");
      const gain = wiredNode("gain");

      connectMicChain({ source, suppressor, gain, gate });

      // Input 0 is the audio that gets gained, input 1 the signal the gate
      // makes its decisions from. The raw microphone is ahead of the audio by
      // RNNoise's own delay, which is what the gate's head start is made of.
      expect(source.edges).toEqual(["rnnoise:0>0", "gate:0>1"]);
      expect(suppressor.edges).toEqual(["gate:0>0"]);
      expect(gate.edges).toEqual(["gain:0>0"]);
    });

    it("never wires a gate where there is no suppressor", () => {
      const source = wiredNode("source");
      const gate = wiredNode("gate");
      const gain = wiredNode("gain");

      connectMicChain({ source, suppressor: null, gain, gate });

      expect(source.edges).toEqual(["gain:0>0"]);
      expect(gate.edges).toEqual([]);
    });

    it("cuts the gate out and wires the suppressor straight to the gain when it fails", () => {
      const source = wiredNode("source");
      const suppressor = wiredNode("rnnoise");
      const gate = wiredNode("gate");
      const gain = wiredNode("gain");
      connectMicChain({ source, suppressor, gain, gate });

      // A worklet whose processor throws goes silent, and a silent microphone
      // is the one failure this chain may never have.
      gate.onprocessorerror?.(new Event("processorerror") as never);

      expect(suppressor.edges).toEqual(["gain:0>0"]);
      expect(source.edges).toEqual(["rnnoise:0>0"]);
      expect(gate.edges).toEqual([]);
    });

    it("survives a gate that was already disconnected when it fails", () => {
      const source = wiredNode("source");
      const suppressor = wiredNode("rnnoise");
      const gate = wiredNode("gate");
      const gain = wiredNode("gain");
      gate.disconnect = () => {
        throw new Error("InvalidAccessError");
      };
      connectMicChain({ source, suppressor, gain, gate });

      expect(() =>
        gate.onprocessorerror?.(new Event("processorerror") as never),
      ).not.toThrow();
      expect(suppressor.edges).toContain("gain:0>0");
    });
  });
});
