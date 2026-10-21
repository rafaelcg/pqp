// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CART_BRAND, LINE_HEIGHT, MAX_SIZE, MIN_SIZE, TITLE_AREA, TITLE_LINES, cartKind, fitLabel, labelText, textEm, type CartKind } from "./cart-label";
import { createCartridge } from "./ui/game-box";

const KINDS: CartKind[] = ["console", "handheld"];
const TITLES = [
  "Xadrez",
  "Tatu Turbo",
  "Cometa de Plástico e Neon",
  "Fita sem nome 12",
  "A",
  "Supercalifragilisticexpialidocious",
  "Uma fita com um nome muito comprido que não cabe em lugar nenhum mesmo",
  "MMMMMMMMMM WWWWWWWWWW",
  "F1",
  "Super Mario World",
  "Rock n' Roll Racing",
  "The Legend of Zelda: The Minish Cap",
  "ドラゴンクエスト",
];

describe("which cartridge a console gets", () => {
  it("the big one for NES and SNES, the handheld one for the Game Boys", () => {
    expect(cartKind("nes")).toBe("console");
    expect(cartKind("snes")).toBe("console");
    expect(cartKind("gb")).toBe("handheld");
    expect(cartKind("gbc")).toBe("handheld");
    expect(cartKind("gba")).toBe("handheld");
    expect(Object.keys(CART_BRAND).sort()).toEqual(["gb", "gba", "gbc", "nes", "snes"]);
  });
});

describe("the title on the label", () => {
  it("prints the title in upper case, accents kept, spaces collapsed", () => {
    expect(labelText("  cometa  de plástico ")).toBe("COMETA DE PLÁSTICO");
  });

  it("measures an accented letter as its letter", () => {
    expect(textEm("Á")).toBeCloseTo(textEm("A"));
    expect(textEm("Ç")).toBeCloseTo(textEm("C"));
    expect(textEm("MM")).toBeGreaterThan(textEm("II"));
  });

  for (const kind of KINDS) {
    describe(kind, () => {
      for (const title of TITLES) {
        it(`"${title}" stays inside the label`, () => {
          const fit = fitLabel(title, kind);
          const area = TITLE_AREA[kind];
          expect(fit.lines.length).toBeGreaterThanOrEqual(1);
          expect(fit.lines.length).toBeLessThanOrEqual(TITLE_LINES[kind]);
          expect(fit.size).toBeGreaterThanOrEqual(MIN_SIZE[kind] - 1e-6);
          expect(fit.size).toBeLessThanOrEqual(MAX_SIZE[kind] + 1e-6);
          for (const line of fit.lines) expect(textEm(line) * fit.size, line).toBeLessThanOrEqual(area.w + 0.01);
          expect(fit.lines.length * LINE_HEIGHT * fit.size).toBeLessThanOrEqual(area.h + 0.01);
          // nothing is lost unless the title says so with an ellipsis
          if (!fit.cut) expect(fit.lines.join(" ").replace(/-(\s|$)/g, "$1").replace(/\s+/g, "")).toBe(labelText(title).replace(/\s+/g, ""));
          else expect(fit.lines[fit.lines.length - 1]).toMatch(/…$/);
        });
      }
    });
  }

  it("keeps a short title on one line, big", () => {
    const fit = fitLabel("Xadrez", "console");
    expect(fit.lines).toEqual(["XADREZ"]);
    expect(fit.size).toBeGreaterThan(MIN_SIZE.console * 1.5);
  });

  it("wraps between words, never inside one that fits", () => {
    const fit = fitLabel("Cometa de Plástico e Neon", "handheld");
    expect(fit.cut).toBe(false);
    for (const line of fit.lines) for (const word of line.split(" ")) expect(["COMETA", "DE", "PLÁSTICO", "E", "NEON"]).toContain(word);
  });

  it("keeps the app's own default names whole on the small label, in every language", () => {
    for (const title of ["Fita sem nome 12", "Untitled cartridge 12", "Cartucho sin nombre 12"]) {
      const fit = fitLabel(title, "handheld");
      expect(fit.cut, title).toBe(false);
      expect(fit.lines.some((l) => l.endsWith("-")), title).toBe(false);
    }
  });

  it("cuts a word too long for any line with a hyphen, never silently", () => {
    const fit = fitLabel("Supercalifragilisticexpialidocious", "handheld");
    expect(fit.lines.length).toBeGreaterThan(1);
    for (const line of fit.lines.slice(0, -1)) expect(line).toMatch(/-$/);
  });

  it("cuts a run of CJK letters into even pieces, with no hyphen", () => {
    for (const kind of KINDS) {
      const fit = fitLabel("ドラゴンクエスト", kind);
      expect(fit.cut, kind).toBe(false);
      for (const line of fit.lines) expect(line, kind).not.toMatch(/-$/);
      expect(fit.lines.join(""), kind).toBe("ドラゴンクエスト");
    }
    expect(fitLabel("ドラゴンクエスト", "handheld").lines).toEqual(["ドラゴン", "クエスト"]);
  });

  it("sets an ordinary name big enough to read on both labels", () => {
    // label units: hundredths of the label's width (84 px on the shelf's console cartridge, 76 on the handheld one)
    expect(fitLabel("Super Mario World", "console").size).toBeGreaterThanOrEqual(10);
    expect(fitLabel("Tetris", "handheld").size).toBeGreaterThanOrEqual(15);
    expect(fitLabel("Pokémon Crystal", "handheld").size).toBeGreaterThanOrEqual(12);
  });

  it("measures the title area on the label's own window, the same margin on each side", () => {
    expect(TITLE_AREA.console.w).toBeLessThan(100);
    expect(TITLE_AREA.console.h).toBeLessThan((117 / 291) * 100);
    expect(TITLE_AREA.handheld.h).toBeLessThan((251 / 293) * 100);
  });

  it("is the same every time", () => {
    for (const title of TITLES) expect(fitLabel(title, "handheld")).toEqual(fitLabel(title, "handheld"));
  });
});

