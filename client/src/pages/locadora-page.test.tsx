import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import en from "../locales/en/translation.json";
import es from "../locales/es/translation.json";
import ptBR from "../locales/pt-BR/translation.json";
import { LocadoraPageBody } from "./locadora-page";

vi.mock("@/components/marketing/marketing-auth-ctas", () => ({
  MarketingAuthCtas: () => null,
}));
vi.mock("@clerk/clerk-react", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: false }),
  useClerk: () => ({ openSignUp: () => undefined }),
}));

function render(): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/apps/locadora"]}>
      <LocadoraPageBody />
    </MemoryRouter>,
  );
}

const catalogues = { en, "pt-BR": ptBR, es } as Record<string, Record<string, string>>;

describe("/apps/locadora", () => {
  it("says what it is: hero, shelf, what it runs, playing on the call, the tools, privacy and the legal line", () => {
    const html = render();
    expect(html).toContain("<h1");
    expect(html).toContain(en["locadoraPage.hero.title"]);
    expect(html).toContain(en["locadoraPage.hero.tagline"]);
    expect(html).toContain(en["locadoraPage.shelf.title"]);
    expect(html).toContain(en["locadoraPage.call.title"]);
    expect(html).toContain(en["locadoraPage.privacy.body"]);
    expect(html).toContain(en["locadoraPage.privacy.rights"]);
    expect(html).toContain(en["locadoraPage.legal"]);
    expect(html).toContain(en["locadoraPage.credit"]);
    for (const id of ["saves", "turbo", "full", "pad"]) {
      expect(html).toContain(`data-locadora-tool="${id}"`);
    }
  });

  it("names the five consoles, Game Boy and Game Boy Color sharing one card", () => {
    const html = render();
    expect((html.match(/data-locadora-console=/g) ?? []).length).toBe(4);
    for (const name of ["NES", "SNES", "Game Boy / Game Boy Color", "Game Boy Advance"]) {
      expect(html).toContain(name);
    }
  });

  it("keeps the privacy truth exactly, in every language", () => {
    expect(en["locadoraPage.privacy.body"]).toBe(
      "The game file never leaves your device. Not to pqp, not anywhere else.",
    );
    expect(ptBR["locadoraPage.privacy.body"]).toBe(
      "O arquivo do jogo nunca sai do teu aparelho. Nem pro pqp, nem pra lugar nenhum.",
    );
    expect(es["locadoraPage.privacy.body"]).toContain("nunca sale de tu dispositivo");
  });

  it("states the legal line in every language, on this page and on the hub", () => {
    expect(ptBR["locadoraPage.legal"]).toBe("A gente não aluga nem fornece jogo nenhum.");
    expect(ptBR["appsLanding.legal"]).toBe("A gente não aluga nem fornece jogo nenhum.");
    expect(en["locadoraPage.legal"]).toBe("We do not rent or provide any game.");
    expect(en["appsLanding.legal"]).toBe("We do not rent or provide any game.");
  });

  it("promises nothing that is not live: cloud saves and guest play appear only as one muted 'later' line, free games not at all", () => {
    const html = render();
    expect((html.match(/data-locadora-soon=/g) ?? []).length).toBe(1);
    for (const catalogue of Object.values(catalogues)) {
      const outsideSoon = Object.entries(catalogue)
        .filter(([key]) => key.startsWith("locadoraPage.") && key !== "locadoraPage.soon")
        .map(([, value]) => value)
        .join(" ")
        .toLowerCase();
      for (const word of ["free", "grátis", "gratuito", "gratis", "guest", "convidado", "cloud", "na conta", "in your account"]) {
        expect(outsideSoon, word).not.toContain(word);
      }
    }
    // And no promise of shared controls: each person plays their own game.
    for (const catalogue of Object.values(catalogues)) {
      const all = Object.entries(catalogue)
        .filter(([key]) => key.startsWith("locadoraPage."))
        .map(([, value]) => value.toLowerCase())
        .join(" ");
      for (const word of ["co-op", "multiplayer", "multijogador", "multijugador", "online play"]) {
        expect(all, word).not.toContain(word);
      }
    }
  });

  it("has landmarks, one h1, a way back to the hub, and every image sized with an alt", () => {
    const html = render();
    expect(html).toContain("<header");
    expect(html).toContain('<main id="main"');
    expect(html).toContain("<footer");
    expect((html.match(/<h1/g) ?? []).length).toBe(1);
    expect(html).toContain('data-apps-crumb=""');
    expect(html).toContain('href="/apps"');
    for (const img of html.match(/<img[^>]*>/g) ?? []) {
      expect(img, img).toMatch(/width="\d+"/);
      expect(img, img).toMatch(/height="\d+"/);
      expect(img, img).toMatch(/\balt="/);
    }
  });

  it("loads only the hero picture eagerly; everything below it is lazy", () => {
    const html = render();
    const images = html.match(/<img[^>]*>/g) ?? [];
    const eager = images.filter((img) => !img.includes('loading="lazy"'));
    expect(eager).toHaveLength(1);
    expect(eager[0]).toContain("street-dusk");
    expect(eager[0]).toContain("fetchPriority=\"high\"");
  });

  it("carries no dash punctuation in any language", () => {
    for (const catalogue of Object.values(catalogues)) {
      for (const [key, value] of Object.entries(catalogue)) {
        if (!key.startsWith("locadoraPage.")) continue;
        for (const banned of ["—", "–", "―"]) {
          expect(value, key).not.toContain(banned);
        }
      }
    }
  });
});
