import INDEX_HTML from "../../index.html?raw";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { loadLocale } from "@/lib/i18n";
import { edgeConfigFrom } from "./edge-config";
import { injectMarketingHead, type MarketingPage } from "./marketing-meta";
import {
  injectMarketingBody,
  PRERENDERED_MARKETING_PAGES,
  type MarketingChrome,
} from "./marketing-prerender";

/**
 * The static nav and footer against the REAL `MarketingNav` and
 * `MarketingFooter`, in every language and every combination of the three
 * switches they decide at run time. A link added to, removed from or renamed
 * in the live chrome without its static twin fails here.
 */

const flags = vi.hoisted(() => ({
  communities: false,
  support: false,
  play: false,
  locale: "en" as "en" | "pt-BR" | "es",
}));

// No provider here, so `useTranslation()` would report "en" while `t()`
// speaks the loaded catalogue. Report the loaded one, as the provider does.
vi.mock("@/lib/i18n", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...original,
    useTranslation: () => ({ ...original.useTranslation(), locale: flags.locale }),
  };
});

vi.mock("@/hooks/use-communities-enabled", () => ({
  useCommunitiesEnabled: () => flags.communities,
}));
vi.mock("@/lib/support-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/support-links")>()),
  isSupportPageEnabled: () => flags.support,
}));
vi.mock("@/lib/play-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/play-store")>()),
  playStoreUrl: () => (flags.play ? "https://play.google.com/store/apps/details?id=gg.pqp.app" : null),
}));
// Not links: the language picker is a menu button, the CTAs open Clerk's
// modals, and the beta tag is a badge inside the logo link.
vi.mock("@/components/marketing/language-picker", () => ({ LanguagePicker: () => null }));
vi.mock("@/components/marketing/marketing-auth-ctas", () => ({ MarketingAuthCtas: () => null }));
vi.mock("@/components/ui/beta-tag", () => ({ BetaTag: () => null }));

const LOCALES = ["pt-BR", "en", "es"] as const;
const COMBOS: MarketingChrome[] = [false, true].flatMap((communities) =>
  [false, true].flatMap((supportPage) =>
    [false, true].map((playStore) => ({ communities, supportPage, playStore })),
  ),
);

interface Anchor {
  href: string;
  text: string;
  lang: string | null;
}

function anchors(html: string): Anchor[] {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: decode(/\bhref="([^"]*)"/.exec(m[1]!)?.[1] ?? ""),
    text: textOf(m[2]!),
    lang: /\blang="([^"]*)"/.exec(m[1]!)?.[1] ?? null,
  }));
}

function textOf(html: string): string {
  return decode(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decode(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function slice(html: string, open: string, close: string): string {
  const start = html.indexOf(open);
  expect(start, `${open} in ${html.slice(0, 200)}`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf(close, start) + close.length);
}

function live(chrome: MarketingChrome) {
  flags.communities = chrome.communities;
  flags.support = chrome.supportPage;
  flags.play = chrome.playStore;
  const nav = renderToStaticMarkup(
    <MemoryRouter>
      <MarketingNav />
    </MemoryRouter>,
  );
  const footer = renderToStaticMarkup(
    <MemoryRouter>
      <MarketingFooter />
    </MemoryRouter>,
  );
  return { nav, footer };
}

function staticChrome(page: MarketingPage, locale: (typeof LOCALES)[number], chrome: MarketingChrome) {
  const html = injectMarketingBody(
    injectMarketingHead(INDEX_HTML, page, locale),
    page,
    locale,
    chrome,
  );
  return {
    nav: slice(html, "<header", "</header>"),
    footer: slice(html, "<footer", "</footer>"),
  };
}

describe("the static nav and footer", () => {
  afterAll(async () => {
    await loadLocale("en");
  });

  it("match the live nav and footer, link for link, in every language and state", async () => {
    for (const locale of LOCALES) {
      await loadLocale(locale);
      flags.locale = locale;
      for (const chrome of COMBOS) {
        const real = live(chrome);
        expect(anchors(real.nav).length).toBeGreaterThanOrEqual(5);
        expect(anchors(real.footer).length).toBeGreaterThanOrEqual(20);
        const label = `${locale} ${JSON.stringify(chrome)}`;
        for (const page of PRERENDERED_MARKETING_PAGES) {
          const ours = staticChrome(page, locale, chrome);
          expect(anchors(ours.nav), `${page} nav ${label}`).toEqual(anchors(real.nav));
          expect(anchors(ours.footer), `${page} footer ${label}`).toEqual(anchors(real.footer));
          expect(textOf(ours.footer), `${page} footer text ${label}`).toBe(textOf(real.footer));
        }
      }
    }
  });

  it("shows each conditional link only when its switch is on", () => {
    const off = staticChrome("/tela", "pt-BR", {
      communities: false,
      supportPage: false,
      playStore: false,
    });
    expect(off.nav + off.footer).not.toContain('href="/#communities"');
    expect(off.footer).not.toContain('href="/apoie"');
    const on = staticChrome("/tela", "pt-BR", { communities: true, supportPage: true, playStore: true });
    expect(on.nav).toContain('href="/#communities"');
    expect(on.footer).toContain('href="/#communities"');
    expect(on.footer).toContain('href="/apoie"');
    expect(staticChrome("/tela", "en", { communities: false, supportPage: true, playStore: false }).footer).toContain(
      'href="/support"',
    );
  });

  it("defaults every switch to off, so a reader the edge cannot ask gets no extra link", () => {
    const html = injectMarketingBody(INDEX_HTML, "/tela", "pt-BR");
    expect(html).not.toContain('href="/#communities"');
    expect(html).not.toContain('href="/apoie"');
  });

  it("puts the page body between the nav and the footer", () => {
    for (const page of PRERENDERED_MARKETING_PAGES) {
      const html = injectMarketingBody(INDEX_HTML, page, "pt-BR");
      const header = html.indexOf("</header>");
      const main = html.indexOf("<main");
      const footer = html.indexOf("<footer");
      expect(header, page).toBeGreaterThan(-1);
      expect(main, page).toBeGreaterThan(header);
      expect(footer, page).toBeGreaterThan(main);
    }
  });
});

describe("edgeConfigFrom", () => {
  it("records the two footer switches the way the bundle decides them", () => {
    expect(edgeConfigFrom({})).toEqual({ apiUrl: "", supportPage: false, playStore: true });
    expect(
      edgeConfigFrom({
        VITE_API_URL: "https://api.pqp.gg",
        VITE_SPONSOR_URL: "https://github.com/sponsors/rafaelcg",
        VITE_PLAY_STORE_URL: "",
      }),
    ).toEqual({ apiUrl: "https://api.pqp.gg", supportPage: true, playStore: true });
    // A single space hides the Play badge (`play-store.ts`).
    expect(edgeConfigFrom({ VITE_PIX_KEY: "key", VITE_PLAY_STORE_URL: " " })).toEqual({
      apiUrl: "",
      supportPage: true,
      playStore: false,
    });
  });
});
