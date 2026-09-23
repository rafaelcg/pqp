import { afterEach, describe, expect, it } from "vitest";
import en from "@/locales/en/translation.json";
import ptBR from "@/locales/pt-BR/translation.json";
import { loadLocale, setActiveCatalogue, translateMessage } from "./instance";

afterEach(() => {
  setActiveCatalogue(undefined);
});

describe("translateMessage", () => {
  it("uses the translation when the key is present", async () => {
    await loadLocale("pt-BR");
    expect(translateMessage("nav.signIn")).toBe("Entrar");
  });

  it("falls back to English for a key the translation omits", () => {
    setActiveCatalogue({ "nav.signIn": "Entrar" });
    const result = translateMessage("nav.howItWorks");
    expect(result).toBe(en["nav.howItWorks"]);
    expect(result).not.toBe("nav.howItWorks");
    expect(result).not.toBe("");
  });

  it("falls back to English when there is no overlay at all", () => {
    expect(translateMessage("landing.hero.title")).toBe(en["landing.hero.title"]);
  });

  it("treats an empty translation as missing rather than as a blank string", () => {
    setActiveCatalogue({ "nav.signIn": "" });
    expect(translateMessage("nav.signIn")).toBe(en["nav.signIn"]);
  });

  it("substitutes placeholders", async () => {
    expect(translateMessage("ageGate.description", { age: 18 })).toBe(
      "pqp is 18+. We ask once and take your word for it.",
    );
    await loadLocale("pt-BR");
    expect(translateMessage("ageGate.description", { age: 18 })).toBe(
      "O pqp é pra maiores de 18. A gente pergunta uma vez e acredita em você.",
    );
  });

  it("leaves an unknown placeholder visible instead of blanking it", () => {
    expect(translateMessage("ageGate.description", { wrong: 18 })).toContain(
      "{age}",
    );
  });

  it("keeps every placeholder the English string declares", () => {
    const slots = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort();
    for (const [key, translated] of Object.entries(ptBR)) {
      const source = en[key as keyof typeof en];
      expect(
        slots(translated),
        `pt-BR "${key}" must interpolate the same values as English`,
      ).toEqual(slots(source));
    }
  });

  it("rejects double-brace interpolation leftovers", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value, `en "${key}" still uses {{placeholders}}`).not.toMatch(
        /\{\{/,
      );
    }
    for (const [key, value] of Object.entries(ptBR)) {
      expect(value, `pt-BR "${key}" still uses {{placeholders}}`).not.toMatch(
        /\{\{/,
      );
    }
  });

  it("only translates keys English actually defines", () => {
    for (const key of Object.keys(ptBR)) {
      expect(en, `pt-BR has a stale key "${key}"`).toHaveProperty(key);
    }
  });

  it("keeps the product name intact in every pt-BR string that mentions it", () => {
    for (const [key, translated] of Object.entries(ptBR)) {
      if (!en[key as keyof typeof en].includes("pqp")) {
        continue;
      }
      expect(translated, `pt-BR "${key}" dropped the product name`).toContain(
        "pqp",
      );
    }
  });

  it("keeps the Slow mode wait on one interpolating string", () => {
    expect(en["composer.slowMode"]).toContain("{seconds}");
    expect(ptBR["composer.slowMode"]).toContain("{seconds}");
    expect(ptBR["composer.slowMode"]).toContain("Slow mode");
    expect(ptBR["channelMeta.slowMode"]).toBe("Slow mode");
    expect(en["chat.retryWait"]).toContain("{seconds}");
    expect(ptBR["chat.retryWait"]).toContain("{seconds}");
  });

  it("still interpolates {count} on a non-plural family", () => {
    expect(translateMessage("publicProfile.depoimentos.more", { count: 4 })).toBe(
      "and 4 more",
    );
  });

  it("selects _one / _other / _zero from a numeric count", () => {
    expect(translateMessage("invite.uses.unlimited", { count: 1 })).toBe("1 use");
    expect(translateMessage("invite.uses.unlimited", { count: 2 })).toBe("2 uses");
    expect(translateMessage("invite.uses.unlimited", { count: 0 })).toBe("0 uses");
  });

  it("keeps leftover .one / .many keys off the SSO select", () => {
    expect("sso.body.one" in en).toBe(false);
    expect("sso.body.many" in en).toBe(false);
    expect(en["sso.body_single"]).toBeTruthy();
    expect(en["sso.body_several"]).toBeTruthy();
  });

  it("gives every _one family an _other or a base key", () => {
    const suffix = /_(zero|one|two|few|many|other|desktop)$/;
    const ones = Object.keys(en).filter((key) => key.endsWith("_one"));
    for (const one of ones) {
      const base = one.slice(0, -4);
      expect(
        `${base}_other` in en || base in en,
        `${one} needs ${base}_other or ${base}`,
      ).toBe(true);
    }
    for (const key of Object.keys(en)) {
      if (!key.endsWith("_desktop")) {
        continue;
      }
      const base = key.slice(0, -"_desktop".length);
      expect(en, `${key} needs base ${base}`).toHaveProperty(base);
    }
    void suffix;
  });
});

/**
 * The desktop shell can only share a screen or a window, never a browser
 * tab (`electron/lib/display-sources.js` asks `desktopCapturer` for
 * `["screen", "window"]`), and on macOS/Linux it cannot carry the shared
 * audio at all (Chromium's loopback capture is Windows-only). These context
 * variants keep the watch-party setup copy from telling a desktop presenter
 * to do something their app cannot do ("share a tab"), and steer them at
 * the one that actually works on each platform.
 */
describe("watch-party desktop copy (electron cannot share a tab)", () => {
  it("tells a desktop presenter to pick the window, not a tab, in both languages", () => {
    const en_ = translateMessage("watchParty.setup.pickBody", {
      context: "desktop",
    });
    expect(en_).toContain("window");
    expect(en_).not.toContain("tab");
  });

  it("keeps the ordinary browser copy when there is no desktop context", () => {
    expect(translateMessage("watchParty.setup.pickBody")).toContain("tab");
  });

  it("steers a Windows desktop presenter to tick the computer-sound option", () => {
    expect(translateMessage("watchParty.setup.noAudio", { context: "desktop" })).toContain(
      "computer's sound",
    );
  });

  it("steers a macOS/Linux desktop presenter to present from Chrome instead", () => {
    const hint = translateMessage("watchParty.setup.noAudio", {
      context: "desktopSilent",
    });
    expect(hint).toContain("Chrome");
    expect(hint).toContain("pqp.gg");
  });

  it("never tells a desktop presenter their silent capture needs 'a tab'", () => {
    expect(
      translateMessage("watchParty.checklist.tabAudioTitle", { context: "desktop" }),
    ).not.toContain("tab");
    expect(
      translateMessage("watchParty.checklist.tabAudioBody", { context: "desktop" }),
    ).not.toContain("tab");
  });

  it("labels a source with audio as a window on desktop, a tab everywhere else", () => {
    expect(translateMessage("watchParty.setup.sourceOk", { context: "desktop" })).toBe(
      "Window with audio, ready",
    );
    expect(translateMessage("watchParty.setup.sourceOk")).toBe("Tab with audio, ready");
  });

  it("has every new desktop variant in pt-BR too", async () => {
    await loadLocale("pt-BR");
    for (const [key, context] of [
      ["watchParty.setup.pickBody", "desktop"],
      ["watchParty.setup.noAudio", "desktop"],
      ["watchParty.setup.noAudio", "desktopSilent"],
      ["watchParty.setup.sourceOk", "desktop"],
      ["watchParty.checklist.tabAudioTitle", "desktop"],
      ["watchParty.checklist.tabAudioBody", "desktop"],
    ] as const) {
      const pt = translateMessage(key, { context });
      expect(pt.length, `${key}_${context} in pt-BR`).toBeGreaterThan(0);
      expect(pt).not.toBe(translateMessage(key));
    }
  });
});
