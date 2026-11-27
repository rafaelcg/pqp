import { describe, expect, it } from "vitest";
import en from "./en/translation.json";
import es from "./es/translation.json";
import ptBR from "./pt-BR/translation.json";

/**
 * pt-BR copy in Jam speaks the house voice: "tu", "teu", "tua". A "voce" slipped
 * into the roles corner card, which a Jam owner meets first, and a gender slip
 * ("Ele some", about a gravacao) sat in the delete confirmation (jam persona QA,
 * 2026-11-19). The no em dash rule has its own test (`no-em-dash.test.ts`).
 */

const pt = ptBR as Record<string, string>;
const jamKeys = Object.keys(pt).filter((key) => key.startsWith("jam."));

// Third person, about "cada pessoa": "a sua parte" is not a form of address.
const THIRD_PERSON = new Set(["jam.howto.one.body", "jam.add.detail"]);
const FORMAL_YOU = /\b(voc[eê]s?|seu|seus|sua|suas)\b/i;

describe("pt-BR jam copy", () => {
  it("has jam keys to check", () => {
    expect(jamKeys.length).toBeGreaterThan(200);
  });

  it("never addresses the person as voce, seu or sua", () => {
    const offenders = jamKeys.filter((key) => !THIRD_PERSON.has(key) && FORMAL_YOU.test(pt[key]!));
    expect(offenders).toEqual([]);
  });

  it("the roles corner card says tu too", () => {
    expect(pt["cargosHint.body"]).toBe("Clica na pessoa e marca um: Adm, Gerente, Mod ou VIP. Os que tu criar ficam junto.");
    expect(pt["cargosHint.body"]).not.toMatch(FORMAL_YOU);
  });

  it("a recording is feminine: it is 'ela' that goes away", () => {
    expect(pt["jam.take.deleteBody"]).toBe("Ela some da música pra todo mundo.");
    expect(pt["jam.take.deleteTitle"]).toMatch(/gravação/);
  });

  it("every English jam key is in pt-BR, so a new string cannot ship untranslated", () => {
    const missing = Object.keys(en).filter((key) => key.startsWith("jam.") && !(key in pt));
    expect(missing).toEqual([]);
  });

  it("the start sheet's examples are invented: a product strict about rights does not name a real song or band", () => {
    const REAL = /nirvana|in bloom|beatles|radiohead|coldplay|queen|metallica|legi[aã]o urbana|djavan|caetano|gilberto gil/i;
    for (const catalogue of [en, ptBR, es] as Array<Record<string, string>>) {
      for (const key of ["jam.start.songTitlePlaceholder", "jam.start.artistPlaceholder"]) {
        expect(catalogue[key], key).toBeTruthy();
        expect(catalogue[key]).not.toMatch(REAL);
      }
    }
  });

  it("the first take's timing words are plain (no slang that reads as an error) and short enough for a 390 px lane", () => {
    for (const catalogue of [en, ptBR, es] as Array<Record<string, string>>) {
      expect(catalogue["jam.latency.chipLabelEstimate"]).not.toMatch(/chutou|guess|adivin/i);
      expect(catalogue["jam.latency.chipLabelEstimate"]).toMatch(/estimad|estimated/i);
      // the lane's own label sits beside a 14 px icon in a column a phone leaves about 80 px for
      const short = catalogue["jam.review.estimatedShort"]!;
      expect(short.length).toBeLessThanOrEqual(10);
      expect(short).not.toMatch(/\.\.\.|…/);
    }
  });
});
