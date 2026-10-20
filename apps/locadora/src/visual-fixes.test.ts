// @vitest-environment jsdom
/**
 * The visual fixes of the second QA pass that a browser is not needed to pin: copy in every language, number
 * formats, the empty meter, the walkthrough's replay button, the controller map's list for phones, the Continuar
 * card's size container and the screen being laid out in whole device pixels.
 */
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agoLine, formatAgo, isJustNow, JUST_NOW_MS, type LibraryItem } from "./library";
import { STRINGS, type Strings } from "./i18n";
import { defaultKeymaps } from "./keymap";
import { mountOnboarding } from "./onboarding";
import { createStage, fitStage, formatFactor } from "./stage";
import { createContinueCard } from "./ui/continue-card";
import { createControllerMap } from "./ui/controller-map";
import { createTopBar, isEmptyUsage } from "./ui/top-bar";

const t = STRINGS["pt-BR"];
/** jsdom gives `import.meta.url` an http scheme, so the path comes from the working directory (the package's, or the repo root's). */
const css = (name: string) => {
  const local = `src/styles/${name}`;
  return readFileSync(existsSync(local) ? local : `apps/locadora/${local}`, "utf8");
};

describe("the Spanish copy", () => {
  /** Words that are the same in Spanish and English, or are names. */
  const SAME = new Set([
    "title", "frameTitle", "hud.turbo", "hud.turboPill", "start.btn", "controlStart", "controlSelect", "hud.slot",
  ]);

  it("has every key, and no value is the English text left in place", () => {
    const keys = Object.keys(STRINGS.en) as Array<keyof Strings>;
    expect(Object.keys(STRINGS.es).sort()).toEqual([...keys].sort());
    const untranslated = keys.filter((key) => STRINGS.es[key] === STRINGS.en[key] && !SAME.has(key) && /[a-z]{3}/i.test(STRINGS.en[key]));
    expect(untranslated).toEqual([]);
  });

  it("keeps the slots of its English template", () => {
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(STRINGS.en) as Array<keyof Strings>) {
      expect(slots(STRINGS.es[key]), key).toEqual(slots(STRINGS.en[key]));
    }
  });

  it("uses no em dash and none of the words the copy never says", () => {
    for (const locale of Object.values(STRINGS)) {
      for (const value of Object.values(locale)) {
        expect(value).not.toContain("—");
        expect(value).not.toMatch(/\b(rom|roms|download|baixar|free)\b/i);
      }
    }
  });
});

describe("the copy about seeing the welcome again is true", () => {
  it("names the button that exists, in every language", () => {
    for (const locale of Object.values(STRINGS)) {
      expect(locale["onb.once"]).toContain(locale["onb.replay"]);
      expect(locale["onb.once"]).not.toMatch(/ajuda|help|ayuda/i);
    }
  });

  function mountMap(extra: Record<string, unknown>) {
    document.body.innerHTML = '<section id="root"></section>';
    const root = document.getElementById("root")!;
    return { root, onboarding: mountOnboarding({ root, t, steps: [3], onPick: () => {}, onDone: () => {}, gamepad: { start() {}, stop() {} } as never, ...extra }) };
  }

  it("draws 'Ver a recepção de novo' in Controles, and walks all four steps again when pressed", () => {
    const onReplay = vi.fn();
    const { root } = mountMap({ onReplay });
    const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Ver a recepção de novo")!;
    expect(button.hidden).toBe(false);
    button.click();
    expect(onReplay).toHaveBeenCalledOnce();
    // the panel is gone before the caller mounts the full walkthrough over the same section
    expect(root.querySelector(".loc-onb-panel")).toBeNull();
  });

  it("does not draw it without a handler, or inside the welcome itself", () => {
    const alone = mountMap({});
    expect(alone.root.querySelector<HTMLElement>(".loc-onb-replay")!.hidden).toBe(true);
    alone.onboarding.destroy();
    const welcome = mountMap({ steps: undefined, onReplay: () => {} });
    expect(welcome.root.querySelector<HTMLElement>(".loc-onb-replay")!.hidden).toBe(true);
    welcome.onboarding.destroy();
  });
});

