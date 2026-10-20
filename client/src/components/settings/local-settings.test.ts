// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCleanVoiceDefaultForTests } from "@/lib/clean-voice-default";
import {
  defaultLocalSettings,
  loadLocalSettings,
  saveLocalSettings,
  serializeLocalSettings,
  withEffectiveNoiseSuppression,
} from "./local-settings";

const KEY = "pqp-local-settings";

function store(value: unknown) {
  localStorage.setItem(KEY, JSON.stringify(value));
}

function stored(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(KEY) ?? "null") as Record<string, unknown>;
}

describe("the noise-suppression default in the device's settings", () => {
  beforeEach(() => {
    localStorage.clear();
    setCleanVoiceDefaultForTests({ flagOn: true, capable: true });
  });
  afterEach(() => {
    localStorage.clear();
    setCleanVoiceDefaultForTests({ flagOn: false, capable: null });
  });

  it("a fresh device starts on Voz limpa with the flag on, and it is not a choice", () => {
    const settings = loadLocalSettings();
    expect(settings.micProcessing.noiseSuppression).toBe("advanced");
    expect(settings.noiseSuppressionChosen).toBe(false);
  });

  it("a fresh device stays on the browser's with the flag off", () => {
    setCleanVoiceDefaultForTests({ flagOn: false });
    expect(loadLocalSettings().micProcessing.noiseSuppression).toBe("browser");
  });

  it("a fresh device below the core bar stays on the browser's", () => {
    setCleanVoiceDefaultForTests({ capable: false });
    expect(loadLocalSettings().micProcessing.noiseSuppression).toBe("browser");
  });

  it("an old blob with no noise-suppression value takes the default, other settings intact", () => {
    store({ inputVolume: 1.5, micProcessing: { echoCancellation: false } });
    const settings = loadLocalSettings();
    expect(settings.micProcessing).toEqual({
      echoCancellation: false,
      noiseSuppression: "advanced",
      autoGainControl: true,
    });
    expect(settings.noiseSuppressionChosen).toBe(false);
    expect(settings.inputVolume).toBe(1.5);
  });

  it("every stored value is a choice and is never moved: the legacy booleans included", () => {
    const cases: [unknown, string][] = [
      ["off", "off"],
      ["browser", "browser"],
      ["advanced", "advanced"],
      [true, "browser"],
      [false, "off"],
    ];
    for (const [value, mode] of cases) {
      store({ micProcessing: { noiseSuppression: value } });
      const settings = loadLocalSettings();
      expect(settings.micProcessing.noiseSuppression, String(value)).toBe(mode);
      expect(settings.noiseSuppressionChosen, String(value)).toBe(true);
    }
  });

  it("a default is never written down, so turning the flag off moves the device back", () => {
    saveLocalSettings({ ...loadLocalSettings(), inputVolume: 0.5 });
    expect(stored().micProcessing).toEqual({ echoCancellation: true, autoGainControl: true });
    expect(stored()).not.toHaveProperty("noiseSuppressionChosen");
    setCleanVoiceDefaultForTests({ flagOn: false });
    const settings = loadLocalSettings();
    expect(settings.micProcessing.noiseSuppression).toBe("browser");
    expect(settings.inputVolume).toBe(0.5);
  });

  it("a choice is written down and survives the flag going off", () => {
    saveLocalSettings({
      ...loadLocalSettings(),
      micProcessing: { ...defaultLocalSettings.micProcessing, noiseSuppression: "advanced" },
      noiseSuppressionChosen: true,
    });
    expect(stored().micProcessing).toMatchObject({ noiseSuppression: "advanced" });
    setCleanVoiceDefaultForTests({ flagOn: false });
    const settings = loadLocalSettings();
    expect(settings.micProcessing.noiseSuppression).toBe("advanced");
    expect(settings.noiseSuppressionChosen).toBe(true);
  });

  it("serializeLocalSettings keeps a chosen browser mode", () => {
    const text = serializeLocalSettings({
      ...defaultLocalSettings,
      noiseSuppressionChosen: true,
    });
    expect(JSON.parse(text).micProcessing.noiseSuppression).toBe("browser");
  });

  it("withEffectiveNoiseSuppression moves only an unchosen device, and returns the same object when nothing moves", () => {
    const unchosen = { ...defaultLocalSettings };
    const moved = withEffectiveNoiseSuppression(unchosen, "advanced");
    expect(moved.micProcessing.noiseSuppression).toBe("advanced");
    expect(withEffectiveNoiseSuppression(moved, "advanced")).toBe(moved);
    const chosen = { ...defaultLocalSettings, noiseSuppressionChosen: true };
    expect(withEffectiveNoiseSuppression(chosen, "advanced")).toBe(chosen);
  });
});
