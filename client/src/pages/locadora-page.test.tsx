// @vitest-environment jsdom
import type { PublicAppsConfig } from "@pqp/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../locales/en/translation.json";
import es from "../locales/es/translation.json";
import ptBR from "../locales/pt-BR/translation.json";
import { hasCartridge, takeCartridge } from "@/lib/locadora-guest";
import { LocadoraPageBody } from "./locadora-page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const ACCEPT = [".nes", ".gb", ".gbc", ".gba", ".sfc", ".smc", ".locadora"];

const LOCADORA = {
  origin: "https://apps.example",
  app: {
    id: "pqp-locadora",
    version: "1.0.4",
    entry: { url: "https://apps.example/pqp-locadora/1.0.4/index.html" },
    capabilities: {
      identity: "display",
      share: "pane",
      localFiles: { allowed: true, accept: ACCEPT, maxBytes: 1024 },
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
  takeCartridge();
});

describe("/apps/locadora is the player's door", () => {
  it("the first screen is the headline, the console and one huge Botar a fita, with the legal line under it", () => {
    const html = render();
    expect((html.match(/<h1/g) ?? []).length).toBe(1);
    expect(html).toContain(escape(en["locadoraPage.hero.title"]));
    expect(html).toContain('data-locadora-door=""');
    expect(html).toContain(en["locadoraPage.door.cta"]);
    expect(html).toContain(escape(en["locadoraPage.door.hint"]));
    expect(html).toContain(escape(en["locadoraPage.legal"]));
    // the picker is the page's own, with Locadora's accept list
    expect(html).toContain(`accept="${ACCEPT.join(",")}"`);
  });

  it("everything else is footer weight: the five consoles as names, one account line, the questions folded away", () => {
    const html = render();
    expect((html.match(/data-locadora-console=/g) ?? []).length).toBe(5);
    expect(html).toContain(en["locadoraPage.account.link"]);
    expect(html).toMatch(/<details[^>]*data-locadora-faq=""/);
    expect(html).not.toMatch(/<details[^>]*open/);
    // the long sections are gone
    for (const gone of ["data-locadora-step", "data-locadora-claims", "locadora-final-title"]) expect(html).not.toContain(gone);
  });

  it("the account line says only what is live: chat and call, cloud saves once announced, never watching", () => {
    const off = render();
    expect(off).toContain(en["locadoraPage.account.adds.call"]);
    expect(off).not.toContain(en["locadoraPage.account.adds.saves"]);
    expect(off).not.toContain(en["locadoraPage.account.adds.watch"]);
    const on = render({ ...GUEST, cloudSaves: true });
    expect(on).toContain(en["locadoraPage.account.adds.saves"]);
    expect(on).toContain(escape(en["locadoraPage.faq.account.aSaves"]));
  });

  it("with guest play off the same big button is the sign-up and nothing says there is no sign-up", () => {
    const html = render(MEMBER);
    expect(html).not.toContain('data-locadora-door=""');
    expect(html).toContain('data-apps-cta="locadora-landing"');
    expect(html).toContain(en["locadoraPage.door.cta"]);
    expect(html).toContain(escape(en["locadoraPage.door.hintMember"]));
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain('data-locadora-faq-item="account"');
  });

  it("is fast: three sprites, all sized, the console first, and nothing below the fold loads an image", () => {
    const html = render();
    const images = html.match(/<img[^>]*>/g) ?? [];
    expect(images).toHaveLength(3);
    for (const img of images) {
      expect(img, img).toMatch(/width="\d+"/);
      expect(img, img).toMatch(/height="\d+"/);
      expect(img, img).toMatch(/\balt="/);
      expect(img).toMatch(/\/images\/apps\/(neon-sign|cart|console)\.webp/);
    }
    expect(images.filter((img) => img.includes('fetchPriority="high"'))).toHaveLength(1);
    expect(html).toMatch(/role="img" aria-label="[^"]+"[^>]*data-locadora-stage/);
  });
});

describe("choosing a cartridge at the door", () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  function Where() {
    const location = useLocation();
    return <p data-where="">{location.pathname}</p>;
  }

  function mount(config: PublicAppsConfig) {
    state.config = config;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <MemoryRouter initialEntries={["/apps/locadora"]}>
          <Routes>
            <Route path="/apps/locadora" element={<LocadoraPageBody />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
  }

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.useRealTimers();
  });

  async function choose(file: File) {
    const input = host!.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("a good file goes into the console and the player opens with it held in memory", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    mount(GUEST);
    await choose(new File([new Uint8Array([1, 2, 3])], "whatever-name.sfc"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(host!.querySelector("[data-where]")?.textContent).toBe("/locadora/jogar");
    expect(hasCartridge()).toBe(true);
    const held = takeCartridge()!;
    expect(held.ext).toBe(".sfc");
    expect(held.bytes.byteLength).toBe(3);
    // the name went nowhere: it is not in what is held
    expect(JSON.stringify(held)).not.toContain("whatever-name");
    vi.unstubAllGlobals();
  });

  it("a file that does not fit says so and stays on the page", async () => {
    mount(GUEST);
    await choose(new File([new Uint8Array([1])], "notes.txt"));
    expect(host!.textContent).toContain(en["locadoraPage.door.wrongType"]);
    await choose(new File([new Uint8Array(2048)], "big.gba"));
    expect(host!.textContent).toContain(en["locadoraPage.door.tooLarge"]);
    expect(host!.querySelector("[data-where]")).toBeNull();
    expect(hasCartridge()).toBe(false);
  });
});

describe("the copy", () => {
  it("states the approved legal line and headline in every language", () => {
    expect(ptBR["locadoraPage.legal"]).toBe("A gente não aluga nem fornece jogo nenhum. Tu abre o teu.");
    expect(en["locadoraPage.legal"]).toBe("We don't rent or provide any game. You open your own.");
    expect(es["locadoraPage.legal"]).toBe("No alquilamos ni damos ningún juego. Abres el tuyo.");
    expect(ptBR["locadoraPage.hero.title"]).toBe("Teus jogos antigos, de volta.");
    expect(ptBR["locadoraPage.door.cta"]).toBe("Botar a fita");
  });

  it("promises no free game, no co-op and no title anywhere", () => {
    for (const catalogue of Object.values(catalogues)) {
      const all = Object.entries(catalogue)
        .filter(([key]) => key.startsWith("locadoraPage.") || key.startsWith("locadoraGuest."))
        .map(([, value]) => value.toLowerCase())
        .join(" ");
      for (const word of ["free game", "jogos grátis", "jogo grátis", "juegos gratis", "classics", "clássicos", "co-op", "multiplayer", "multijogador", "multijugador", "online play"]) {
        expect(all, word).not.toContain(word);
      }
    }
  });

  it("asks nobody's age: no age copy is left for the guest player", () => {
    for (const catalogue of Object.values(catalogues)) {
      expect(Object.keys(catalogue).filter((key) => key.startsWith("locadoraGuest.age") || key.startsWith("locadoraGuest.declined"))).toEqual([]);
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