describe("the cartridge's markup", () => {
  it("is hidden from assistive tech, carries its console, and sets the title as text, line by line", () => {
    const cart = createCartridge({ platform: "gba", userTitle: "<b>Pomba</b> Rally", headerTitle: "" });
    expect(cart.getAttribute("aria-hidden")).toBe("true");
    expect(cart.dataset.platform).toBe("gba");
    expect(cart.dataset.kind).toBe("handheld");
    expect(cart.querySelector("b")).toBeNull();
    expect(cart.querySelector(".loc-cart-brand")!.textContent).toBe("GB ADVANCE");
    expect(cart.querySelector(".loc-cart-ribbon")).toBeNull();
    const lines = [...cart.querySelectorAll(".loc-cart-line")].map((l) => l.textContent);
    // the title is text: a "<b>" in it is two characters on the label, never an element
    expect(lines.map((l) => l!.replace(/-$/, "")).join("").replace(/\s+/g, "")).toBe("<B>POMBA</B>RALLY");
    const title = cart.querySelector<HTMLElement>(".loc-cart-title")!;
    expect(Number(title.style.getPropertyValue("--fs"))).toBe(fitLabel("<b>Pomba</b> Rally", "handheld").size);
  });

  it("puts the console's name on a ribbon on the NES and SNES label", () => {
    const cart = createCartridge({ platform: "snes", userTitle: "", headerTitle: "Mundo" });
    expect(cart.dataset.kind).toBe("console");
    expect(cart.querySelector(".loc-cart-ribbon")!.textContent).toBe("SNES");
    expect(cart.querySelector(".loc-cart-brand")).toBeNull();
  });

  it("draws the cartridge from the art files, never as shapes of CSS", () => {
    const local = "src/styles/shelf.css";
    const sheet = readFileSync(existsSync(local) ? local : `apps/locadora/${local}`, "utf8");
    expect(sheet).toMatch(/\.loc-cart-body\s*\{[^}]*url\("\.\.\/art\/cart-blank\.webp"\)/);
    expect(sheet).toMatch(/\.loc-cart\[data-kind="handheld"\] \.loc-cart-body\s*\{[^}]*url\("\.\.\/art\/cart-gb\.webp"\)/);
    expect(sheet).toMatch(/url\("\.\.\/art\/shop-interior\.webp"\)/);
    expect(sheet).toMatch(/url\("\.\.\/art\/tv-crt\.webp"\)/);
    // reduced motion stops the room's lights with a selector as specific as the one that starts them
    const reduced = sheet.slice(sheet.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.loc-glow\[data-glow\][^{]*\{[^}]*animation: none/);
    expect(sheet).toMatch(/:root\[data-reduced-motion="true"\] \.loc-glow/);
    // every platform has its tint
    for (const platform of ["nes", "snes", "gb", "gbc", "gba"]) expect(sheet).toContain(`.loc-cart[data-platform="${platform}"]`);
  });
});
