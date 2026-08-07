import { describe, expect, it } from "vitest";
import { en, translate, type PartialMessages } from "./catalogue";
import { ptBR } from "./messages.pt-BR";

describe("translate", () => {
  it("uses the translation when the key is present", () => {
    expect(translate(ptBR, "nav.signIn")).toBe("Entrar");
  });

  it("falls back to English for a key the translation omits", () => {
    const sparse: PartialMessages = { "nav.signIn": "Entrar" };
    // The point of the whole fallback: never a key name, never a blank.
    const result = translate(sparse, "nav.howItWorks");
    expect(result).toBe(en["nav.howItWorks"]);
    expect(result).not.toBe("nav.howItWorks");
    expect(result).not.toBe("");
  });

  it("falls back to English when there is no catalogue at all", () => {
    expect(translate(undefined, "landing.hero.title")).toBe(
      en["landing.hero.title"],
    );
  });

  it("treats an empty translation as missing rather than as a blank string", () => {
    expect(translate({ "nav.signIn": "" }, "nav.signIn")).toBe(en["nav.signIn"]);
  });

  it("substitutes placeholders", () => {
    expect(translate(undefined, "ageGate.description", { age: 18 })).toBe(
      "pqp is for people aged 18 and over.",
    );
    expect(translate(ptBR, "ageGate.description", { age: 18 })).toBe(
      "O pqp é para pessoas de 18 anos ou mais.",
    );
  });

  it("leaves an unknown placeholder visible instead of blanking it", () => {
    expect(translate(undefined, "ageGate.description", { wrong: 18 })).toContain(
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
});
