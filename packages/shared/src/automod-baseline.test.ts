import { describe, expect, it } from "vitest";
import {
  BASELINE_TEXT_LISTS,
  findBaselineViolation,
} from "./automod-baseline.js";

const blocked = (text: string) => findBaselineViolation(text)?.class ?? null;

describe("baseline text filter: what it blocks", () => {
  it.each([
    ["fuck you, you stupid idiot", "abuse"],
    ["Fuck YOU", "abuse"],
    ["go fuck yourself", "abuse"],
    ["you are a cunt", "abuse"],
    ["vai tomar no cu", "abuse"],
    ["Vai se foder, seu arrombado", "abuse"],
    ["chinga tu madre", "abuse"],
    ["kill yourself", "threat"],
    ["kys", "threat"],
    ["i will rape you", "threat"],
    ["vou te estuprar", "threat"],
    ["te voy a violar", "threat"],
    ["vai se matar", "threat"],
    ["you nigger", "slur"],
    ["those niggas", "slur"],
    ["what a faggot", "slur"],
    ["he is a retard", "slur"],
    ["seu viado", "slur"],
    ["VIADO", "slur"],
    ["que crioulo", "slur"],
    ["eres un maricón", "slur"],
    ["maricon", "slur"],
    ["white power", "slur"],
  ])("blocks %j as %s", (text, cls) => {
    expect(blocked(text)).toBe(cls);
  });

  it("works across Portuguese diacritics and Spanish accents", () => {
    // You can type it with or without the accent, upper or lower.
    expect(blocked("ARROMBADÃO")).toBeNull(); // not on the list: no stem matching
    expect(blocked("Mongolóide")).toBe("slur");
    expect(blocked("mongoloide")).toBe("slur");
    expect(blocked("MARICÓN")).toBe("slur");
    expect(blocked("sapatão")).toBe("slur");
    expect(blocked("retardádo")).toBe("slur");
  });

  it("sees through the usual obfuscation", () => {
    expect(blocked("n1gg3r")).toBe("slur");
    expect(blocked("f@ggot")).toBe("slur");
    expect(blocked("v14d0")).toBe("slur");
    expect(blocked("niiiigger")).toBe("slur");
    expect(blocked("fuuuuck you")).toBe("abuse");
    expect(blocked("f u c k  y o u")).toBe("abuse");
    expect(blocked("n.i.g.g.e.r")).toBe("slur");
    expect(blocked("k y s")).toBe("threat");
    expect(blocked("fuckyou")).toBe("abuse");
    expect(blocked("vaitomarnocu")).toBe("abuse");
    // Zero-width and fullwidth and Cyrillic lookalikes.
    expect(blocked("ni​gger")).toBe("slur");
    expect(blocked("ｋｉｌｌ ｙｏｕｒｓｅｌｆ")).toBe("threat");
    expect(blocked("fаggot")).toBe("slur"); // Cyrillic а
    expect(blocked("c.u.n.t")).toBe("abuse");
    expect(blocked("sandnigger")).toBe("slur");
  });

  it("blocks inside a longer sentence and across punctuation", () => {
    expect(blocked("lol you know what, fuck you!!!")).toBe("abuse");
    expect(blocked("Kill-yourself")).toBe("threat");
    expect(blocked("ola\nvai tomar no cu\nflw")).toBe("abuse");
  });
});

describe("baseline text filter: what it lets through", () => {
  it.each([
    "this is shit",
    "damn it",
    "what the fuck is this boss",
    "fuck, I forgot my keys",
    "puta que pariu, perdi o onibus",
    "que merda de jogo",
    "caralho, ganhei",
    "porra, de novo",
    "filho da puta do lag",
    "mierda, otra vez",
    "joder, qué calor",
    "i'll kill you in this match lol",
    "vou te matar nesse jogo",
    "you stupid idiot",
    "kill it with fire",
    "I hate mondays",
    "good game everyone",
    "olá, tudo bem?",
  ])("lets %j through", (text) => {
    expect(blocked(text)).toBeNull();
  });

  it("never matches inside a word", () => {
    for (const text of [
      "Scunthorpe",
      "the assassin class",
      "classic title",
      "cocktail",
      "analysis of the Niger river",
      "Niger and Nigeria",
      "viaduto novo",
      "o macaco no zoo",
      "um veado na floresta",
      "a mongol empire",
      "o voo está retrasado",
      "spic and span",
      "he sniggered",
      "she was sniggering",
      "fagot de lenha",
      "peace",
    ]) {
      expect(blocked(text), text).toBeNull();
    }
  });

  it("leaves numbers, versions, mentions and exclamation marks alone", () => {
    for (const text of [
      "1234 5678",
      "v1.5.0 shipped!",
      "@bob look at this!",
      "win 10 or 11?",
      "hello!world",
      "gg wp!!!",
      "",
      "   ",
      "😂😂😂",
    ]) {
      expect(blocked(text), text).toBeNull();
    }
  });

  it("does not hang on a hostile long body", () => {
    const started = Date.now();
    findBaselineViolation("a ".repeat(20_000));
    findBaselineViolation("x".repeat(100_000));
    findBaselineViolation("1!@$".repeat(20_000));
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("baseline text filter: the lists themselves", () => {
  it("never states a word as a stem that would catch an ordinary one", () => {
    // Every entry blocks itself, so the lists and the matcher cannot drift.
    for (const [cls, entries] of Object.entries(BASELINE_TEXT_LISTS)) {
      for (const entry of entries) {
        const sample = entry.replace(/\*/g, "");
        expect(blocked(sample), `${cls}: ${entry}`).not.toBeNull();
      }
    }
  });
});
