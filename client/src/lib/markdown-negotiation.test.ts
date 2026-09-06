import { describe, expect, it } from "vitest";

import { markdownTwinFor, prefersMarkdown } from "@/lib/markdown-negotiation";

describe("markdownTwinFor", () => {
  it("gives the landing page its twin, with or without the trailing slash", () => {
    expect(markdownTwinFor("/")).toBe("/index.md");
    expect(markdownTwinFor("")).toBe("/index.md");
  });

  it("gives nothing to a page that has no written twin", () => {
    expect(markdownTwinFor("/vs-discord")).toBeNull();
    expect(markdownTwinFor("/@rafa")).toBeNull();
    expect(markdownTwinFor("/app")).toBeNull();
    expect(markdownTwinFor("/index.md")).toBeNull();
  });
});

describe("prefersMarkdown", () => {
  it("serves HTML to a browser, which is the whole point of the q comparison", () => {
    expect(
      prefersMarkdown(
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      ),
    ).toBe(false);
  });

  it("serves HTML when there is no Accept header at all", () => {
    expect(prefersMarkdown(null)).toBe(false);
    expect(prefersMarkdown("")).toBe(false);
  });

  it("answers an explicit markdown ask", () => {
    expect(prefersMarkdown("text/markdown")).toBe(true);
    expect(prefersMarkdown("text/markdown, text/html;q=0.5")).toBe(true);
    expect(prefersMarkdown("TEXT/MARKDOWN")).toBe(true);
    expect(prefersMarkdown("text/x-markdown")).toBe(true);
  });

  it("keeps HTML when markdown is only an equal or lesser alternative", () => {
    expect(prefersMarkdown("text/html, text/markdown")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0.5, text/html")).toBe(false);
  });

  it("ignores a markdown entry the client explicitly refused", () => {
    expect(prefersMarkdown("text/markdown;q=0, text/html;q=0.1")).toBe(false);
  });

  it("does not let */* stand in for a markdown ask", () => {
    expect(prefersMarkdown("*/*")).toBe(false);
  });

  it("treats a malformed q as absent rather than as a refusal", () => {
    expect(prefersMarkdown("text/markdown;q=banana, text/html;q=0.5")).toBe(true);
  });
});
