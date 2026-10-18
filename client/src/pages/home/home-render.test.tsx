import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createIntentHref } from "@/lib/handle-intent";
import { en as enCatalogue, loadLocale } from "@/lib/i18n";
import type { Locale } from "@/lib/locale";
import en from "@/locales/en/translation.json";
import es from "@/locales/es/translation.json";
import ptBR from "@/locales/pt-BR/translation.json";
import Home from "./index";
import { CREATE_INTENT, IMPORT_INTENT } from "./shared/auth-buttons";

/*
 * The whole home page, rendered to a string in each language, with the real
 * translations (an echoing `t` would hide a raw key, a leftover `{slot}` or a
 * dash). Server rendering runs no effects, so this reads what the page says
 * and links before any script touches it: the copy, the ids that old links
 * land on, the CTAs and the hosted-only gates.
 *
 * Every "absent" assertion has a "present" twin. A mock that silently failed
 * to apply would make an absence test pass by testing nothing, so each gate is
 * also driven the other way.
 *
 * Everything is checked against the claim, not the sentence: copy is edited
 * under this test.
 */

const state = vi.hoisted(() => ({
  locale: "en" as "en" | "pt-BR" | "es",
  communities: false,
  support: true,
  play: "https://play.google.com/store/apps/details?id=gg.pqp.app" as string | null,
  signedIn: false,
}));

// The real `t`, bound to the locale under test. Without a provider,
// `useTranslation()` answers English whatever the catalogue says.
vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    useTranslation: () => ({ locale: state.locale, t: actual.translateMessage }),
  };
});

// Server rendering never runs the probe's effect, so the answer is always
// "no". The page asks the server whether communities are on; say what it says.
vi.mock("@/hooks/use-communities-enabled", () => ({
  useCommunitiesEnabled: () => state.communities,
}));

// `playStoreUrl()` has a code default and is never null on its own.
vi.mock("@/lib/play-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/play-store")>();
  return { ...actual, playStoreUrl: () => state.play };
});

// A build without VITE_SPONSOR_URL or VITE_PIX_KEY has no donation page.
vi.mock("@/lib/support-links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/support-links")>();
  return { ...actual, isSupportPageEnabled: () => state.support };
});

// The bypass makes every CTA a link to its intent (`/app?create=new`), which
// is what can be read from markup. Signed-out buttons open Clerk instead.
vi.mock("@/lib/dev-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dev-auth")>();
  return { ...actual, isDevAuthBypassEnabled: () => true };
});
vi.mock("@/components/marketing/marketing-auth-ctas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/marketing/marketing-auth-ctas")>();
  return {
    ...actual,
    MarketingAuthGate: ({
      children,
    }: {
      children: (auth: { signedIn: boolean; bypass: boolean; join: () => void; signIn: () => void }) => ReactNode;
    }) => <>{children({ signedIn: state.signedIn, bypass: true, join: () => {}, signIn: () => {} })}</>,
  };
});

const LOCALES = ["pt-BR", "en", "es"] as const satisfies readonly Locale[];
const CATALOGUES: Record<Locale, Record<string, string>> = { "pt-BR": ptBR, en, es };

/** The ids a section lives under, and the older ids that links still use. */
const SECTION_IDS = ["noite", "mudanca", "brinquedos", "celular", "arroba", "limites", "codigo", "perguntas", "fim"];
const ALIAS_IDS = {
  features: "brinquedos",
  chat: "brinquedos",
  roles: "brinquedos",
  hosting: "codigo",
  where: "codigo",
  import: "mudanca",
  discord: "mudanca",
  faq: "perguntas",
  voice: "noite",
  screen: "noite",
} as const;

/*
 * The words a watch party's copy must not use (see no-rights-wording.test.ts,
 * which owns this list; one letter of each word is in brackets so a grep of
 * the repository finds copy, not this guard). Keep the two in step.
 */
const BANNED =
  /fi[l]me|ci[n]ema|s[ée]ri[e]s?\b|mo[v]ie|fi[l]m|pel[ií]cula|\bpe[l]is?\b|ne[t]flix|di[s]ney/i;

interface Options {
  locale?: Locale;
  communities?: boolean;
  support?: boolean;
  play?: string | null;
  signedIn?: boolean;
}

