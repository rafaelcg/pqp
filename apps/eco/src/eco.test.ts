import { describe, expect, it } from "vitest";
import { formatPing, pickLocale, STRINGS } from "./i18n";
import { incrementPatch, initialOf, readCount } from "./model";

describe("Eco strings", () => {
  const locales = Object.keys(STRINGS) as Array<keyof typeof STRINGS>;

  it("has the same keys in pt-BR, en and es, none empty", () => {
    expect(locales.sort()).toEqual(["en", "es", "pt-BR"]);
    const keys = Object.keys(STRINGS["pt-BR"]).sort();
    for (const locale of locales) {
      expect(Object.keys(STRINGS[locale]).sort(), locale).toEqual(keys);
      for (const [key, value] of Object.entries(STRINGS[locale])) {
        expect(value.length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("follows the copy rules: no em dash anywhere, no voce in pt-BR, one {name} in the ping line", () => {
    const emDash = String.fromCharCode(0x2014);
    for (const locale of locales) {
      for (const [key, value] of Object.entries(STRINGS[locale])) {
        expect(value.includes(emDash), `${locale}.${key}`).toBe(false);
      }
      expect(STRINGS[locale].pingFrom.split("{name}").length, locale).toBe(2);
    }
    for (const value of Object.values(STRINGS["pt-BR"])) {
      expect(/voc[eê]/i.test(value)).toBe(false);
    }
  });

  it("picks a locale: exact, then base language, then English", () => {
    expect(pickLocale("pt-BR")).toBe("pt-BR");
    expect(pickLocale("pt-PT")).toBe("pt-BR");
    expect(pickLocale("es-MX")).toBe("es");
    expect(pickLocale("en-GB")).toBe("en");
    expect(pickLocale("ja")).toBe("en");
  });

  it("splices the name literally", () => {
    expect(formatPing("{name} mandou um ping", "$& {name}")).toBe("$& {name} mandou um ping");
  });
});

describe("Eco model", () => {
  it("reads the counter defensively", () => {
    expect(readCount({ count: 3 })).toBe(3);
    expect(readCount(null)).toBe(0);
    expect(readCount([])).toBe(0);
    expect(readCount({ count: "3" })).toBe(0);
    expect(readCount({ count: -1 })).toBe(0);
    expect(readCount({ count: 1.5 })).toBe(0);
    expect(readCount({})).toBe(0);
  });

  it("increments with a merge patch", () => {
    expect(incrementPatch(0)).toEqual({ count: 1 });
    expect(incrementPatch(41)).toEqual({ count: 42 });
  });

  it("takes an initial for the avatar fallback", () => {
    expect(initialOf("bia")).toBe("B");
    expect(initialOf("  raf")).toBe("R");
    expect(initialOf("")).toBe("?");
  });
});
