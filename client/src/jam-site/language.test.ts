// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadJamLocale } from "@/lib/i18n/jam-site";
import { detectLocale } from "@/lib/locale";
import {
  JAM_LANGUAGES,
  languageParam,
  languageSwitchHref,
  rememberLanguageArrival,
  withLanguage,
} from "./language";

/**
 * The site's language switch and what it hands the app. Which language shows is
 * `lib/locale.ts`'s (its own tests); here: the reload address a choice makes,
 * and that only a language the visitor ASKED for rides into the app.
 */

function at(url: string) {
  window.history.replaceState(null, "", url);
}

beforeEach(async () => {
  window.localStorage.clear();
  document.head.innerHTML = "";
  at("/jam");
  await loadJamLocale("en");
  rememberLanguageArrival();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the three choices", () => {
  it("are Portuguese, English and Spanish, each named in its own language", () => {
    expect(JAM_LANGUAGES.map((l) => l.locale)).toEqual(["pt-BR", "en", "es"]);
    expect(JAM_LANGUAGES.map((l) => l.label)).toEqual(["Português", "English", "Español"]);
  });
});

describe("the address a choice reloads to", () => {
  it("keeps the path, the campaign parameters and the hash, and drops ?lang= once the choice is stored", () => {
    expect(languageSwitchHref("https://pqp.gg/jam/m/abc?lang=en&ref=clip-ana&utm_source=x#top", "es", true)).toBe(
      "https://pqp.gg/jam/m/abc?ref=clip-ana&utm_source=x#top",
    );
    expect(languageSwitchHref("https://jam.pqp.gg/", "pt-BR", true)).toBe("https://jam.pqp.gg/");
  });

  it("sets ?lang= instead when storage is blocked, so this load still honours the click", () => {
    expect(languageSwitchHref("https://jam.pqp.gg/m/abc?ref=x", "es", false)).toBe("https://jam.pqp.gg/m/abc?ref=x&lang=es");
    expect(languageSwitchHref("https://jam.pqp.gg/?lang=en", "pt-BR", false)).toBe("https://jam.pqp.gg/?lang=pt-BR");
  });

  it("makes the next load speak the choice: a stored pick outranks the browser and the served document", () => {
    document.head.innerHTML = '<meta name="pqp:locale" content="en" />';
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US"]);
    expect(detectLocale()).toBe("en");
    window.localStorage.setItem("pqp:locale", "es");
    expect(detectLocale()).toBe("es");
    // ...and an address that says ?lang= outranks the stored pick, which is why the switch drops it.
    at("/jam?lang=pt-BR");
    expect(detectLocale()).toBe("pt-BR");
  });
});

describe("what rides into the app", () => {
  it("is nothing when the browser implied the language: the app infers the same one", async () => {
    await loadJamLocale("es");
    rememberLanguageArrival();
    expect(languageParam()).toBeNull();
    expect(withLanguage("/app?jam=new&ref=jam")).toBe("/app?jam=new&ref=jam");
  });

  it("is the language an address asked for with ?lang=", async () => {
    at("/jam?lang=es");
    await loadJamLocale("es");
    rememberLanguageArrival();
    expect(languageParam()).toBe("es");
    expect(withLanguage("/app?jam=new&ref=jam")).toBe("/app?jam=new&ref=jam&lang=es");
    expect(withLanguage("https://pqp.gg/?ref=jam")).toBe("https://pqp.gg/?ref=jam&lang=es");
  });

  it("is the saved choice, and survives the address losing its query to pushState", async () => {
    window.localStorage.setItem("pqp:locale", "pt-BR");
    await loadJamLocale("pt-BR");
    rememberLanguageArrival();
    at("/jam/m/0b8f2c1e-4d5a-4e6f-8a7b-1c2d3e4f5a6b");
    expect(withLanguage("/app")).toBe("/app?lang=pt-BR");
  });

  it("starts a query when the link has none", async () => {
    at("/jam?lang=en");
    rememberLanguageArrival();
    expect(withLanguage("/app")).toBe("/app?lang=en");
  });
});