describe("numbers", () => {
  it("writes decimals the way the language does", () => {
    expect(formatFactor(3.8, "pt-BR", 1)).toBe("3,8");
    expect(formatFactor(3.8, "en", 1)).toBe("3.8");
    expect(formatFactor(3.8, "es", 1)).toBe("3,8");
    expect(formatFactor(7, "pt-BR", 0)).toBe("7");
    expect(formatFactor(3.84, undefined, 1)).toBe("3.8");
    expect(formatFactor(1234.5, "pt-BR", 1)).toBe("1234,5");
  });

  it("says 'agora há pouco' under a minute and a number from then on", () => {
    const now = 10_000_000_000;
    expect(isJustNow(now - 5_000, now)).toBe(true);
    expect(isJustNow(now - (JUST_NOW_MS - 1), now)).toBe(true);
    expect(isJustNow(now - JUST_NOW_MS, now)).toBe(false);
    expect(agoLine(t["continue.saved"], t["continue.savedNow"], now - 5_000, now)).toBe("salvo sozinho agora há pouco");
    expect(agoLine(t["continue.saved"], t["continue.savedNow"], now - 3 * 60_000, now)).toBe("salvo sozinho há 3 min");
    expect(formatAgo(now - 61_000, now)).toBe("1 min");
    for (const locale of Object.values(STRINGS)) {
      expect(locale["continue.savedNow"]).not.toContain("{ago}");
      expect(locale["ficha.playedNow"]).not.toContain("{ago}");
      expect(locale["err.crashNow"]).not.toContain("{ago}");
      expect(locale["continue.badgeNow"]).not.toContain("{ago}");
    }
  });
});

describe("the storage meter", () => {
  it("says nothing is kept instead of '1 B de 512 MB'", () => {
    const bar = createTopBar({ t, usage: { used: 1, cap: 512 * 1024 * 1024 }, onPick: () => {} });
    expect(bar.element.querySelector(".loc-meter-text")!.textContent).toBe("Nada guardado ainda");
    bar.update({ usage: { used: 48 * 1024, cap: 512 * 1024 * 1024 } });
    // the bar shows the short line; the meter says the whole one
    expect(bar.element.querySelector(".loc-meter-text")!.textContent).toBe("48 KB de 512 MB");
    expect(bar.element.querySelector(".loc-meter")!.getAttribute("aria-valuetext")).toBe("Neste aparelho: 48 KB de 512 MB");
    expect(isEmptyUsage({ used: 0 })).toBe(true);
    expect(isEmptyUsage({ used: 5000 })).toBe(false);
  });
});

