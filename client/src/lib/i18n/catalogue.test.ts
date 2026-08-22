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
      "pqp is for people aged 18 and over.",
    );
    await loadLocale("pt-BR");
    expect(translateMessage("ageGate.description", { age: 18 })).toBe(
      "O pqp é para pessoas de 18 anos ou mais.",
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
