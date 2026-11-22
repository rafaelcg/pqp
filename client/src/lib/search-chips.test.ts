import { describe, expect, it } from "vitest";
import {
  addChip,
  chipFilters,
  extractTypedChips,
  matchByName,
  searchWords,
  trailingChipToken,
  uniqueMatch,
  type SearchChip,
  type SearchChipKind,
} from "./search-chips";

describe("search chips", () => {
  it("reads the filter being typed at the end only", () => {
    expect(trailingChipToken("mapa de:bi")).toEqual({ kind: "de", partial: "bi", start: 5 });
    expect(trailingChipToken("tem:")).toEqual({ kind: "tem", partial: "", start: 0 });
    expect(trailingChipToken("de:bia mapa")).toBeNull();
    expect(trailingChipToken("ide:x")).toBeNull();
    expect(trailingChipToken("map from:bi", { de: "from" })).toEqual({ kind: "de", partial: "bi", start: 4 });
    expect(trailingChipToken("ver http:x")).toBeNull();
  });

  it("leaves a half-typed filter out of the words", () => {
    expect(searchWords("mapa novo de:bi")).toBe("mapa novo");
    expect(searchWords("  mapa  ")).toBe("mapa");
  });

  it("keeps one chip per kind and lets em: win over the scope", () => {
    const chips = addChip(
      addChip([{ kind: "de", id: "a", label: "Ana" }], { kind: "de", id: "b", label: "Bia" }),
      { kind: "em", id: "off", label: "off-topic" },
    );
    expect(chips.map((c) => c.label)).toEqual(["Bia", "off-topic"]);
    expect(chipFilters(chips, "general")).toEqual({ authorId: "b", channelId: "off" });
    expect(chipFilters([{ kind: "tem", value: "link", label: "link" }], "general")).toEqual({
      channelId: "general",
      has: "link",
    });
  });

  it("matches names from the start first, ignoring accents and the @", () => {
    const people = [{ n: "Fábio" }, { n: "Bia" }, { n: "Sabia" }];
    expect(matchByName(people, "@bi", (p) => [p.n]).map((p) => p.n)).toEqual(["Bia", "Fábio", "Sabia"]);
    expect(matchByName(people, "fab", (p) => [p.n]).map((p) => p.n)).toEqual(["Fábio"]);
  });

  it("finds the one item a typed value names, and nothing when it names several", () => {
    const people = [{ n: "Ana" }, { n: "Analu" }, { n: "Bia" }, { n: "Dev User" }, { n: "dev_user_bob" }];
    const names = (p: { n: string }) => [p.n];
    expect(uniqueMatch(people, "ana", names)?.n).toBe("Ana");
    expect(uniqueMatch(people, "@bi", names)?.n).toBe("Bia");
    expect(uniqueMatch(people, "anal", names)?.n).toBe("Analu");
    expect(uniqueMatch(people, "dev", names)).toBeNull();
    expect(uniqueMatch(people, "zé", names)).toBeNull();
    expect(uniqueMatch(people, "", names)).toBeNull();
    // More than matchByName's five suggestions still counts as several.
    const many = Array.from({ length: 7 }, (_, i) => ({ n: `bob${i}` }));
    expect(uniqueMatch([...many, { n: "carol" }], "bob", names)).toBeNull();
  });

  it("turns a finished typed filter that names one thing into a chip", () => {
    const resolve = (kind: SearchChipKind, value: string): SearchChip | null =>
      kind === "de" && value === "dev" ? { kind, id: "u1", label: "Dev" } : null;
    expect(extractTypedChips("from:dev eae", { de: "from" }, resolve)).toEqual({
      text: "eae",
      chips: [{ kind: "de", id: "u1", label: "Dev" }],
    });
    expect(extractTypedChips("mapa de:dev novo ", {}, resolve)).toEqual({
      text: "mapa novo ",
      chips: [{ kind: "de", id: "u1", label: "Dev" }],
    });
    // Still being typed at the end: left to the suggestions.
    expect(extractTypedChips("eae from:dev", { de: "from" }, resolve)).toEqual({
      text: "eae from:dev",
      chips: [],
    });
    // Names nobody, or not a filter at all: left as typed.
    expect(extractTypedChips("from:zé eae", { de: "from" }, resolve).chips).toEqual([]);
    expect(extractTypedChips("ver http://x agora", {}, resolve).text).toBe("ver http://x agora");
  });
});
