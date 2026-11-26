import { describe, expect, it } from "vitest";
import { pickFeatured, pickWantingParts, takesParts } from "./featured";

type Mode = "open" | "wanted" | "closed";
const s = (id: string, artist: string | null, parts = 1, joinMode: Mode = "open") => ({
  id,
  artist,
  joinMode,
  parts: Array.from({ length: parts }, () => ({})) as never[],
});

describe("takesParts", () => {
  it("is false only for a closed song, and true when the field is absent (an older server)", () => {
    expect(takesParts({ joinMode: "open" })).toBe(true);
    expect(takesParts({ joinMode: "wanted" })).toBe(true);
    expect(takesParts({ joinMode: "closed" })).toBe(false);
    expect(takesParts({} as { joinMode: "open" })).toBe(true);
  });
});

describe("pickFeatured", () => {
  it("prefers the first original over a more liked cover", () => {
    expect(pickFeatured([s("cover", "Some Band"), s("orig", null), s("orig2", null)])?.id).toBe("orig");
  });
  it("is the first song with a part when every song is a cover", () => {
    expect(pickFeatured([s("empty", "A", 0), s("one", "B"), s("two", "C")])?.id).toBe("one");
  });
  it("skips an original with no part to show", () => {
    expect(pickFeatured([s("bare", null, 0), s("cover", "A"), s("orig", null)])?.id).toBe("orig");
  });
  it("keeps the first when it is already an original that takes a part", () => {
    expect(pickFeatured([s("first", null), s("second", null)])?.id).toBe("first");
  });
  it("is null with nothing to show", () => {
    expect(pickFeatured([])).toBeNull();
    expect(pickFeatured([s("bare", null, 0)])).toBeNull();
  });

  it("passes over a closed original for an original that takes a part, even further down", () => {
    expect(pickFeatured([s("closed", null, 1, "closed"), s("cover", "A"), s("wanted", null, 1, "wanted")])?.id).toBe("wanted");
  });
  it("prefers a closed original to an open cover (the cover is the rights risk)", () => {
    expect(pickFeatured([s("cover", "A"), s("closed", null, 1, "closed")])?.id).toBe("closed");
  });
  it("with no original, passes over a closed cover for one that takes a part", () => {
    expect(pickFeatured([s("closed", "A", 1, "closed"), s("open", "B")])?.id).toBe("open");
  });
  it("is the first song when everything is closed", () => {
    expect(pickFeatured([s("a", "A", 1, "closed"), s("b", "B", 1, "closed")])?.id).toBe("a");
  });
});

describe("pickWantingParts", () => {
  const w = (id: string, joinMode: Mode, needs: string[] = [], parts = 1) => ({
    id,
    joinMode,
    needs: needs as never[],
    parts: Array.from({ length: parts }, () => ({})) as never[],
  });

  it("is empty when the hero takes a part, or there is no hero", () => {
    expect(pickWantingParts([w("a", "wanted", ["bass"])], { id: "h", joinMode: "open" })).toEqual([]);
    expect(pickWantingParts([w("a", "wanted", ["bass"])], { id: "h", joinMode: "wanted" })).toEqual([]);
    expect(pickWantingParts([w("a", "wanted", ["bass"])], null)).toEqual([]);
  });
  it("is empty when no other song takes a part", () => {
    expect(pickWantingParts([w("h", "closed"), w("c", "closed"), w("e", "open", [], 0)], { id: "h", joinMode: "closed" })).toEqual([]);
  });
  it("leaves out a wanted song with nothing missing: it takes only listed instruments the payload does not name", () => {
    const hero = w("h", "closed");
    expect(pickWantingParts([hero, w("filled", "wanted", [])], hero)).toEqual([]);
    expect(pickWantingParts([hero, w("filled", "wanted", []), w("open", "open")], hero).map((song) => song.id)).toEqual(["open"]);
  });
  it("lists songs that ask for an instrument first, then open ones, never the hero or a closed one, at most three", () => {
    const hero = w("h", "closed");
    const list = [hero, w("open1", "open"), w("c", "closed"), w("ask1", "wanted", ["bass"]), w("ask2", "wanted", ["keys"]), w("ask3", "wanted", ["drums"]), w("open2", "open")];
    expect(pickWantingParts(list, hero).map((song) => song.id)).toEqual(["ask1", "ask2", "ask3"]);
    expect(pickWantingParts(list, hero, 5).map((song) => song.id)).toEqual(["ask1", "ask2", "ask3", "open1", "open2"]);
  });
});
