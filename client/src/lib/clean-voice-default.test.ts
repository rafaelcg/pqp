import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchGlobalVoiceConfig = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchGlobalVoiceConfig: () => fetchGlobalVoiceConfig(),
}));

import {
  CLEAN_VOICE_MIN_CORES,
  cleanVoiceDeviceCapable,
  currentDefaultNoiseSuppression,
  defaultNoiseSuppressionMode,
  loadCleanVoiceDefaultFlag,
  resolveNoiseSuppression,
  setCleanVoiceDefaultForTests,
  startCleanVoiceDefaultFlag,
} from "./clean-voice-default";

describe("cleanVoiceDeviceCapable, the conservative guard", () => {
  it("needs AudioWorklet and WebAssembly, whatever the cores", () => {
    expect(cleanVoiceDeviceCapable({ supported: false, cores: 16 })).toBe(false);
    expect(cleanVoiceDeviceCapable({ supported: false, cores: undefined })).toBe(false);
  });

  it("refuses a machine below four cores", () => {
    expect(CLEAN_VOICE_MIN_CORES).toBe(4);
    expect(cleanVoiceDeviceCapable({ supported: true, cores: 2 })).toBe(false);
    expect(cleanVoiceDeviceCapable({ supported: true, cores: 3 })).toBe(false);
  });

  it("passes four cores and up", () => {
    expect(cleanVoiceDeviceCapable({ supported: true, cores: 4 })).toBe(true);
    expect(cleanVoiceDeviceCapable({ supported: true, cores: 12 })).toBe(true);
  });

  it("passes an unknown core count", () => {
    expect(cleanVoiceDeviceCapable({ supported: true, cores: undefined })).toBe(true);
  });
});

describe("defaultNoiseSuppressionMode", () => {
  it("is Voz limpa only with the flag on AND a capable device", () => {
    expect(defaultNoiseSuppressionMode({ flagOn: true, capable: true })).toBe("advanced");
    expect(defaultNoiseSuppressionMode({ flagOn: false, capable: true })).toBe("browser");
    expect(defaultNoiseSuppressionMode({ flagOn: true, capable: false })).toBe("browser");
    expect(defaultNoiseSuppressionMode({ flagOn: false, capable: false })).toBe("browser");
  });
});

describe("resolveNoiseSuppression: a stored choice always wins", () => {
  it("nothing stored takes the default, either way", () => {
    expect(resolveNoiseSuppression({ stored: undefined, defaultMode: "advanced" })).toEqual({
      mode: "advanced",
      chosen: false,
    });
    expect(resolveNoiseSuppression({ stored: null, defaultMode: "browser" })).toEqual({
      mode: "browser",
      chosen: false,
    });
  });

  it("every stored mode is kept, with the default on", () => {
    for (const stored of ["off", "browser", "advanced"] as const) {
      expect(resolveNoiseSuppression({ stored, defaultMode: "advanced" })).toEqual({
        mode: stored,
        chosen: true,
      });
    }
    expect(resolveNoiseSuppression({ stored: "advanced", defaultMode: "browser" })).toEqual({
      mode: "advanced",
      chosen: true,
    });
  });

  it("the legacy booleans are choices: true is the browser's, false is none", () => {
    // A stored `true` cannot be told apart from somebody who ticked the box,
    // so it is never moved onto the new default.
    expect(resolveNoiseSuppression({ stored: true, defaultMode: "advanced" })).toEqual({
      mode: "browser",
      chosen: true,
    });
    expect(resolveNoiseSuppression({ stored: false, defaultMode: "advanced" })).toEqual({
      mode: "off",
      chosen: true,
    });
  });

  it("garbage reads as the browser's, as it always did, and is not defaulted", () => {
    expect(resolveNoiseSuppression({ stored: "rnnoise", defaultMode: "advanced" })).toEqual({
      mode: "browser",
      chosen: true,
    });
  });
});

describe("the flag as the client learns it", () => {
  beforeEach(() => {
    fetchGlobalVoiceConfig.mockReset();
    setCleanVoiceDefaultForTests({ flagOn: false, capable: true });
  });
  afterEach(() => {
    setCleanVoiceDefaultForTests({ flagOn: false, capable: null });
  });

  it("unknown is off: the browser's suppressor until the API says yes", () => {
    expect(currentDefaultNoiseSuppression()).toBe("browser");
  });

  it("follows cleanVoiceDefault on the global voice config, both ways", async () => {
    fetchGlobalVoiceConfig.mockResolvedValueOnce({ cleanVoiceDefault: true });
    await loadCleanVoiceDefaultFlag();
    expect(currentDefaultNoiseSuppression()).toBe("advanced");
    fetchGlobalVoiceConfig.mockResolvedValueOnce({ cleanVoiceDefault: false });
    await loadCleanVoiceDefaultFlag();
    expect(currentDefaultNoiseSuppression()).toBe("browser");
  });

  it("an older API that sends no field is off", async () => {
    fetchGlobalVoiceConfig.mockResolvedValueOnce({ audioSelfHeal: true });
    await loadCleanVoiceDefaultFlag();
    expect(currentDefaultNoiseSuppression()).toBe("browser");
  });

  it("a failed ask keeps the last answer", async () => {
    fetchGlobalVoiceConfig.mockResolvedValueOnce({ cleanVoiceDefault: true });
    await loadCleanVoiceDefaultFlag();
    fetchGlobalVoiceConfig.mockRejectedValueOnce(new Error("offline"));
    await loadCleanVoiceDefaultFlag();
    expect(currentDefaultNoiseSuppression()).toBe("advanced");
  });

  it("a weak device stays on the browser's even with the flag on", async () => {
    setCleanVoiceDefaultForTests({ capable: false });
    fetchGlobalVoiceConfig.mockResolvedValueOnce({ cleanVoiceDefault: true });
    await loadCleanVoiceDefaultFlag();
    expect(currentDefaultNoiseSuppression()).toBe("browser");
  });

  it("the teardown puts it back to off", async () => {
    fetchGlobalVoiceConfig.mockResolvedValue({ cleanVoiceDefault: true });
    const stop = startCleanVoiceDefaultFlag();
    await vi.waitFor(() => expect(currentDefaultNoiseSuppression()).toBe("advanced"));
    stop();
    expect(currentDefaultNoiseSuppression()).toBe("browser");
  });
});
