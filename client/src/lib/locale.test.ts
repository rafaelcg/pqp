import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { detectLocale, setLocalePreference } from "./locale";

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

  it("reads every Spanish region as the one Spanish catalogue", () => {
    for (const tag of ["es", "es-MX", "es-AR", "es-419", "es-US", "es-CO", "es-CL"]) {
      stub({ navigatorLanguages: [tag, "en-US"] });
      expect(detectLocale(), tag).toBe("es");
    }
    stub({ search: "?lang=es", servedLocale: "pt-BR" });
    expect(detectLocale()).toBe("es");
    stub({ stored: "es", navigatorLanguages: ["pt-BR"] });
    expect(detectLocale()).toBe("es");
    stub({ servedLocale: "es", navigatorLanguages: ["en-US"] });
    expect(detectLocale()).toBe("es");
  });

  it("ignores a stamp it cannot parse rather than failing to boot", () => {
    stub({ servedLocale: "klingon", navigatorLanguages: ["pt-BR"] });
    expect(detectLocale()).toBe("pt-BR");
  });

  /**
   * The behaviour the public-page language picker relies on:
   * `setLocalePreference` writes `localStorage`, and `detectLocale` already
   * reads a saved choice ahead of every browser signal (`?lang=` aside) —
   * see the resolution order in `detectLocale`'s own doc comment. A visitor
   * who picks Portuguese from the header keeps getting it on the next visit
   * even though their OS and browser stay in English.
   */
  it("lets a saved choice from the picker outrank the browser on a later visit", () => {
    stub({ stored: "pt-BR", navigatorLanguages: ["en-US", "en"] });
    expect(detectLocale()).toBe("pt-BR");

    stub({ stored: "es", navigatorLanguages: ["pt-BR"] });
    expect(detectLocale()).toBe("es");
  });

  it("ignores a stored value that is not one of the three locales", () => {
    // A corrupted or hand-edited localStorage entry must not wedge the app in
    // a locale that does not exist — it falls through exactly like an absent
    // preference would.
    stub({ stored: "fr-FR", navigatorLanguages: ["es-MX"] });
    expect(detectLocale()).toBe("es");

    stub({ stored: "", navigatorLanguages: ["pt-BR"] });
    expect(detectLocale()).toBe("pt-BR");
  });
});

describe("setLocalePreference", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes the choice localStorage will later be read back from", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    });

    setLocalePreference("es");
    expect(store.get("pqp:locale")).toBe("es");

    setLocalePreference(null);
    expect(store.has("pqp:locale")).toBe(false);
  });

  it("does not throw when storage is blocked (private mode, embedded webview)", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {
          throw new Error("blocked");
        },
      },
    });

    expect(() => setLocalePreference("en")).not.toThrow();
  });
});
