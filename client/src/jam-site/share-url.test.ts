import { describe, expect, it } from "vitest";
import { jamShareHref } from "./share-url";

const ID = "0b8f2c1e-4d5a-4e6f-8a7b-1c2d3e4f5a6b";

describe("jamShareHref", () => {
  it("adds ref=share to a song's address", () => {
    expect(jamShareHref(`/jam/m/${ID}`, "https://pqp.gg", null)).toBe(`https://pqp.gg/jam/m/${ID}?ref=share`);
    expect(jamShareHref(`/m/${ID}`, "https://jam.pqp.gg", null)).toBe(`https://jam.pqp.gg/m/${ID}?ref=share`);
  });
  it("keeps the ref the page was opened with", () => {
    expect(jamShareHref(`/m/${ID}`, "https://jam.pqp.gg", { ref: "clip-ana" })).toBe(`https://jam.pqp.gg/m/${ID}?ref=clip-ana`);
    expect(jamShareHref(`/m/${ID}`, "https://jam.pqp.gg", { ref: "share" })).toBe(`https://jam.pqp.gg/m/${ID}?ref=share`);
  });
  it("does not forward utm parameters, and says share when only those were there", () => {
    expect(jamShareHref(`/m/${ID}`, "https://jam.pqp.gg", { utm_source: "tiktok", utm_medium: "social" })).toBe(
      `https://jam.pqp.gg/m/${ID}?ref=share`,
    );
    expect(jamShareHref(`/m/${ID}`, "https://jam.pqp.gg", { ref: "x", utm_source: "tiktok" })).toBe(`https://jam.pqp.gg/m/${ID}?ref=x`);
  });
  it("replaces a ref already on the path instead of doubling it", () => {
    expect(jamShareHref(`/m/${ID}?ref=old`, "https://jam.pqp.gg", null)).toBe(`https://jam.pqp.gg/m/${ID}?ref=share`);
  });
});
