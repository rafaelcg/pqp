import { describe, expect, it } from "vitest";
import {
  compileKeywords,
  countDistinctMentions,
  evaluateAutomod,
  findBlockedKeyword,
  findInviteLink,
  parseKeyword,
  normalizeForAutomod,
  type AutomodRuleInput,
} from "./automod.js";

const keywords = (
  words: string[],
  allowList: string[] = [],
): AutomodRuleInput => ({
  kind: "keywords",
  keywords: words,
  allowList,
  mentionLimit: 5,
});

const hit = (body: string, words: string[], allow: string[] = []) =>
  findBlockedKeyword(body, compileKeywords(words, allow));

describe("normalizeForAutomod", () => {
  it("lowercases, strips accents and collapses whitespace", () => {
    expect(normalizeForAutomod("  Olá   MUNDO\tção ")).toBe("ola mundo cao");
  });

  it("folds fullwidth and mathematical letters onto ASCII", () => {
    expect(normalizeForAutomod("ｓｃａｍ")).toBe("scam");
    expect(normalizeForAutomod("𝐬𝐜𝐚𝐦")).toBe("scam");
  });

  it("drops zero-width characters inside a word", () => {
    expect(normalizeForAutomod("sc​am")).toBe("scam");
    expect(normalizeForAutomod("s­c⁠a﻿m")).toBe("scam");
  });

  it("strips strikethrough combining marks", () => {
    expect(normalizeForAutomod("s̶c̶a̶m̶")).toBe("scam");
  });

  it("maps Cyrillic and Greek lookalikes, uppercase included", () => {
    expect(normalizeForAutomod("sсаm")).toBe("scam");
    expect(normalizeForAutomod("ροrn")).toBe("porn");
    expect(normalizeForAutomod("SCАM")).toBe("scam");
    expect(normalizeForAutomod("РORN")).toBe("porn");
  });
});

describe("keywords", () => {
  it("no wildcard means whole word", () => {
    expect(hit("a scam here", ["scam"])).toBe("scam");
    expect(hit("scammer", ["scam"])).toBeNull();
    expect(hit("scampi", ["scam"])).toBeNull();
  });

  it("trailing * matches a prefix", () => {
    expect(hit("scammer", ["scam*"])).toBe("scammer");
    expect(hit("no scam", ["scam*"])).toBe("scam");
    expect(hit("ascam", ["scam*"])).toBeNull();
  });

  it("leading * matches a suffix", () => {
    expect(hit("loophole", ["*hole"])).toBe("loophole");
    expect(hit("holes", ["*hole"])).toBeNull();
  });

  it("both ends matches anywhere", () => {
    expect(hit("concatenate", ["*cat*"])).toBe("concatenate");
  });

  it("an interior * spans word characters only", () => {
    expect(hit("sc4m", ["s*m"])).toBe("sc4m");
    expect(hit("so am", ["s*m"])).toBeNull();
  });

  it("a phrase matches across any whitespace", () => {
    expect(hit("claim   your\nprize", ["claim your"])).toBe("claim your");
    expect(hit("claim their prize", ["claim your"])).toBeNull();
  });

  it("word edges are unicode-aware, not ASCII \\b", () => {
    expect(hit("ação", ["aca"])).toBeNull();
    expect(hit("aca o", ["aca"])).toBe("aca");
    expect(hit("被scam", ["scam"])).toBeNull();
  });

  it("drops an entry that is only wildcards or punctuation", () => {
    expect(parseKeyword("*")).toBeNull();
    expect(parseKeyword("***")).toBeNull();
    expect(parseKeyword("!!!")).toBeNull();
    expect(compileKeywords(["*", ""]).isEmpty).toBe(true);
  });

  it("treats regex metacharacters as literals", () => {
    expect(hit("what (lol)", ["(lol)"])).toBe("lol");
    expect(hit("a.b", ["a.b"])).toBe("a.b");
    expect(hit("axb", ["a.b"])).toBeNull();
    expect(hit("aaaa", ["a+"])).toBeNull();
  });

  it("owner input can never stall the matcher", () => {
    // The three shapes a review measured at 46 s, 23 s and 7 s against the
    // regex version. Each must stay in the low milliseconds.
    const longWord = "a".repeat(4000);
    const cases: Array<[string[], string]> = [
      [["a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b"], "a".repeat(40)],
      [Array.from({ length: 1000 }, (_, i) => `*zz${i}`), longWord],
      [Array.from({ length: 1000 }, (_, i) => `a*b*c*d*e*f*g*h*i*j*k*l*m*n*o*p*q*r*s*t*u*v*w*x*y*z${i}`), longWord],
    ];
    for (const [words, body] of cases) {
      const compiled = compileKeywords(words);
      const start = performance.now();
      expect(findBlockedKeyword(body, compiled)).toBeNull();
      expect(performance.now() - start).toBeLessThan(250);
    }
  });

  it("an interior wildcard stays inside one word, in order", () => {
    expect(hit("scxxam", ["s*a*m"])).toBe("scxxam");
    expect(hit("samsc", ["s*a*m"])).toBeNull();
    expect(hit("xsamx", ["*s*m*"])).toBe("xsamx");
  });
});

