import { describe, expect, it } from "vitest";
import { COMMUNITY_CATEGORIES, type CommunitySummary } from "@pqp/shared";
import { en } from "@/lib/i18n/catalogue";
import { ptBR } from "@/lib/i18n/messages.pt-BR";
import {
  applyJoin,
  cardAction,
  categoryChips,
  emptyStateKeys,
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
    tagline: null,
    category: "geral",
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
