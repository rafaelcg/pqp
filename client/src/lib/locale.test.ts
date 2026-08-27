import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { detectLocale } from "./locale";

/**
 * The regression these cover is not hypothetical: on 2026-08-27 pqp.gg served
 * `<title>pqp: o chat em grupo é seu</title>` to a fetch with no
 * `Accept-Language` and rendered `pqp: group chat you own` in a headless
 * Chrome reporting `navigator.languages === ["en-US"]`. That rendered DOM is
 * what a search engine indexes, and the document body is JS-only, so English
 * was the only copy an index could hold for a Portuguese-first site.
 */
interface Stubs {
  search?: string;
  stored?: string | null;
  servedLocale?: string | null;
  navigatorLanguages?: string[];
}

function stub({
  search = "",
  stored = null,
  servedLocale = null,
  navigatorLanguages = [],
}: Stubs) {
  vi.stubGlobal("window", {
    location: { search },
    localStorage: {
      getItem: () => stored,
      setItem: () => {},
      removeItem: () => {},
    },
  });
  vi.stubGlobal("document", {
    querySelector: (selector: string) =>
      selector === 'meta[name="pqp:locale"]' && servedLocale !== null
        ? { getAttribute: () => servedLocale }
        : null,
  });
  vi.stubGlobal("navigator", { languages: navigatorLanguages });
}

describe("detectLocale", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("takes the locale the edge stamped over the browser's own languages", () => {
    // Googlebot's two clients disagreeing: the fetch got the Portuguese head,
    // the renderer says en-US. Before this step the app booted English and
    // `Seo` overwrote the Portuguese head with the English one.
    stub({ servedLocale: "pt-BR", navigatorLanguages: ["en-US"] });
    expect(detectLocale()).toBe("pt-BR");
  });

  it("still honours an edge decision of English", () => {
    stub({ servedLocale: "en", navigatorLanguages: ["pt-BR"] });
    expect(detectLocale()).toBe("en");
  });

  it("lets ?lang= and a saved preference outrank the edge", () => {
    stub({ search: "?lang=en", servedLocale: "pt-BR" });
    expect(detectLocale()).toBe("en");

    stub({ stored: "en", servedLocale: "pt-BR" });
    expect(detectLocale()).toBe("en");
  });

  it("falls through to the browser on a route the edge does not rewrite", () => {
    // `/app` gets no injected head, so there is no stamp to read and the
    // browser is the only signal left — unchanged behaviour.
    stub({ navigatorLanguages: ["pt-BR", "en-US"] });
    expect(detectLocale()).toBe("pt-BR");

    stub({ navigatorLanguages: ["en-GB"] });
    expect(detectLocale()).toBe("en");
  });

  it("ignores a stamp it cannot parse rather than failing to boot", () => {
    stub({ servedLocale: "klingon", navigatorLanguages: ["pt-BR"] });
    expect(detectLocale()).toBe("pt-BR");
  });
});
