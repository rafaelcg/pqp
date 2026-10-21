import type { PublicAppsConfig } from "@pqp/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const state: { config: PublicAppsConfig | null } = { config: null };
vi.mock("@/hooks/use-apps-landing", () => ({
  usePublicAppsConfig: () => ({ config: state.config, failed: false }),
  useAppsLanding: () => "on",
}));

const LOCADORA = {
  origin: "https://apps.example",
  app: {
    id: "pqp-locadora",
    version: "1.0.1",
    entry: { url: "https://apps.example/pqp-locadora/1.0.1/index.html" },
    capabilities: {
      identity: "display",
      share: "pane",
      localFiles: { allowed: true, accept: [".nes"], maxBytes: 1 },
      deviceStore: { allowed: true, maxBytes: 1 },
      peer: "none",
    },
    state: { maxBytes: 0, maxWritesPerSecond: 1, writers: "participants" },
    events: { maxPerSecond: 0, maxBytes: 0 },
    assets: [],
  },
} as unknown as NonNullable<PublicAppsConfig["locadora"]>;

const GUEST: PublicAppsConfig = { enabled: true, guest: true, cloudSaves: false, locadora: LOCADORA };
const MEMBER: PublicAppsConfig = { enabled: true, guest: false, cloudSaves: false, locadora: null };

function render(config: PublicAppsConfig | null = GUEST): string {
  state.config = config;
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/apps/locadora"]}>
      <LocadoraPageBody />
    </MemoryRouter>,
  );
}

const catalogues = { en, "pt-BR": ptBR, es } as Record<string, Record<string, string>>;
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

beforeEach(() => {
  state.config = null;
});

describe("/apps/locadora with guest play on", () => {
  it("leads with the approved headline, Jogar agora to the player, the sign-up beside it and the legal line under both", () => {
    const html = render();
    expect((html.match(/<h1/g) ?? []).length).toBe(1);
    expect(html).toContain(escape(en["locadoraPage.hero.title"]));
    expect(html).toContain(escape(en["locadoraPage.hero.sub"]));
    expect(html).toContain('href="/locadora/jogar"');
    expect(html).toContain(en["locadoraPage.hero.play"]);
    expect(html).toContain(en["locadoraPage.hero.signup"]);
    expect(html).toContain(escape(en["locadoraPage.legal"]));
    expect(html).toContain(en["locadoraPage.credit"]);
  });

  it("walks through the three steps and the five consoles", () => {
    const html = render();
    for (const step of ["1", "2", "3"]) expect(html).toContain(`data-locadora-step="${step}"`);
    expect((html.match(/data-locadora-console=/g) ?? []).length).toBe(5);
    for (const name of ["NES", "SNES", "Game Boy", "Game Boy Color", "Game Boy Advance"]) {
      expect(html).toContain(`>${name}<`);
    }
  });

  it("draws only the claims whose gate is open: cloud saves muted as soon, watching not at all", () => {
    const html = render();
    expect(html).toContain('data-locadora-claim="saves" data-claim-view="soon"');
    expect(html).toContain('data-locadora-claim="call" data-claim-view="shown"');
    expect(html).toContain('data-locadora-claim="chat" data-claim-view="shown"');
    expect(html).not.toContain('data-locadora-claim="watch"');
    expect(html).not.toContain(escape(en["locadoraPage.account.watch.body"]));
    expect(html).toContain(escape(en["locadoraPage.faq.account.a"]));
    expect(html).not.toContain(escape(en["locadoraPage.faq.account.aSaves"]));
  });

  it("says cloud saves plainly once they are announced", () => {
    const html = render({ ...GUEST, cloudSaves: true });
    expect(html).toContain('data-locadora-claim="saves" data-claim-view="shown"');
    expect(html).toContain(escape(en["locadoraPage.faq.account.aSaves"]));
  });

  it("asks nothing of a slow config: the member page until the answer says guest", () => {
    const html = render(null);
    expect(html).not.toContain('href="/locadora/jogar"');
  });
});

