import { describe, expect, it } from "vitest";
import {
  addPortugueseKeywords,
  buildPortugueseIndex,
  emptySearchStyle,
  foldAccents,
  portugueseTokens,
  type SearchableEmoji,
} from "./emoji-search-pt";

const CAT = { label: "gato", tags: ["animal", "felino"], unicode: "\u{1F408}️" };
const HEART = {
  label: "coração vermelho",
  tags: ["amor", "coração", "paixão"],
  unicode: "❤️",
};
const LAUGH = {
  label: "rosto rindo muito",
  tags: ["rir", "gargalhada", "dia de sol"],
  unicode: "\u{1F606}",
};

function emoji(id: string, native: string, extra: Partial<SearchableEmoji> = {}) {
  return { id, skins: [{ native }], ...extra } satisfies SearchableEmoji;
}

describe("portugueseTokens", () => {
  it("lowercases, splits phrases and adds an accent-free twin", () => {
    const tokens = portugueseTokens(HEART);
    expect(tokens).toContain("coração");
    expect(tokens).toContain("coracao");
    expect(tokens).toContain("paixao");
    expect(tokens).toContain("vermelho");
  });

  it("drops filler words that would match everything as a prefix", () => {
    const tokens = portugueseTokens(LAUGH);
    expect(tokens).toContain("sol");
    expect(tokens).not.toContain("de");
  });

  it("folds accents", () => {
    expect(foldAccents("coração")).toBe("coracao");
  });
});

describe("addPortugueseKeywords", () => {
  const index = buildPortugueseIndex([CAT, HEART, LAUGH]);

  it("matches the emoji across data that has the variation selector or not", () => {
    const emojis = { cat2: emoji("cat2", "\u{1F408}") };
    expect(addPortugueseKeywords(emojis, index)).toBe(1);
    expect(emojis.cat2.keywords).toContain("gato");
  });

  it("feeds keywords while emoji-mart has not built its search string yet", () => {
    const emojis = { heart: emoji("heart", "❤", { keywords: ["love"] }) };
    addPortugueseKeywords(emojis, index);
    expect(emojis.heart.keywords).toEqual(
      expect.arrayContaining(["love", "coração", "coracao", "amor"]),
    );
  });

  it("appends to the search string once emoji-mart has built it", () => {
    const emojis = {
      cat2: emoji("cat2", "\u{1F408}", { search: ",cat2,cat,animal" }),
    };
    addPortugueseKeywords(emojis, index);
    const tokens = (emojis.cat2.search ?? "").split(",");
    expect(tokens).toContain("gato");
    expect(tokens).toContain("felino");
    // `animal` was already there and is not doubled.
    expect(tokens.filter((token) => token === "animal")).toHaveLength(1);
  });

  it("is a no-op the second time", () => {
    const emojis = { cat2: emoji("cat2", "\u{1F408}", { search: ",cat" }) };
    addPortugueseKeywords(emojis, index);
    const once = emojis.cat2.search;
    expect(addPortugueseKeywords(emojis, index)).toBe(0);
    expect(emojis.cat2.search).toBe(once);
  });

  it("leaves emoji the Portuguese set does not know alone", () => {
    const emojis = { odd: emoji("odd", "\u{1F9FF}") };
    expect(addPortugueseKeywords(emojis, index)).toBe(0);
    expect(emojis.odd).not.toHaveProperty("keywords");
  });
});

describe("the real Portuguese data set", () => {
  it("lets gato, coração, coracao and rir find something", async () => {
    const pt = (await import("emojibase-data/pt/compact.json")).default;
    const index = buildPortugueseIndex(pt as never);
    const haystack = (word: string) =>
      [...index.values()].some((tokens) => tokens.some((token) => token.startsWith(word)));
    for (const word of ["gato", "coração", "coracao", "rir", "cachorro"]) {
      expect(haystack(word), word).toBe(true);
    }
  });
});

describe("emptySearchStyle", () => {
  it("targets the empty result list and quotes the message safely", () => {
    const css = emptySearchStyle('Nenhum "emoji"');
    expect(css).toContain(".padding-small:empty::after");
    expect(css).toContain('content: "Nenhum \\"emoji\\""');
  });
});
