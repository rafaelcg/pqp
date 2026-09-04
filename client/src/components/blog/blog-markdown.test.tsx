import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { BlogMedia } from "@/components/blog/blog-media";
import { isBlogMediaElement } from "@/components/blog/blog-markdown";

describe("isBlogMediaElement", () => {
  it("recognises a BlogMedia element and nothing else", () => {
    expect(
      isBlogMediaElement(createElement(BlogMedia, { src: "/x.jpg", alt: "" })),
    ).toBe(true);
    expect(isBlogMediaElement(createElement("p", null, "hi"))).toBe(false);
    expect(isBlogMediaElement("hi")).toBe(false);
  });
});