describe("the Continuar card", () => {
  const item = { sha256: "a".repeat(64), platform: "nes", userTitle: "Xadrez NES", headerTitle: "", slots: [], lastPlayedAt: 1, hasFile: true } as unknown as LibraryItem;

  it("sits in a size container of its own, so its layout follows its width and not the page's", () => {
    const host = createContinueCard({ item, t, now: 2, onContinue: () => {}, onPickSave: () => {} });
    expect(host.className).toBe("loc-continue-host");
    expect(host.firstElementChild!.className).toBe("loc-continue");
    const sheet = css("shelf.css");
    expect(sheet).toMatch(/\.loc-continue-host\s*\{[^}]*container:\s*continue\s*\/\s*inline-size/);
    // and no longer by the page: no @container loc rule restyles the card
    for (const block of sheet.split("@container loc").slice(1)) expect(block.split("}")[0]).not.toContain(".loc-continue");
  });

  it("never breaks a word in the middle of a title or splits a button's label", () => {
    const sheet = css("shelf.css");
    const title = /\.loc-continue-title\s*\{[^}]*\}/.exec(sheet)![0];
    expect(title).toContain("overflow-wrap: break-word");
    expect(title).not.toContain("anywhere");
    expect(/\.loc-continue \.loc-button\s*\{[^}]*\}/.exec(sheet)![0]).toContain("white-space: nowrap");
  });

  it("puts the autosave's picture on the TV's screen, under the scan lines, at every width", () => {
    const host = createContinueCard({
      item: { ...item, slots: [{ slot: "auto", at: 1 }] } as unknown as LibraryItem,
      t,
      now: 2,
      autosave: { at: 1, thumbUrl: "blob:x" },
      onContinue: () => {},
      onPickSave: () => {},
    });
    const screen = host.querySelector(".loc-continue-tv .loc-tv-screen")!;
    expect(screen.querySelector(".loc-continue-thumb img.loc-continue-img")?.getAttribute("src")).toBe("blob:x");
    // the glass (the scan lines) is drawn over the picture, not under it
    expect(screen.lastElementChild!.className).toBe("loc-tv-glass");
    expect(host.querySelector(".loc-continue-tv")!.getAttribute("aria-hidden")).toBe("true");
    const sheet = css("shelf.css");
    // the thumbnail is never hidden by a width rule: the TV is the picture
    expect(sheet).not.toMatch(/\.loc-continue-thumb\s*\{[^}]*display:\s*none/);
    expect(sheet).toMatch(/@container continue \(min-width: 640px\)/);
    expect(sheet).toMatch(/@container continue \(max-width: 439px\)/);
  });

  it("without an autosave picture the TV keeps its own idle screen", () => {
    const host = createContinueCard({ item, t, now: 2, onContinue: () => {}, onPickSave: () => {} });
    expect(host.querySelector(".loc-continue-thumb")).toBeNull();
    expect(host.querySelector(".loc-tv-screen .loc-tv-glass")).not.toBeNull();
    expect(host.querySelector(".loc-continue")!.hasAttribute("data-thumb")).toBe(false);
  });
});

