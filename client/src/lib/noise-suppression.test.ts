import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advancedNoiseSuppressionSupported,
  browserNoiseSuppression,
  connectMicChain,
  parseNoiseSuppressionMode,
  type MicChainNode,
} from "./noise-suppression";

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
});