describe("evasion", () => {
  it("catches case, zero-width, fullwidth and Cyrillic variants", () => {
    for (const body of ["SCAM", "sc​am", "ｓｃａｍ", "sсаm", "SCАM", "𝐒𝐂𝐀𝐌"]) {
      expect(hit(body, ["scam"])).toBe("scam");
    }
  });

  it("catches an accented spelling of an unaccented keyword", () => {
    expect(hit("você é um idiotá", ["idiota"])).toBe("idiota");
  });
});

describe("allow list", () => {
  it("rescues an exact allowed phrase", () => {
    expect(hit("claim your role here", ["claim your"], ["claim your role"])).toBeNull();
    expect(hit("claim your prize", ["claim your"], ["claim your role"])).toBe(
      "claim your",
    );
  });

  it("blanking an allowed span never glues its neighbours into a hit", () => {
    // "sc" + allowed "x" + "am" must not become "scam".
    expect(hit("sc x am", ["scam"], ["x"])).toBeNull();
  });

  it("an allowed word does not rescue a different blocked word", () => {
    expect(hit("scam and spam", ["scam", "spam"], ["spam"])).toBe("scam");
  });
});

describe("findInviteLink", () => {
  it("matches every spelling of a Discord invite", () => {
    for (const body of [
      "join discord.gg/abc123",
      "https://discord.com/invite/abc123",
      "http://www.discordapp.com/invite/abc-123",
      "DISCORD.GG/AbC",
      "dsc.gg/short",
      "disc​ord.gg/abc",
      "ｄiscord.gg/abc",
      "discоrd.gg/abc",
    ]) {
      expect(findInviteLink(body)).not.toBeNull();
    }
  });

  it("ignores discord.com pages that are not invites", () => {
    expect(findInviteLink("see discord.com/developers")).toBeNull();
    expect(findInviteLink("i left discord")).toBeNull();
  });
});

describe("countDistinctMentions", () => {
  it("counts distinct names case-insensitively", () => {
    expect(countDistinctMentions("@a1 @A1 @b2 @everyone @here @b2")).toBe(4);
    expect(countDistinctMentions("no pings")).toBe(0);
  });
});

describe("evaluateAutomod", () => {
  it("returns null when every rule passes", () => {
    expect(evaluateAutomod("hello", [keywords(["scam"])])).toBeNull();
  });

  it("skips a disabled rule", () => {
    expect(
      evaluateAutomod("scam", [{ ...keywords(["scam"]), enabled: false }]),
    ).toBeNull();
  });

  it("returns the first verdict in rule order with the rule's copy", () => {
    const verdict = evaluateAutomod("discord.gg/xy scam", [
      { kind: "invite_links", keywords: [], allowList: [], mentionLimit: 5, id: "r1", customMessage: "No invites" },
      keywords(["scam"]),
    ]);
    expect(verdict).toEqual({
      kind: "invite_links",
      ruleId: "r1",
      matched: "discord.gg/xy",
      customMessage: "No invites",
    });
  });

  it("mention spam trips above the limit, not at it", () => {
    const rule: AutomodRuleInput = {
      kind: "mention_spam",
      keywords: [],
      allowList: [],
      mentionLimit: 2,
    };
    expect(evaluateAutomod("@a1 @b2", [rule])).toBeNull();
    expect(evaluateAutomod("@a1 @b2 @c3", [rule])).toMatchObject({
      kind: "mention_spam",
      matched: "3 mentions",
    });
  });

  it("caches compilation per rule object and stays correct", () => {
    const rule = keywords(["scam*"]);
    expect(evaluateAutomod("scammer", [rule])?.matched).toBe("scammer");
    expect(evaluateAutomod("clean", [rule])).toBeNull();
    expect(evaluateAutomod("SCAMS", [rule])?.matched).toBe("scams");
  });

  it("a thousand keywords is one pass and stays fast", () => {
    const words = Array.from({ length: 1000 }, (_, i) => `palavra${i}*`);
    const rule = keywords(words);
    const body = "uma mensagem normal ".repeat(100) + "palavra999x";
    expect(evaluateAutomod(body, [rule])?.matched).toBe("palavra999x");
    // Compiled once above; this is the steady-state cost per message. The
    // budget is loose on purpose: a shared CI runner is several times slower
    // than a laptop, and a timing assertion that flakes teaches nothing.
    const start = performance.now();
    for (let i = 0; i < 20; i++) {
      evaluateAutomod(body, [rule]);
    }
    expect((performance.now() - start) / 20).toBeLessThan(100);
  });
});