describe("the controller map on a phone", () => {
  const mapping = defaultKeymaps().nes;

  it("lists every control as a real button a narrow pane shows instead of the callouts", () => {
    const remap = vi.fn();
    const map = createControllerMap({ t, platform: "nes", mapping, onRemap: remap });
    const items = [...map.element.querySelectorAll<HTMLButtonElement>(".loc-padlist-item")];
    const callouts = [...map.element.querySelectorAll<SVGElement>(".loc-pad-callout")];
    expect(items.map((i) => i.dataset.group)).toEqual(callouts.map((c) => c.dataset.group));
    expect(items.length).toBeGreaterThanOrEqual(5);
    for (const item of items) expect(item.getAttribute("aria-label")).toMatch(/Trocar tecla/);
    items.find((i) => i.dataset.group === "a")!.click();
    expect(remap).toHaveBeenCalledWith(["a"]);
  });

  it("says it is listening in both layouts, and keeps the focus through a redraw", () => {
    const map = createControllerMap({ t, platform: "nes", mapping, onRemap: () => {} });
    document.body.append(map.element);
    map.update({ listening: ["a"] });
    expect(map.element.querySelector(".loc-padlist-item.is-listening .loc-padlist-key")!.textContent).toBe("aperta uma tecla");
    expect(map.element.querySelector(".loc-pad-callout.is-listening")).not.toBeNull();
    map.focusGroup("a");
    expect(document.activeElement?.getAttribute("data-group")).toBe("a");
    map.element.remove();
  });

  it("sizes labels at 12 px or more and targets at 44 px or more under the container query", () => {
    const sheet = css("onboarding.css");
    const rule = (selector: string) => new RegExp(`${selector.replace(/[.[\]]/g, "\\$&")}\\s*\\{[^}]*\\}`).exec(sheet)![0];
    expect(Number(/min-height:\s*(\d+)px/.exec(rule(".loc-padlist-item"))![1])).toBeGreaterThanOrEqual(44);
    expect(Number(/font-size:\s*(\d+)px/.exec(rule(".loc-padlist-what"))![1])).toBeGreaterThanOrEqual(12);
    expect(Number(/font-size:\s*(\d+)px/.exec(rule(".loc-padlist-key"))![1])).toBeGreaterThanOrEqual(12);
    expect(sheet).toMatch(/@container padmap \(max-width: 560px\)[\s\S]*?\.loc-pad-callout,\s*\.loc-pad-leader\s*\{\s*display: none/);
  });
});

describe("the welcome's title", () => {
  it("does not let a programmatic focus draw a ring the width of the panel on the title", () => {
    const sheet = css("onboarding.css");
    expect(sheet).toMatch(/\.loc-onb-title:focus,\s*\.loc-onb-title:focus-visible\s*\{\s*outline: none/);
  });
});

describe("the shelf's head", () => {
  it("is one column as wide as the pane, so the sort select cannot be pushed off the edge", () => {
    expect(/\.loc-shelfview\s*\{[^}]*\}/.exec(css("shelf.css"))![0]).toContain("grid-template-columns: minmax(0, 1fr)");
  });
});

describe("whole device pixels", () => {
  let dpr = 2;
  let stageEl: HTMLElement;
  let game: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="stage"><div id="game"></div></div>';
    stageEl = document.getElementById("stage")!;
    game = document.getElementById("game")!;
    Object.defineProperty(stageEl, "clientWidth", { configurable: true, get: () => 1280 });
    Object.defineProperty(stageEl, "clientHeight", { configurable: true, get: () => 800 });
    vi.spyOn(window, "devicePixelRatio", "get").mockImplementation(() => dpr);
  });
  afterEach(() => vi.restoreAllMocks());

  it("lays the emulator's container out in device pixels and scales it back, so its canvas has one pixel per device pixel", () => {
    const stage = createStage({ stage: stageEl, game, settings: { scale: "pixel" } });
    stage.relayout();
    const fit = fitStage({ viewW: 1280, viewH: 800, baseW: 256, baseH: 240, par: 1, mode: "pixel", dpr: 2 });
    // 6 device pixels per game pixel (3 CSS pixels): the picture is 768 CSS wide, 1536 device
    expect(fit.scale).toBe(6);
    expect(game.style.width).toBe(`${Math.round(fit.width * 2)}px`);
    expect(game.style.height).toBe(`${Math.round(fit.height * 2)}px`);
    expect(game.style.transform).toBe("scale(0.5)");
    expect(Number.parseInt(game.style.width, 10) % 256).toBe(0);
    stage.destroy();
  });

  it("leaves a 1x screen exactly as it was", () => {
    dpr = 1;
    const stage = createStage({ stage: stageEl, game, settings: { scale: "pixel" } });
    stage.relayout();
    expect(game.style.transform).toBe("");
    expect(game.style.width).toBe("100%");
    stage.destroy();
    dpr = 2;
  });

  it("gives every device scale a whole number of device pixels per game pixel", () => {
    for (const ratio of [1, 1.25, 1.5, 2, 2.5, 3]) {
      for (const [w, h] of [[1280, 800], [1366, 768], [390, 844]] as const) {
        const fit = fitStage({ viewW: w, viewH: h, baseW: 256, baseH: 240, par: 1, mode: "pixel", dpr: ratio });
        if (fit.applied !== "pixel") continue;
        expect(Number.isInteger(fit.scale)).toBe(true);
        expect(Number.isInteger(Math.round(fit.width * ratio))).toBe(true);
        expect(Math.round(fit.width * ratio) % 256).toBe(0);
        expect(Math.round(fit.height * ratio) % 240).toBe(0);
      }
    }
  });
});
