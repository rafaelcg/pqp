// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { Seo } from "./seo";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hreflangs = () =>
  [...document.head.querySelectorAll("link[rel='alternate'][hreflang]")]
    .map((l) => l.getAttribute("hreflang"))
    .sort();

describe("Seo alternates across client-side navigation", () => {
  it("drops the es alternate when the next page has no Spanish copy", async () => {
    const root = createRoot(document.createElement("div"));
    const show = (path: string) =>
      act(async () => {
        root.render(<Seo title="t" description="d" path={path} />);
      });
    await show("/");
    expect(hreflangs()).toContain("es");
    await show("/privacy");
    expect(hreflangs()).toEqual(["en", "pt-BR", "x-default"]);
    await show("/");
    expect(hreflangs()).toContain("es");
  });
});
