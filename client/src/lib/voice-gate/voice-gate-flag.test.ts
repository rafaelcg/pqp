import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchGlobalVoiceConfig = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchGlobalVoiceConfig: () => fetchGlobalVoiceConfig(),
}));

import {
  liveVoiceGateCount,
  loadVoiceGateFlag,
  registerLiveGate,
  setVoiceGateForTests,
  startVoiceGateFlag,
  voiceGateEnabled,
} from "./voice-gate-flag";

function fakeGate() {
  return { setBypass: vi.fn() };
}

describe("the voice gate's runtime flag", () => {
  beforeEach(() => {
    fetchGlobalVoiceConfig.mockReset();
    setVoiceGateForTests(true);
  });
  afterEach(() => {
    setVoiceGateForTests(true);
  });

  it("is ON before anything has answered: the gate ships on, plain RNNoise is the fallback", () => {
    expect(voiceGateEnabled()).toBe(true);
  });

  it("an older API that sends no field leaves it on", async () => {
    fetchGlobalVoiceConfig.mockResolvedValue({ cleanVoiceDefault: true });
    await loadVoiceGateFlag();
    expect(voiceGateEnabled()).toBe(true);
  });

  it("only an explicit false is the kill switch", async () => {
    fetchGlobalVoiceConfig.mockResolvedValue({ voiceGate: false });
    await loadVoiceGateFlag();
    expect(voiceGateEnabled()).toBe(false);
    fetchGlobalVoiceConfig.mockResolvedValue({ voiceGate: true });
    await loadVoiceGateFlag();
    expect(voiceGateEnabled()).toBe(true);
  });

  it("keeps the last answer when a later ask fails", async () => {
    fetchGlobalVoiceConfig.mockResolvedValue({ voiceGate: false });
    await loadVoiceGateFlag();
    fetchGlobalVoiceConfig.mockRejectedValue(new Error("offline"));
    await loadVoiceGateFlag();
    expect(voiceGateEnabled()).toBe(false);
  });

  it("a flip reaches a gate that is already running, as a bypass, with no rebuild", async () => {
    const gate = fakeGate();
    const unregister = registerLiveGate(gate);
    expect(gate.setBypass).not.toHaveBeenCalled();

    fetchGlobalVoiceConfig.mockResolvedValue({ voiceGate: false });
    await loadVoiceGateFlag();
    expect(gate.setBypass).toHaveBeenLastCalledWith(true);

    fetchGlobalVoiceConfig.mockResolvedValue({ voiceGate: true });
    await loadVoiceGateFlag();
    expect(gate.setBypass).toHaveBeenLastCalledWith(false);
    unregister();
  });

  it("a gate built while the flag is off starts bypassed", () => {
    setVoiceGateForTests(false);
    const gate = fakeGate();
    const unregister = registerLiveGate(gate);
    expect(gate.setBypass).toHaveBeenCalledWith(true);
    unregister();
  });

  it("an unregistered gate hears nothing more, and a throwing one does not block the rest", () => {
    const gone = fakeGate();
    const broken = {
      setBypass: vi.fn(() => {
        throw new Error("context closed");
      }),
    };
    const alive = fakeGate();
    const before = liveVoiceGateCount();
    const un1 = registerLiveGate(gone);
    const un2 = registerLiveGate(broken);
    const un3 = registerLiveGate(alive);
    un1();
    setVoiceGateForTests(false);
    expect(gone.setBypass).not.toHaveBeenCalled();
    expect(broken.setBypass).toHaveBeenCalled();
    expect(alive.setBypass).toHaveBeenCalledWith(true);
    un2();
    un3();
    expect(liveVoiceGateCount()).toBe(before);
  });

  it("a stale answer never overwrites a newer one", async () => {
    let resolveFirst: (value: { voiceGate: boolean }) => void = () => {};
    fetchGlobalVoiceConfig.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve)),
    );
    const first = loadVoiceGateFlag();
    fetchGlobalVoiceConfig.mockResolvedValueOnce({ voiceGate: false });
    await loadVoiceGateFlag();
    expect(voiceGateEnabled()).toBe(false);
    resolveFirst({ voiceGate: true });
    await first;
    expect(voiceGateEnabled()).toBe(false);
  });

  it("signing out returns to the code default, on", async () => {
    fetchGlobalVoiceConfig.mockResolvedValue({ voiceGate: false });
    const stop = startVoiceGateFlag();
    await vi.waitFor(() => expect(voiceGateEnabled()).toBe(false));
    stop();
    expect(voiceGateEnabled()).toBe(true);
  });
});
