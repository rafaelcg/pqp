import { describe, expect, it } from "vitest";
import { repairMojibake } from "./mojibake.js";

/** What UTF-8 read as latin-1 does to a string, so the fixtures are real. */
function breakIt(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}

describe("repairMojibake", () => {
  it("puts back the title this was found on", () => {
    expect(repairMojibake("LegiÃ£o Urbana - Pais E Filhos")).toBe(
      "Legião Urbana - Pais E Filhos",
    );
  });

  it("leaves a title that is already right alone", () => {
    for (const title of [
      "Legião Urbana - Tempo Perdido (Ao Vivo Especial)",
      "Racionais MC's - Vida Loka",
      "Café Tacvba — Déjate Caer",
      "Tempo Perdido",
    ]) {
      expect(repairMojibake(title)).toBe(title);
    }
  });

  it("repairs whatever the mistake was made of", () => {
    for (const title of [
      "Ainda Bem — Marisa Monte",
      "Açaí, açúcar e pão de queijo",
      "Nº 5 · Übermensch",
    ]) {
      expect(repairMojibake(breakIt(title))).toBe(title);
    }
  });

  it("undoes it twice when it was done twice", () => {
    expect(repairMojibake(breakIt(breakIt("Legião Urbana")))).toBe("Legião Urbana");
  });

  it("keeps a lone A-tilde, which is somebody's capital letter", () => {
    expect(repairMojibake("Ã")).toBe("Ã");
    expect(repairMojibake("PÃO")).toBe("PÃO");
  });

  it("never touches a title with an emoji or a curly quote", () => {
    const withEmoji = "lofi hip hop 📚 beats";
    expect(repairMojibake(withEmoji)).toBe(withEmoji);
    const curly = "Don’t Stop Me Now";
    expect(repairMojibake(curly)).toBe(curly);
  });

  it("leaves bytes that are not valid UTF-8 as they are", () => {
    // `Ã` + a continuation byte that starts nothing: the telltale matches,
    // the strict decode refuses, and the text survives untouched.
    const broken = "Ã¿ÿ";
    expect(repairMojibake(broken)).toBe(broken);
  });

  it("is idempotent, so a second pass over a repaired title changes nothing", () => {
    const once = repairMojibake("LegiÃ£o Urbana");
    expect(repairMojibake(once)).toBe(once);
  });

  it("does not mind an empty string", () => {
    expect(repairMojibake("")).toBe("");
  });
});
