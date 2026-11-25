import { describe, expect, it } from "vitest";
import { pickFeatured } from "./featured";

const s = (id: string, artist: string | null, parts = 1) => ({
  id,
  artist,
  parts: Array.from({ length: parts }, () => ({})) as never[],
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
  it("keeps the first when it is already an original", () => {
    expect(pickFeatured([s("first", null), s("second", null)])?.id).toBe("first");
  });
  it("is null with nothing to show", () => {
    expect(pickFeatured([])).toBeNull();
    expect(pickFeatured([s("bare", null, 0)])).toBeNull();
  });
});