async function renderHome({
  locale = "en",
  communities = false,
  support = true,
  play = "https://play.google.com/store/apps/details?id=gg.pqp.app",
  signedIn = false,
}: Options = {}): Promise<string> {
  await loadLocale(locale);
  Object.assign(state, { locale, communities, support, play, signedIn });
  return renderToString(
    <MemoryRouter initialEntries={["/"]}>
      <Home />
    </MemoryRouter>,
  );
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};
const decode = (value: string) =>
  value.replace(/&(?:amp|lt|gt|quot|nbsp|#x27|#39);/g, (entity) => ENTITIES[entity] ?? entity);

/** Text nodes, as a reader gets them: no scripts, no styles, no tags. */
function textOf(html: string): string {
  return decode(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

/** Text with its tags removed and nothing put in their place: a headline reads as one run. */
const plain = (html: string) => decode(html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ")).trim();

/** Where a section's opening tag starts, whatever order its attributes are in. */
function sectionStart(html: string, id: string): number {
  const open = new RegExp(`<section\\b[^>]*\\sid="${id}"`).exec(html);
  if (!open) throw new Error(`no section #${id}`);
  return open.index;
}

/** One section's markup, from its opening tag to its closing one. */
function sectionOf(html: string, id: string): string {
  const open = sectionStart(html, id);
  return html.slice(open, html.indexOf("</section>", open));
}

/** The page without one section: used to leave a section of other people's words out of a scan. */
function withoutSection(html: string, id: string): string {
  const open = sectionStart(html, id);
  return html.slice(0, open) + html.slice(html.indexOf("</section>", open));
}

/** Attribute values a reader or a screen reader gets: alt, aria-label, title, placeholder. */
function accessibleAttributes(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/\s(?:alt|aria-label|title|placeholder)="([^"]*)"/g)) {
    out.push(decode(match[1]!));
  }
  return out;
}

/** Everything a person reads or hears: the text nodes and the accessible attributes. */
const readable = (html: string) => [textOf(html), ...accessibleAttributes(html)].join("\n");

const hrefs = (html: string) => [...html.matchAll(/\shref="([^"]*)"/g)].map((match) => decode(match[1]!));
const ids = (html: string) => [...html.matchAll(/\sid="([^"]*)"/g)].map((match) => match[1]!);

const ENGLISH_KEYS = new Set(Object.keys(enCatalogue));

beforeAll(async () => {
  // Load both catalogues once; each render then switches by `loadLocale`.
  await loadLocale("pt-BR");
  await loadLocale("es");
});

describe("the home page, rendered", () => {
  for (const locale of LOCALES) {
    describe(locale, () => {
      let html = "";
      beforeAll(async () => {
        html = await renderHome({ locale });
      });

      it("renders a page, not an error", () => {
        expect(html.length).toBeGreaterThan(20_000);
        expect(html).toContain("<main");
        expect(html).toContain("<footer");
      });

      it("reads the alt text and labels too, so the scans below see them", () => {
        // Positive control for `readable()`: much of this page's copy lives in
        // alt and aria-label values, and a scan that silently skipped them
        // would pass on any key left raw there.
        const text = readable(html);
        expect(text).toContain(CATALOGUES[locale]["home.hero.alt"]);
        expect(accessibleAttributes(html).length).toBeGreaterThan(20);
      });

      it("has exactly one h1", () => {
        expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
      });

      it("is in the language it was asked for", () => {
        // The h1 is the catalogue's own title with its accent filled in. A
        // catalogue that fell back to English would print the English one in
        // pt-BR and es.
        const titleOf = (catalogue: Record<string, string>) =>
          catalogue["home.hero.title"]!
            .replace("{accent}", catalogue["home.hero.titleAccent"]!)
            .replace(/\s+/g, " ");
        const h1 = plain(/<h1[\s\S]*?<\/h1>/.exec(html)![0]);
        expect(h1).toBe(titleOf(CATALOGUES[locale]));
        if (locale !== "en") expect(h1).not.toBe(titleOf(CATALOGUES.en));
      });

      it("leaves no raw key and no {slot} in anything a reader gets", () => {
        const text = readable(html);
        expect(text).not.toMatch(/\b(?:home|landing)\.[a-z]/);
        expect(text).not.toMatch(/\{[A-Za-z_]\w*\}/);
        const tokens = text.match(/[A-Za-z][\w-]*(?:\.[\w-]+)+/g) ?? [];
        expect(tokens.filter((token) => ENGLISH_KEYS.has(token))).toEqual([]);
      });

      it("has no em or en dash anywhere in the markup", () => {
        // U+2013 and U+2014, built from their code points so this file has none itself.
        expect(html).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
      });

      it("says nothing a watch party may not suggest", () => {
        const hits = readable(html).match(new RegExp(BANNED.source, "gi")) ?? [];
        expect(hits).toEqual([]);
      });

      it("has no id twice, so a hash link has one place to land", () => {
        const seen = ids(html);
        const duplicates = seen.filter((id, i) => seen.indexOf(id) !== i);
        expect([...new Set(duplicates)]).toEqual([]);
      });

      it("has every section, and every older anchor on the section it moved to", () => {
        const present = new Set(ids(html));
        for (const id of ["conteudo", ...SECTION_IDS, ...Object.keys(ALIAS_IDS)]) {
          expect(present.has(id), `#${id}`).toBe(true);
        }
        // An alias belongs to its section: the empty span is the section's
        // first child, so it sits inside that section's markup.
        for (const [alias, section] of Object.entries(ALIAS_IDS)) {
          expect(sectionOf(html, section), `#${alias} inside #${section}`).toContain(`id="${alias}"`);
        }
      });

      it("points the create and import CTAs at their intents", () => {
        const links = hrefs(html);
        expect(createIntentHref(CREATE_INTENT)).toBe("/app?create=new");
        expect(createIntentHref(IMPORT_INTENT)).toBe("/app?import=discord");
        expect(links).toContain("/app?create=new");
        expect(links).toContain("/app?import=discord");
      });

      it("links the section anchors from the header, in page order", () => {
        const header = /<header[\s\S]*?<\/header>/.exec(html)![0];
        const nav = /<nav[\s\S]*?<\/nav>/.exec(header)![0];
        const anchors = hrefs(nav).filter((href) => href.startsWith("#"));
        expect(anchors).toEqual(["#noite", "#mudanca", "#brinquedos", "#codigo", "#perguntas"]);
        const present = new Set(ids(html));
        for (const anchor of anchors) expect(present.has(anchor.slice(1)), anchor).toBe(true);
      });
    });
  }
});

describe("communities", () => {
  for (const locale of LOCALES) {
    it(`${locale}: no #communities and no header link while the server says off`, async () => {
      const html = await renderHome({ locale, communities: false });
      expect(ids(html)).not.toContain("communities");
      expect(hrefs(/<header[\s\S]*?<\/header>/.exec(html)![0])).not.toContain("/#communities");
      // The aliases still land with the block off: the section does not depend on it.
      for (const alias of Object.keys(ALIAS_IDS)) expect(ids(html)).toContain(alias);
    });

    it(`${locale}: #communities and the header link, last in the row, once the server says on`, async () => {
      const html = await renderHome({ locale, communities: true });
      expect(ids(html)).toContain("communities");
      const header = /<header[\s\S]*?<\/header>/.exec(html)![0];
      const nav = /<nav[\s\S]*?<\/nav>/.exec(header)![0];
      const links = hrefs(nav);
      expect(links.at(-1)).toBe("/#communities");
      expect(links.filter((href) => href === "/#communities")).toHaveLength(1);
      // Still one of each id with the block on.
      const seen = ids(html);
      expect(seen.filter((id) => id === "communities")).toHaveLength(1);
      // The block lives in the handle section, which is where the link lands.
      expect(sectionOf(html, "arroba")).toContain('id="communities"');
    });
  }
});

describe("hosted-only gates", () => {
  const SUPPORT_LINK = /^\/(apoie|support)$/;

  for (const locale of LOCALES) {
    describe(locale, () => {
      it("shows the donation page only when this build has one", async () => {
        const on = await renderHome({ locale, support: true });
        const off = await renderHome({ locale, support: false });
        // Positive control: the link exists with the gate open, to /apoie in
        // Portuguese and /support in English and Spanish.
        const expected = locale === "pt-BR" ? "/apoie" : "/support";
        expect(hrefs(on).filter((href) => SUPPORT_LINK.test(href))).toContain(expected);
        expect(hrefs(off).filter((href) => SUPPORT_LINK.test(href))).toEqual([]);
      });

      it("names Google Play only when this build links a listing", async () => {
        // The release notes in #codigo are the blog's own post titles, one of
        // which names Google Play whatever the build says, so they are left
        // out of this scan. Every other word on the page is the page's own.
        const own = (html: string) => readable(withoutSection(html, "codigo"));
        const on = await renderHome({ locale, play: "https://play.google.com/store/apps/details?id=gg.pqp.app" });
        const off = await renderHome({ locale, play: null });
        // Positive control: the default build says Google Play, in the phones
        // section and in the FAQ.
        expect(readable(sectionOf(on, "celular"))).toMatch(/Google Play/);
        expect(readable(sectionOf(on, "perguntas"))).toMatch(/Google Play/);
        expect(own(on)).toMatch(/Google Play/);
        expect(own(off)).not.toMatch(/Google Play/);
        // The APK wording takes its place, so the Android line is not blank.
        expect(readable(sectionOf(off, "celular"))).toMatch(/APK/);
        expect(readable(sectionOf(off, "perguntas"))).toMatch(/APK/);
      });

      it("leaves no word of the donation sentence behind with the page off", async () => {
        const off = await renderHome({ locale, support: false });
        const on = await renderHome({ locale, support: true });
        // The donate sentence and button are the only difference the gate may
        // make to the lede: it has to be shorter, not broken.
        expect(readable(off).length).toBeLessThan(readable(on).length);
        expect(readable(off)).not.toMatch(/\{[A-Za-z_]\w*\}/);
      });
    });
  }
});

describe("signed in", () => {
  it("offers the app instead of sign-in, and /app on the header button", async () => {
    const out = await renderHome({ locale: "en", signedIn: false });
    const signedIn = await renderHome({ locale: "en", signedIn: true });
    const openApp = enCatalogue["nav.openApp"];
    const signIn = enCatalogue["nav.signIn"];
    // Positive control first: signed out, the header offers sign-in and no app.
    expect(readable(out)).toContain(signIn);
    const header = (html: string) => /<header[\s\S]*?<\/header>/.exec(html)![0];
    expect(textOf(header(out))).not.toContain(openApp);
    // Signed in: the header says "open the app" and links /app, with no sign-in.
    expect(textOf(header(signedIn))).toContain(openApp);
    expect(textOf(header(signedIn))).not.toContain(signIn);
    expect(hrefs(header(signedIn))).toContain("/app");
  });
});
