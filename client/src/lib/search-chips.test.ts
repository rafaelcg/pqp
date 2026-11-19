import { describe, expect, it } from "vitest";
import { addChip, chipFilters, matchByName, searchWords, trailingChipToken } from "./search-chips";

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
});
