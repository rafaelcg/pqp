import { describe, expect, it } from "vitest";
import { firstResultFromHtml } from "./music.js";

describe("firstResultFromHtml", () => {
  it("reads the first videoRenderer's id and title", () => {
    const html =
      'junk {"videoRenderer":{"videoId":"abcdefghijk","thumbnail":{},"title":{"runs":[{"text":"Legi\\u00e3o Urbana - Tempo Perdido"}]}}} ' +
      '{"videoRenderer":{"videoId":"zzzzzzzzzzz","title":{"runs":[{"text":"second"}]}}}';
    expect(firstResultFromHtml(html)).toEqual({
      videoId: "abcdefghijk",
      title: "Legião Urbana - Tempo Perdido",
      thumbnailUrl: "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
    });
  });

  it("returns null on a page with no results", () => {
    expect(firstResultFromHtml("<html></html>")).toBeNull();
  });
});
