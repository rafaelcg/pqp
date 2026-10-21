import { describe, expect, it } from "vitest";
import { STRINGS } from "./i18n";
import {
  clampTurboRatio,
  coreRatio,
  DEFAULT_TURBO_RATIO,
  formatRatio,
  isIdleRatio,
  ratioForKey,
  silencesGame,
  TURBO_MAX,
  TURBO_MIN,
  TURBO_MUTE_ABOVE,
  TURBO_PRESETS,
  TURBO_STEP,
  turboPopoverModel,
} from "./turbo";

const t = STRINGS["pt-BR"];

describe("the ratio's rules", () => {
  it("runs from 1x to 10x in half steps, with 3x as the default and four quick picks", () => {
    expect([TURBO_MIN, TURBO_MAX, TURBO_STEP, DEFAULT_TURBO_RATIO]).toEqual([1, 10, 0.5, 3]);
    expect([...TURBO_PRESETS]).toEqual([2, 4, 8, 10]);
    for (const preset of TURBO_PRESETS) expect(clampTurboRatio(preset)).toBe(preset);
  });

  it("clamps to the limits and snaps to the nearest half", () => {
    expect(clampTurboRatio(0)).toBe(1);
    expect(clampTurboRatio(-5)).toBe(1);
    expect(clampTurboRatio(0.74)).toBe(1);
    expect(clampTurboRatio(1)).toBe(1);
    expect(clampTurboRatio(1.24)).toBe(1);
    expect(clampTurboRatio(1.26)).toBe(1.5);
    expect(clampTurboRatio(4.5)).toBe(4.5);
    expect(clampTurboRatio(6.74)).toBe(6.5);
    expect(clampTurboRatio(6.76)).toBe(7);
    expect(clampTurboRatio(9.9)).toBe(10);
    expect(clampTurboRatio(10)).toBe(10);
    expect(clampTurboRatio(1000)).toBe(10);
  });

  it("gives the default for anything that is not a finite number", () => {
    for (const bad of [Number.NaN, Infinity, -Infinity, "4", "", null, undefined, {}, [], true]) {
      expect(clampTurboRatio(bad), String(bad)).toBe(DEFAULT_TURBO_RATIO);
    }
  });

  it("is idle at 1x and not a hair above it", () => {
    expect(isIdleRatio(1)).toBe(true);
    expect(isIdleRatio(0)).toBe(true);
    expect(isIdleRatio(1.5)).toBe(false);
  });

  it("silences the game above 3x, and 3x itself still has its sound", () => {
    expect(TURBO_MUTE_ABOVE).toBe(3);
    expect(silencesGame(0)).toBe(false);
    expect(silencesGame(2)).toBe(false);
    expect(silencesGame(3)).toBe(false);
    expect(silencesGame(3.5)).toBe(true);
    expect(silencesGame(10)).toBe(true);
  });

  it("hands the core a float between 1 and 10, whatever it was asked for", () => {
    expect(coreRatio(4.5)).toBe(4.5);
    expect(coreRatio(10)).toBe(10);
    expect(coreRatio(25)).toBe(10);
    expect(coreRatio(0.2)).toBe(1);
    expect(coreRatio(Number.NaN)).toBe(1);
    expect(coreRatio(Infinity)).toBe(1);
  });
});

describe("writing a ratio", () => {
  it("is plain digits without a language, and a whole number has no decimals", () => {
    expect(formatRatio(4.5)).toBe("4.5");
    expect(formatRatio(3)).toBe("3");
    expect(formatRatio(10)).toBe("10");
  });

  it("uses the language's decimal mark", () => {
    expect(formatRatio(4.5, "pt-BR")).toBe("4,5");
    expect(formatRatio(4.5, "es")).toBe("4,5");
    expect(formatRatio(4.5, "en")).toBe("4.5");
    expect(formatRatio(8, "pt-BR")).toBe("8");
  });
});

describe("the slider's keys", () => {
  it("steps by half with the arrows, by one with the page keys, and goes to the ends with Home and End", () => {
    expect(ratioForKey(3, "ArrowRight")).toBe(3.5);
    expect(ratioForKey(3, "ArrowUp")).toBe(3.5);
    expect(ratioForKey(3, "ArrowLeft")).toBe(2.5);
    expect(ratioForKey(3, "ArrowDown")).toBe(2.5);
    expect(ratioForKey(3, "PageUp")).toBe(4);
    expect(ratioForKey(3, "PageDown")).toBe(2);
    expect(ratioForKey(3, "Home")).toBe(1);
    expect(ratioForKey(3, "End")).toBe(10);
  });

  it("stops at the ends and ignores every other key", () => {
    expect(ratioForKey(10, "ArrowRight")).toBe(10);
    expect(ratioForKey(10, "PageUp")).toBe(10);
    expect(ratioForKey(1, "ArrowLeft")).toBe(1);
    expect(ratioForKey(1.5, "PageDown")).toBe(1);
    expect(ratioForKey(3, "a")).toBeNull();
    expect(ratioForKey(3, "Enter")).toBeNull();
    expect(ratioForKey(3, " ")).toBeNull();
  });

  it("reaches every half step from 1 to 10 one arrow at a time, 19 values", () => {
    const seen = [TURBO_MIN];
    while (seen[seen.length - 1]! < TURBO_MAX) seen.push(ratioForKey(seen[seen.length - 1]!, "ArrowRight")!);
    expect(seen).toHaveLength(19);
    expect(seen[1]).toBe(1.5);
    expect(seen[18]).toBe(10);
  });
});

