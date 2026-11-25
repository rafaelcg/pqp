import { describe, expect, it } from "vitest";
import { pickFeatured, takesParts } from "./featured";

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
