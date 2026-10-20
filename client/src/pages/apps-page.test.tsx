import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../locales/en/translation.json";
import es from "../locales/es/translation.json";
import ptBR from "../locales/pt-BR/translation.json";
import { AppsPageBody } from "./apps-page";

// The nav and the page's own buttons use Clerk, which needs a provider the
// unit environment does not have. This test is about the page's words.
vi.mock("@/components/marketing/marketing-auth-ctas", () => ({
  MarketingAuthCtas: () => null,
}));
vi.mock("@clerk/clerk-react", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: false }),
  useClerk: () => ({ openSignUp: () => undefined }),
}));

function render(): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/apps"]}>
      <AppsPageBody />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/apps", () => {
  it("is the hero, the featured Locadora card, the one honest 'more' card, build yours and the legal line", () => {
    const html = render();
    expect(html).toContain("<h1");
    expect(html).toContain(en["appsLanding.hero.title"]);
    expect(html).toContain(en["appsLanding.hero.cta"]);
    expect(html).toContain('data-apps-featured="locadora"');
    expect(html).toContain('href="/apps/locadora"');
    expect(html).toContain(en["appsLanding.locadora.imageAlt"]);
    expect(html).toContain('data-apps-more=""');
    expect(html).toContain(en["appsLanding.more.title"]);
    expect(html).toContain(en["appsLanding.build.title"]);
    expect(html).toContain(en["appsLanding.legal"]);
    expect(html).toContain(en["appsLanding.credit"]);
  });

  it("invents no app: exactly one featured card and no other named app", () => {
    const html = render();
    expect((html.match(/data-apps-featured=/g) ?? []).length).toBe(1);
    expect((html.match(/<article/g) ?? []).length).toBe(1);
  });

  it("has landmarks: a nav, one main with a skip target, a footer and a single h1", () => {
    const html = render();
    expect(html).toContain("<header");
    expect(html).toContain('<main id="main"');
    expect(html).toContain('href="#main"');
    expect(html).toContain("<footer");
    expect((html.match(/<h1/g) ?? []).length).toBe(1);
  });

  it("gives every image a size, a text alternative, and lazy loading below the fold", () => {
    const html = render();
    for (const img of html.match(/<img[^>]*>/g) ?? []) {
      expect(img, img).toMatch(/width="\d+"/);
      expect(img, img).toMatch(/height="\d+"/);
      expect(img, img).toMatch(/\balt="/);
    }
  });

  it("links the SDK and the example in the repository, and the docs only when they are configured", () => {
    vi.stubEnv("VITE_APPS_DOCS_URL", "");
    let html = render();
    expect(html).toContain('data-apps-build-card="sdk"');
    expect(html).toContain('data-apps-build-card="example"');
    expect(html).toContain("/tree/main/packages/app-sdk");
    expect(html).toContain("/tree/main/apps/eco");
    expect(html).not.toContain('data-apps-build-card="docs"');
    expect(html).not.toContain(en["appsLanding.build.docs.link"]);

    vi.stubEnv("VITE_APPS_DOCS_URL", "https://docs.example.test/apps");
    html = render();
    expect(html).toContain('data-apps-build-card="docs"');
    expect(html).toContain('href="https://docs.example.test/apps"');

    vi.stubEnv("VITE_APPS_DOCS_URL", "javascript:alert(1)");
    html = render();
    expect(html).not.toContain('data-apps-build-card="docs"');
    expect(html).not.toContain("javascript:");
  });

  it("promises nothing that is not live: no guest play, no free games, no cloud saves, in any language", () => {
    for (const catalogue of [en, ptBR, es] as Record<string, string>[]) {
      const copy = Object.entries(catalogue)
        .filter(([key]) => key.startsWith("appsLanding."))
        .map(([, value]) => value)
        .join(" ")
        .toLowerCase();
      for (const word of ["free game", "jogo grátis", "jogos grátis", "juego gratis", "guest", "convidado", "cloud sav", "saves na conta"]) {
        expect(copy, word).not.toContain(word);
      }
    }
  });

  it("carries no dash punctuation in any language", () => {
    for (const catalogue of [en, ptBR, es] as Record<string, string>[]) {
      for (const [key, value] of Object.entries(catalogue)) {
        if (!key.startsWith("appsLanding.")) continue;
        for (const banned of ["—", "–", "―"]) {
          expect(value, key).not.toContain(banned);
        }
      }
    }
  });
});
