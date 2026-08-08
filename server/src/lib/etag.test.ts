import { describe, expect, it } from "vitest";
import { computeEtag, etagged, Etagged, ifNoneMatchSatisfiedBy } from "./etag.js";

describe("computeEtag", () => {
  it("is stable for identical bytes and different for a one-character change", () => {
    const a = JSON.stringify({ messages: [{ id: "1", body: "hi" }] });
    const b = JSON.stringify({ messages: [{ id: "1", body: "ho" }] });
    expect(computeEtag(a)).toBe(computeEtag(a));
    expect(computeEtag(a)).not.toBe(computeEtag(b));
  });

  it("changes when a message is edited without the newest id moving", () => {
    // The exact case a "newest id + count" watermark would miss, which is why
    // the validator hashes the payload instead.
    const before = JSON.stringify({
      messages: [
        { id: "a", body: "one" },
        { id: "b", body: "two" },
      ],
    });
    const after = JSON.stringify({
      messages: [
        { id: "a", body: "one (edited)" },
        { id: "b", body: "two" },
      ],
    });
    expect(computeEtag(before)).not.toBe(computeEtag(after));
  });

  it("is a quoted entity-tag", () => {
    const etag = computeEtag("{}");
    expect(etag.startsWith('"')).toBe(true);
    expect(etag.endsWith('"')).toBe(true);
    // No comma can appear inside, which is what makes the list split safe.
    expect(etag.slice(1, -1)).not.toContain(",");
  });
});

describe("ifNoneMatchSatisfiedBy", () => {
  const etag = computeEtag('{"ok":true}');

  it("misses when the header is absent or empty", () => {
    expect(ifNoneMatchSatisfiedBy(undefined, etag)).toBe(false);
    expect(ifNoneMatchSatisfiedBy("", etag)).toBe(false);
    expect(ifNoneMatchSatisfiedBy("   ", etag)).toBe(false);
  });

  it("matches the same tag, and a weak-prefixed echo of it", () => {
    expect(ifNoneMatchSatisfiedBy(etag, etag)).toBe(true);
    expect(ifNoneMatchSatisfiedBy(`W/${etag}`, etag)).toBe(true);
  });

  it("matches one entry out of a list", () => {
    expect(ifNoneMatchSatisfiedBy(`"other", ${etag}`, etag)).toBe(true);
    expect(ifNoneMatchSatisfiedBy(`"a", "b"`, etag)).toBe(false);
  });

  it("treats * as a match", () => {
    expect(ifNoneMatchSatisfiedBy("*", etag)).toBe(true);
  });

  it("does not match a different tag", () => {
    expect(ifNoneMatchSatisfiedBy(computeEtag("{}"), etag)).toBe(false);
  });

  it("ignores a malformed header rather than matching on it", () => {
    expect(ifNoneMatchSatisfiedBy(",,,", etag)).toBe(false);
  });
});

describe("etagged", () => {
  it("wraps a body without copying it", () => {
    const body = { servers: [] };
    const wrapped = etagged(body);
    expect(wrapped).toBeInstanceOf(Etagged);
    expect(wrapped.body).toBe(body);
  });
});
