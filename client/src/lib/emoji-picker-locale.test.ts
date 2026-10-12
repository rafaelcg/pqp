import es from "@emoji-mart/data/i18n/es.json";
import pt from "@emoji-mart/data/i18n/pt.json";
import { describe, expect, it } from "vitest";
import { emojiPickerLocale } from "./emoji-picker-locale";

describe("emojiPickerLocale", () => {
  it("hands pt-BR the Portuguese strings, with the app's word for search", () => {
    const picked = emojiPickerLocale("pt-BR", { pt, es });
    expect(picked.locale).toBe("pt");
    expect(picked.i18n?.search).toBe("Buscar");
    expect((picked.i18n?.categories as Record<string, string>).frequent).toBe(
      "Usados recentemente",
    );
  });

  it("hands Spanish its own strings", () => {
    const picked = emojiPickerLocale("es", { pt, es });
    expect(picked.locale).toBe("es");
    expect(picked.i18n).toBe(es);
  });

  it("leaves English to emoji-mart's built-in strings, so nothing is fetched", () => {
    expect(emojiPickerLocale("en", { pt, es })).toEqual({ locale: "en", i18n: undefined });
  });
});
