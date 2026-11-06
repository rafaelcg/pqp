import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  fetchGlobalVoiceConfig: vi.fn(),
}));

import { createVoiceGate, VOICE_GATE_PROCESSOR } from "./voice-gate-node";
import { liveVoiceGateCount, setVoiceGateForTests } from "./voice-gate-flag";

interface Constructed {
  context: unknown;
  name: string;
  options: Record<string, unknown>;
  port: { postMessage: ReturnType<typeof vi.fn> };
  disconnect: ReturnType<typeof vi.fn>;
}
const constructed: Constructed[] = [];

class FakeWorkletNode {
  port = { postMessage: vi.fn() };
  disconnect = vi.fn();
  onprocessorerror: unknown = () => {};
  constructor(
    public context: unknown,
    public name: string,
    public options: Record<string, unknown>,
  ) {
    constructed.push(this as unknown as Constructed);
  }
}

function fakeContext(addModule = vi.fn(async () => undefined)) {
  return { audioWorklet: { addModule } } as unknown as AudioContext;
}

describe("createVoiceGate", () => {
  beforeEach(() => {
    constructed.length = 0;
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    setVoiceGateForTests(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setVoiceGateForTests(true);
  });

  it("builds a two-input mono node with no lookahead of its own", async () => {
    const handle = await createVoiceGate(fakeContext());
    expect(handle).not.toBeNull();
    const node = constructed[0];
    expect(node.name).toBe(VOICE_GATE_PROCESSOR);
    expect(node.options).toMatchObject({
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      // The raw-mic sidechain's head start is RNNoise's own delay.
      processorOptions: { lookaheadMs: 0 },
    });
    handle?.destroy();
  });

  it("loads the module once per context, however many gates", async () => {
    const addModule = vi.fn(async () => undefined);
    const context = fakeContext(addModule);
    const a = await createVoiceGate(context);
    const b = await createVoiceGate(context);
    expect(addModule).toHaveBeenCalledTimes(1);
    a?.destroy();
    b?.destroy();
  });

  it("builds nothing, and loads nothing, while the flag is off", async () => {
    setVoiceGateForTests(false);
    const addModule = vi.fn(async () => undefined);
    expect(await createVoiceGate(fakeContext(addModule))).toBeNull();
    expect(addModule).not.toHaveBeenCalled();
    expect(constructed).toHaveLength(0);
  });

  it("fails open to null when the module will not load", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = await createVoiceGate(
      fakeContext(vi.fn(async () => Promise.reject(new Error("404")))),
    );
    expect(handle).toBeNull();
  });

  it("fails open to null when the node will not construct", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "AudioWorkletNode",
      class {
        constructor() {
          throw new Error("InvalidStateError");
        }
      },
    );
    expect(await createVoiceGate(fakeContext())).toBeNull();
  });

  it("is registered with the kill switch while it lives, and bypass reaches the processor", async () => {
    const before = liveVoiceGateCount();
    const handle = await createVoiceGate(fakeContext());
    expect(liveVoiceGateCount()).toBe(before + 1);

    setVoiceGateForTests(false);
    expect(constructed[0].port.postMessage).toHaveBeenLastCalledWith({
      bypass: true,
    });
    setVoiceGateForTests(true);
    expect(constructed[0].port.postMessage).toHaveBeenLastCalledWith({
      bypass: false,
    });

    handle?.destroy();
    expect(liveVoiceGateCount()).toBe(before);
    // Destroyed: a later flip posts nothing.
    const posted = constructed[0].port.postMessage.mock.calls.length;
    setVoiceGateForTests(false);
    expect(constructed[0].port.postMessage.mock.calls.length).toBe(posted);
  });

  it("destroy is idempotent and survives a node that is already gone", async () => {
    const handle = await createVoiceGate(fakeContext());
    constructed[0].disconnect.mockImplementation(() => {
      throw new Error("InvalidAccessError");
    });
    expect(() => handle?.destroy()).not.toThrow();
    expect(() => handle?.destroy()).not.toThrow();
  });
});
