import { describe, expect, it } from "vitest";
import { coverEtag, parseRange } from "./public-bau-cover.js";

/**
 * The two pure halves of the cover route. The wire behaviour (200, 206, 304,
 * 416, HEAD, the size cap, a hung-up viewer) is pinned against a real Postgres
 * in `public-bau-post.test.ts`; this is the arithmetic, which is where an
 * off-by-one would otherwise hide behind a test that happens to ask for
 * `bytes=0-99`.
 */

describe("parseRange", () => {
  const LENGTH = 1000;

  it("reads a closed, an open and a suffix range", () => {
    expect(parseRange("bytes=0-99", LENGTH)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=900-", LENGTH)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-100", LENGTH)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=0-0", LENGTH)).toEqual({ start: 0, end: 0 });
    expect(parseRange("bytes=999-999", LENGTH)).toEqual({ start: 999, end: 999 });
  });

  it("clamps what runs past the end", () => {
    expect(parseRange("bytes=900-5000", LENGTH)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-5000", LENGTH)).toEqual({ start: 0, end: 999 });
  });

  it("calls a start at or past the end unsatisfiable, and so is a zero suffix", () => {
    expect(parseRange("bytes=1000-", LENGTH)).toBe("unsatisfiable");
    expect(parseRange("bytes=1000-2000", LENGTH)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", LENGTH)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
    expect(parseRange("bytes=-5", 0)).toBe("unsatisfiable");
  });

  it("ignores what it cannot honour as one range, so the caller sends the whole body", () => {
    for (const header of [
      undefined,
      "",
      "bytes=",
      "bytes=-",
      "bytes=5-2",
      "bytes=0-9,20-29",
      "items=0-9",
      "bytes=a-b",
      "bytes= 0-9",
      "bytes=0-9;",
      `bytes=${"9".repeat(40)}-`,
    ]) {
      expect(parseRange(header, LENGTH), String(header)).toBeNull();
    }
  });

  it("tolerates surrounding whitespace on the header, as a proxy may leave it", () => {
    expect(parseRange("  bytes=0-9  ", LENGTH)).toEqual({ start: 0, end: 9 });
  });
});

describe("coverEtag", () => {
  it("is a quoted strong validator, stable per key and different between keys", () => {
    const a = coverEtag("community-home/s1/a.png");
    expect(a).toMatch(/^"[0-9a-f]{32}"$/);
    expect(coverEtag("community-home/s1/a.png")).toBe(a);
    expect(coverEtag("community-home/s1/b.png")).not.toBe(a);
  });

  it("does not carry the key, so the bucket path is not published by a header", () => {
    expect(coverEtag("community-home/s1/a.png")).not.toContain("community-home");
  });
});