describe("the popover's model", () => {
  it("says the readout, the spoken value and where the thumb is", () => {
    const model = turboPopoverModel(4.5, t);
    expect(model.readout).toBe("4.5x");
    expect(model.valueText).toBe("4.5 vezes a velocidade normal");
    expect(model.idle).toBe(false);
    expect(model.silent).toBe(true);
    expect(model.percent).toBeCloseTo(((4.5 - 1) / 9) * 100, 6);
    expect([model.minLabel, model.maxLabel]).toEqual(["1x", "10x"]);
  });

  it("is at the start of the track at 1x, idle, and has no turbo to speak of", () => {
    const model = turboPopoverModel(1, t);
    expect(model.percent).toBe(0);
    expect(model.idle).toBe(true);
    expect(model.silent).toBe(false);
    expect(model.valueText).toBe(t["hud.turboValueOff"]);
  });

  it("is at the end of the track at 10x", () => {
    expect(turboPopoverModel(10, t).percent).toBe(100);
  });

  it("marks the pick that matches and none when the slider is between them", () => {
    expect(turboPopoverModel(8, t).presets).toEqual([
      { ratio: 2, label: "2x", checked: false },
      { ratio: 4, label: "4x", checked: false },
      { ratio: 8, label: "8x", checked: true },
      { ratio: 10, label: "10x", checked: false },
    ]);
    expect(turboPopoverModel(5, t).presets.some((preset) => preset.checked)).toBe(false);
  });

  it("holds a bad ratio to the rules instead of passing it through", () => {
    expect(turboPopoverModel(99, t).readout).toBe("10x");
    expect(turboPopoverModel(Number.NaN, t).readout).toBe("3x");
  });

  it("writes the number the language's way in the readout and in the spoken value, in all three languages", () => {
    expect(turboPopoverModel(4.5, STRINGS["pt-BR"], "pt-BR").readout).toBe("4,5x");
    expect(turboPopoverModel(4.5, STRINGS["pt-BR"], "pt-BR").valueText).toBe("4,5 vezes a velocidade normal");
    expect(turboPopoverModel(4.5, STRINGS.en, "en").valueText).toBe("4.5 times normal speed");
    expect(turboPopoverModel(4.5, STRINGS.es, "es").valueText).toBe("4,5 veces la velocidad normal");
  });
});

describe("the copy", () => {
  const keys = [
    "hud.turboAria1x",
    "hud.turboCaret",
    "hud.turboSlider",
    "hud.turboValue",
    "hud.turboValueOff",
    "hud.turboPresets",
    "hud.turboMute",
    "toast.turbo1x",
    "toast.turbo1xAction",
  ] as const;

  it("exists in pt-BR, en and es, differs between them, and has no em dash and no word the app does not say", () => {
    for (const key of keys) {
      const values = (["pt-BR", "en", "es"] as const).map((locale) => STRINGS[locale][key]);
      for (const value of values) {
        expect(value.length, key).toBeGreaterThan(0);
        expect(value, key).not.toContain("—");
        expect(value, key).not.toMatch(/\b(rom|roms|download|baixar|free|voce|você)\b/i);
      }
      expect(new Set(values).size, key).toBeGreaterThan(1);
    }
  });

  it("speaks to the person as 'tu' in Portuguese, with no 'você'", () => {
    for (const key of keys) expect(STRINGS["pt-BR"][key]).not.toMatch(/voc[eê]/i);
    expect(STRINGS["pt-BR"]["hud.turboAria1x"]).toContain("Segura");
  });

  it("is real Spanish, not Portuguese with accents", () => {
    expect(STRINGS.es["hud.turboAria1x"]).toContain("Mantén pulsado");
    expect(STRINGS.es["hud.turboValue"]).toContain("veces");
    expect(STRINGS.es["hud.turboMute"]).toContain("Sin sonido");
    expect(STRINGS.es["toast.turbo1x"]).toContain("El turbo a 1x");
  });
});
