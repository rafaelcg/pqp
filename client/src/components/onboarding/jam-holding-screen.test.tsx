// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { i18n, loadLocale, setActiveCatalogue } from "@/lib/i18n/instance";
import { resetJamHandoverForTests, type JamHandover } from "@/lib/jam-handover";
import { JamHoldingScreen } from "./jam-holding-screen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  resetJamHandoverForTests();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  window.localStorage.removeItem("pqp:locale");
  setActiveCatalogue(undefined);
});

const SONG: JamHandover = {
  target: "11111111-1111-4111-8111-111111111111",
  record: true,
  instrument: "bass",
  title: "Café com leite",
  at: Date.now(),
};

async function render(node: React.ReactNode, locale: "en" | "pt-BR" | "es" = "pt-BR") {
  window.localStorage.setItem("pqp:locale", locale);
  await loadLocale(locale);
  await i18n.changeLanguage(locale);
  await act(async () => {
    root!.render(<I18nProvider>{node}</I18nProvider>);
  });
}

describe("the jam holding screen", () => {
  it("says the song and that it is opening, in Jam's own words, and nothing about chat", async () => {
    await render(<JamHoldingScreen handover={SONG} />);
    const screen = host!.querySelector("[data-jam-holding]")!;
    expect(screen.getAttribute("role")).toBe("status");
    expect(screen.textContent).toContain("pqp jam");
    expect(screen.textContent).toContain("Café com leite");
    expect(screen.textContent).toContain("Abrindo a jam…");
    expect(screen.textContent).not.toMatch(/comunidades/i);
  });

  it("has a line for a visitor who came to start a song, and no title", async () => {
    await render(<JamHoldingScreen handover={{ ...SONG, target: "new", title: null, record: false }} />);
    expect(host!.textContent).toContain("Preparando o estúdio…");
    expect(host!.querySelector("[data-jam-holding-title]")).toBeNull();
  });

  it("behind a sheet draws the brand only, hidden from assistive tech, so words are not read twice", async () => {
    await render(<JamHoldingScreen handover={SONG} behindSheet />);
    const screen = host!.querySelector("[data-jam-holding]")!;
    expect(screen.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getAttribute("role")).toBeNull();
    expect(screen.textContent).toContain("pqp jam");
    expect(screen.textContent).not.toContain("Café com leite");
    expect(screen.textContent).not.toContain("Abrindo");
  });

  it("speaks English and Spanish", async () => {
    await render(<JamHoldingScreen handover={SONG} />, "en");
    expect(host!.textContent).toContain("Opening the jam…");
    await render(<JamHoldingScreen handover={SONG} />, "es");
    expect(host!.textContent).toContain("Abriendo la jam…");
  });
});