describe("/apps/locadora with guest play off", () => {
  it("never says there is no sign-up: no Jogar agora, the member sub, no 'do I need an account' answer", () => {
    const html = render(MEMBER);
    expect(html).not.toContain('href="/locadora/jogar"');
    expect(html).not.toContain(en["locadoraPage.hero.play"]);
    expect(html).not.toContain(escape(en["locadoraPage.hero.sub"]));
    expect(html).toContain(escape(en["locadoraPage.hero.subMember"]));
    expect(html).toContain(en["locadoraPage.hero.cta"]);
    expect(html).not.toContain('data-locadora-faq-item="account"');
  });
});

describe("the page itself", () => {
  it("has landmarks, one h1, a way back to the hub, and every image sized with an alt", () => {
    const html = render();
    expect(html).toContain("<header");
    expect(html).toContain('<main id="main"');
    expect(html).toContain("<footer");
    expect(html).toContain('data-apps-crumb=""');
    expect(html).toContain('href="/apps"');
    for (const img of html.match(/<img[^>]*>/g) ?? []) {
      expect(img, img).toMatch(/width="\d+"/);
      expect(img, img).toMatch(/height="\d+"/);
      expect(img, img).toMatch(/\balt="/);
    }
  });

  it("loads only the hero's four sprites eagerly, the sign first; everything below is lazy", () => {
    const html = render();
    const images = html.match(/<img[^>]*>/g) ?? [];
    const eager = images.filter((img) => !img.includes('loading="lazy"'));
    expect(eager).toHaveLength(4);
    for (const sprite of ["neon-sign", "tv-crt", "cart", "console"]) {
      expect(eager.some((img) => img.includes(sprite)), sprite).toBe(true);
    }
    expect(eager.filter((img) => img.includes('fetchPriority="high"'))).toHaveLength(1);
    // the stage is one picture with a name; its parts are decoration
    expect(html).toMatch(/role="img" aria-label="[^"]+"[^>]*data-locadora-stage/);
  });

  it("uses no game's picture: the TV shows the CSS colour bars, and no screenshot is loaded", () => {
    const html = render();
    expect(html).toContain("loc-screen");
    for (const img of html.match(/<img[^>]*src="([^"]+)"/g) ?? []) {
      expect(img).toMatch(/\/images\/apps\/(neon-sign|tv-crt|cart|console|pad-[a-z]+|rack)\.webp/);
    }
  });
});

describe("the copy", () => {
  it("states the approved legal line in every language", () => {
    expect(ptBR["locadoraPage.legal"]).toBe("A gente não aluga nem fornece jogo nenhum. Tu abre o teu.");
    expect(en["locadoraPage.legal"]).toBe("We don't rent or provide any game. You open your own.");
    expect(es["locadoraPage.legal"]).toBe("No alquilamos ni damos ningún juego. Abres el tuyo.");
  });

  it("keeps the approved headline in every language", () => {
    expect(ptBR["locadoraPage.hero.title"]).toBe("Teus jogos antigos, de volta.");
    expect(en["locadoraPage.hero.title"]).toBe("Your old games, back.");
    expect(es["locadoraPage.hero.title"]).toBe("Tus juegos de siempre, de vuelta.");
  });

  it("promises no free game, no co-op and no title anywhere", () => {
    for (const catalogue of Object.values(catalogues)) {
      const all = Object.entries(catalogue)
        .filter(([key]) => key.startsWith("locadoraPage.") || key.startsWith("locadoraGuest."))
        .map(([, value]) => value.toLowerCase())
        .join(" ");
      for (const word of [
        "free game",
        "jogos grátis",
        "jogo grátis",
        "juegos gratis",
        "classics",
        "clássicos",
        "co-op",
        "multiplayer",
        "multijogador",
        "multijugador",
        "online play",
      ]) {
        expect(all, word).not.toContain(word);
      }
    }
  });

  it("carries no dash punctuation and no você", () => {
    for (const catalogue of Object.values(catalogues)) {
      for (const [key, value] of Object.entries(catalogue)) {
        if (!key.startsWith("locadoraPage.") && !key.startsWith("locadoraGuest.")) continue;
        for (const banned of ["—", "–", "―"]) expect(value, key).not.toContain(banned);
      }
    }
    for (const [key, value] of Object.entries(ptBR)) {
      if (!key.startsWith("locadoraPage.") && !key.startsWith("locadoraGuest.")) continue;
      expect(value.toLowerCase(), key).not.toMatch(/\bvoc[eê]\b/);
    }
  });
});
