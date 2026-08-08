import { describe, expect, it } from "vitest";
import {
  COMMUNITY_CATEGORIES,
  COMMUNITY_LANGUAGES,
  type CommunitySummary,
} from "@pqp/shared";
import { en } from "@/lib/i18n/catalogue";
import { ptBR } from "@/lib/i18n/messages.pt-BR";
import {
  applyJoin,
  cardAction,
  categoryChips,
  communityHue,
  defaultLanguageFilter,
  emptyStateKeys,
  formatMemberCount,
  languageSegments,
  memberCountKey,
  mergePages,
  monogram,
} from "./communities-model";

function community(
  id: string,
  overrides: Partial<CommunitySummary> = {},
): CommunitySummary {
  return {
    id: `00000000-0000-4000-8000-${id.padStart(12, "0")}`,
    name: `Community ${id}`,
    slug: `community-${id}`,
    tagline: null,
    category: "geral",
    language: "pt",
    memberCount: 5,
    joined: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    iconUrl: null,
    bannerUrl: null,
    ...overrides,
  };
}

describe("categoryChips", () => {
  it("puts `all` first and keeps the declared slug order after it", () => {
    const chips = categoryChips(null);
    expect(chips[0]!.id).toBeNull();
    expect(chips.slice(1).map((c) => c.id)).toEqual([...COMMUNITY_CATEGORIES]);
  });

  it("marks exactly one chip active", () => {
    expect(categoryChips(null).filter((c) => c.active)).toHaveLength(1);
    const humor = categoryChips("humor");
    expect(humor.filter((c) => c.active)).toHaveLength(1);
    expect(humor.find((c) => c.active)!.id).toBe("humor");
  });

  it("has a translated label for every chip, in both catalogues", () => {
    // The reason the keys are derived rather than listed: a category with no
    // label would render its own slug at a Brazilian, which is the one failure
    // mode a directory built for Brazil cannot have.
    for (const chip of categoryChips(null)) {
      expect(en[chip.labelKey]).toBeTruthy();
      expect(ptBR[chip.labelKey]).toBeTruthy();
    }
  });
});

describe("languageSegments", () => {
  it("lists the languages first and the escape hatch last", () => {
    // The opposite order to the chip row, and deliberately — see the note on
    // `languageSegments`. "todos" is the step OUT of a working default, so it
    // does not get the position the eye starts from.
    const segments = languageSegments("pt");
    expect(segments.map((s) => s.id)).toEqual([...COMMUNITY_LANGUAGES, null]);
  });

  it("marks exactly one segment active, including the `all` one", () => {
    expect(languageSegments("pt").filter((s) => s.active)).toHaveLength(1);
    expect(languageSegments("en").find((s) => s.active)!.id).toBe("en");
    expect(languageSegments(null).find((s) => s.active)!.id).toBeNull();
  });

  it("has a translated label for every segment, in both catalogues", () => {
    for (const segment of languageSegments(null)) {
      expect(en[segment.labelKey]).toBeTruthy();
      expect(ptBR[segment.labelKey]).toBeTruthy();
    }
  });
});

describe("defaultLanguageFilter", () => {
  it("opens a Brazilian on Portuguese and everyone else on everything", () => {
    // The asymmetry is the point: a pt-BR reader defaulted to "all" gets rooms
    // they cannot talk in mixed into the grid, and an English reader defaulted
    // to "en" would see one room and conclude the product is empty.
    expect(defaultLanguageFilter("pt-BR")).toBe("pt");
    expect(defaultLanguageFilter("en")).toBeNull();
  });
});

describe("cardAction", () => {
  it("offers `open` for a community you are already in", () => {
    expect(cardAction({ joined: true })).toBe("open");
    expect(cardAction({ joined: false })).toBe("join");
  });
});

describe("monogram", () => {
  it("takes the first letter of the first two words", () => {
    expect(monogram("Eu odeio acordar cedo")).toBe("EO");
    expect(monogram("Discografias")).toBe("D");
  });

  it("survives an emoji first character rather than splitting a surrogate pair", () => {
    // `name[0]` on "🎮 Games" is half a code point and renders as a tofu box.
    expect(monogram("🎮 Games")).toBe("🎮G");
  });

  it("falls back rather than returning an empty string", () => {
    expect(monogram("   ")).toBe("?");
  });
});

describe("emptyStateKeys", () => {
  it("adds the search hint only when something was typed", () => {
    expect(emptyStateKeys("").hint).toBeNull();
    // A brand-new community is search-only until somebody else joins, so this
    // hint is real advice rather than a shrug.
    expect(emptyStateKeys("acordar").hint).toBe(
      "communities.empty.searchHint",
    );
  });

  it("names keys that exist in both catalogues", () => {
    const keys = emptyStateKeys("x");
    for (const key of [keys.title, keys.body, keys.hint!]) {
      expect(en[key]).toBeTruthy();
      expect(ptBR[key]).toBeTruthy();
    }
  });
});

describe("mergePages", () => {
  it("appends without duplicating a row the shifting order key repeated", () => {
    const first = [community("1"), community("2")];
    const second = [community("2"), community("3")];
    expect(mergePages(first, second).map((c) => c.id)).toEqual([
      community("1").id,
      community("2").id,
      community("3").id,
    ]);
  });

  it("keeps the fresher copy on a collision", () => {
    const stale = [community("1", { memberCount: 5, joined: false })];
    const fresh = [community("1", { memberCount: 9, joined: true })];
    const merged = mergePages(stale, fresh);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.memberCount).toBe(9);
    expect(merged[0]!.joined).toBe(true);
  });

  it("does not re-sort — the server owns the ranking", () => {
    const page = [community("9", { memberCount: 1 }), community("1", { memberCount: 99 })];
    expect(mergePages([], page).map((c) => c.memberCount)).toEqual([1, 99]);
  });
});

describe("applyJoin", () => {
  it("flips the card and bumps the count it now disagrees with", () => {
    const before = [community("1", { memberCount: 5 }), community("2")];
    const after = applyJoin(before, community("1").id);
    expect(after[0]!.joined).toBe(true);
    expect(after[0]!.memberCount).toBe(6);
    expect(after[1]).toEqual(before[1]);
  });

  it("is a no-op on a community already joined, so a retry cannot double-count", () => {
    const before = [community("1", { joined: true, memberCount: 6 })];
    expect(applyJoin(before, community("1").id)[0]!.memberCount).toBe(6);
  });
});

describe("memberCountKey", () => {
  it("uses a singular key, because Portuguese will not take `1 membros`", () => {
    expect(memberCountKey(1)).toBe("communities.members.one");
    expect(memberCountKey(0)).toBe("communities.members");
    expect(memberCountKey(2)).toBe("communities.members");
  });
});

describe("the community strings", () => {
  it("are translated into pt-BR, all of them", () => {
    // This feature exists for Brazil; an untranslated string here is not a
    // graceful fallback, it is the product failing in its target market.
    const communityKeys = Object.keys(en).filter((key) =>
      key.startsWith("communities."),
    );
    expect(communityKeys.length).toBeGreaterThan(20);
    for (const key of communityKeys) {
      expect(ptBR[key as keyof typeof ptBR]).toBeTruthy();
    }
  });

  it("says out loud that listing makes the server public and joinable", () => {
    // The copy requirement from the research doc, pinned: an owner must be told
    // what the switch does before they flip it, in words, not by implication.
    const explainer = ptBR["communities.settings.explainer"]!;
    expect(explainer).toContain("público");
    expect(explainer).toContain("sem convite");
    expect(en["communities.settings.explainer"]).toContain("no invite");
  });

  it("tells the owner that reports go past them", () => {
    expect(ptBR["communities.settings.explainerModeration"]).toContain(
      "quem cuida do pqp",
    );
  });

  it("tells a reporter their report does not reach the owner", () => {
    expect(ptBR["communities.reportBody"]).toContain("não pro dono");
  });
});

describe("categoryChips emoji", () => {
  it("gives every chip a glyph, including the sweep chip", () => {
    // The glyph map is typed as a total record over the slugs, so a category
    // added without one does not compile. This is the runtime half: the `all`
    // chip has no slug to look up and would otherwise be the single hole.
    for (const chip of categoryChips(null)) {
      expect(chip.emoji.length).toBeGreaterThan(0);
    }
  });

  it("does not reuse a glyph between two categories", () => {
    // Two categories sharing a glyph is worse than neither having one: the row
    // then teaches that the picture means nothing.
    const emojis = categoryChips(null).map((c) => c.emoji);
    expect(new Set(emojis).size).toBe(emojis.length);
  });
});

describe("formatMemberCount", () => {
  it("leaves small counts exact, in both locales", () => {
    // A directory of small rooms is the common case, and "842" abbreviated to
    // anything is a number made worse.
    expect(formatMemberCount(7, "pt-BR")).toBe("7");
    expect(formatMemberCount(842, "en")).toBe("842");
  });

  it("abbreviates in the reader's own language", () => {
    // The whole reason this goes through Intl: Portuguese says "1,2 mil", with
    // a comma and a word, and every hand-rolled `k` suffix gets that wrong.
    // The space before "mil" is U+00A0 — Intl's own, and the thing that keeps
    // the number from wrapping away from its unit at the end of a card.
    expect(formatMemberCount(1200, "pt-BR")).toBe("1,2\u00a0mil");
    expect(formatMemberCount(1200, "en")).toBe("1.2K");
  });

  it("keeps a big count to one decimal rather than rounding it away", () => {
    expect(formatMemberCount(128_734, "en")).toBe("128.7K");
    expect(formatMemberCount(128_734, "pt-BR")).toBe("128,7\u00a0mil");
  });
});

describe("communityHue", () => {
  it("is stable for an id across calls", () => {
    // The tint has to survive a reload, a second page and another device, or
    // the card people learned to aim at changes colour under them.
    const id = "00000000-0000-4000-8000-000000000abc";
    expect(communityHue(id)).toBe(communityHue(id));
  });

  it("always lands inside the colour wheel", () => {
    for (let i = 0; i < 200; i += 1) {
      const hue = communityHue(`community-${i}-${"x".repeat(i % 17)}`);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(Number.isInteger(hue)).toBe(true);
    }
  });

  it("spreads ids across the wheel rather than clustering", () => {
    // A hash that answers "40" for everything would compile, pass the two tests
    // above, and produce a grid of identical cards.
    const hues = new Set(
      Array.from({ length: 60 }, (_, i) => communityHue(`server-${i}`)),
    );
    expect(hues.size).toBeGreaterThan(30);
  });
});
