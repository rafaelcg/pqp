// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  createHud,
  DEFAULT_TURBO_RATIO,
  formatPlayTime,
  HOLD_POLL_MS,
  IDLE_MS,
  LONG_PRESS_MS,
  SLOT_COUNT,
  stepSlot,
  type Hud,
  type HudAction,
  type HudOptions,
} from "./hud";
import { STRINGS } from "./i18n";
import type { Turbo } from "./runtime";
import { createStage, type Stage } from "./stage";
import { ACTION_TTL_MS, DEFAULT_TTL_MS } from "./ui/toast";

const t = STRINGS["pt-BR"];

/** The stylesheet's text. jsdom gives `import.meta.url` an http scheme, so the path comes from the working directory (the package's, or the repo root's). */
function hudCss(): string {
  const local = "src/styles/hud.css";
  return readFileSync(existsSync(local) ? local : `apps/locadora/${local}`, "utf8");
}

let host: HTMLElement;
let hud: Hud | null;
let stage: Stage;
let runtime: { pause: Mock<(paused: boolean) => void>; setTurbo: Mock<(turbo: Turbo) => void>; setKeyboard: Mock<(enabled: boolean) => void> };
let actions: Array<[HudAction, number]>;

function mount(extra: Partial<HudOptions> = {}): Hud {
  hud = createHud({
    host,
    t,
    runtime,
    stage,
    info: { title: "Cuia Quest", console: "Game Boy Advance" },
    onAction: (action, slot) => actions.push([action, slot]),
    ...extra,
  });
  return hud;
}

const state = () => host.dataset.hud;
const advance = (ms: number) => vi.advanceTimersByTime(ms);
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => host.querySelector(selector) as T;
const action = (name: string) => $<HTMLButtonElement>(`[data-action="${name}"]`);

function press(code: string, init: KeyboardEventInit = {}, type: "keydown" | "keyup" = "keydown", target: EventTarget = document.body) {
  const event = new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}
const tap = (code: string, init: KeyboardEventInit = {}) => {
  press(code, init);
  press(code, init, "keyup");
};
const fire = (node: EventTarget, type: string, init: MouseEventInit = {}) => node.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init }));

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom has no canvas; the stage's ambient light asks for a 2d context and can do without
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  document.body.innerHTML = '<div id="stage"><div id="game"><canvas tabindex="0"></canvas></div></div><input id="field" type="text">';
  host = document.getElementById("stage")!;
  stage = createStage({ stage: host, game: document.getElementById("game")! });
  runtime = { pause: vi.fn<(paused: boolean) => void>(), setTurbo: vi.fn<(turbo: Turbo) => void>(), setKeyboard: vi.fn<(enabled: boolean) => void>() };
  actions = [];
  hud = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  hud?.destroy();
  stage.destroy();
  vi.useRealTimers();
});

describe("when the HUD shows", () => {
  it("is there at the start and fades 2.5 s after the last activity", () => {
    mount();
    expect(state()).toBe("visible");
    advance(IDLE_MS - 1);
    expect(state()).toBe("visible");
    advance(1);
    expect(state()).toBe("hidden");
  });

  it("comes back on pointer move, a tap or Tab, and starts the clock over", () => {
    mount();
    advance(IDLE_MS);
    expect(state()).toBe("hidden");
    fire(host, "pointermove");
    expect(state()).toBe("visible");
    advance(IDLE_MS - 100);
    fire(host, "pointerdown");
    advance(IDLE_MS - 100);
    expect(state()).toBe("visible");
    advance(100);
    expect(state()).toBe("hidden");
    press("Tab");
    expect(state()).toBe("visible");
  });

  it("never hides while focus is inside it, and fades 2.5 s after focus leaves", () => {
    mount();
    const save = action("save");
    save.focus();
    advance(60_000);
    expect(state()).toBe("visible");
    save.blur();
    expect(state()).toBe("visible");
    advance(IDLE_MS);
    expect(state()).toBe("hidden");
  });

  it("is reached by focusing a faded button, which brings it back", () => {
    mount();
    advance(IDLE_MS);
    expect(state()).toBe("hidden");
    action("load").focus();
    expect(state()).toBe("visible");
  });

  it("never hides while the pointer is over it", () => {
    mount();
    const bar = $(".loc-hud-bar");
    fire(bar, "pointerenter");
    advance(60_000);
    expect(state()).toBe("visible");
    fire(bar, "pointerleave");
    advance(IDLE_MS);
    expect(state()).toBe("hidden");
  });

  it("does not count a touch as hovering, which a tap would leave stuck", () => {
    mount();
    const bar = $(".loc-hud-bar");
    const touch = new MouseEvent("pointerenter", { bubbles: false });
    Object.defineProperty(touch, "pointerType", { value: "touch" });
    bar.dispatchEvent(touch);
    advance(IDLE_MS);
    expect(state()).toBe("hidden");
  });

  it("holds while a menu or the drawer is open, and while paused", () => {
    const h = mount();
    h.screenMenu.open();
    advance(60_000);
    expect(state()).toBe("visible");
    // closed without the HUD being told (its poll notices), still 2.5 s after the last hold
    h.screenMenu.close();
    advance(IDLE_MS + HOLD_POLL_MS);
    expect(state()).toBe("hidden");

    h.setDrawerOpen(true);
    advance(60_000);
    expect(state()).toBe("visible");
    h.setDrawerOpen(false);
    advance(IDLE_MS);
    expect(state()).toBe("hidden");

    h.setPaused(true);
    advance(60_000);
    expect(state()).toBe("visible");
    h.setPaused(false);
    advance(IDLE_MS);
    expect(state()).toBe("hidden");
  });

  it("is faded by opacity: a faded button is still in the tab order", () => {
    mount();
    advance(IDLE_MS);
    expect(state()).toBe("hidden");
    // "Mais" is only drawn when the bar is short on room, so it is not one of the whole bar's buttons
    const buttons = host.querySelectorAll(".loc-hud-bar > button, .loc-hud-bar .loc-slotpick button");
    expect(buttons.length).toBeGreaterThan(10);
    for (const node of buttons) expect(node.closest("[hidden]")).toBeNull();
    expect(getComputedStyle($(".loc-hud")).visibility).not.toBe("hidden");
  });

  it("stops everything when it is not active", () => {
    const h = mount();
    h.setActive(false);
    advance(IDLE_MS * 4);
    // not faded, not listening: the stage is not on screen
    tap("KeyP");
    expect(runtime.pause).not.toHaveBeenCalled();
    h.setActive(true);
    tap("KeyP");
    expect(runtime.pause).toHaveBeenCalledWith(true);
  });
});

describe("the buttons", () => {
  const KEYS: Record<string, string> = {
    pause: "P",
    save: "F2",
    "slot-prev": "Shift+F3",
    "slot-next": "F3",
    load: "F4",
    saves: "F6",
    controls: "F1",
    sound: "M",
    fullscreen: "F",
  };

  for (const locale of ["pt-BR", "en", "es"] as const) {
    it(`every button has an aria-label that carries its key (${locale})`, () => {
      mount({ t: STRINGS[locale] });
      // the bar, the top row and the pause overlay; the menus' items are named by their own text
      const buttons = [...host.querySelectorAll<HTMLButtonElement>(".loc-hud-top button, .loc-hud-bar button, .loc-pause button")];
      expect(buttons.length).toBeGreaterThan(12);
      for (const button of buttons) {
        const label = button.getAttribute("aria-label");
        expect(label, button.outerHTML).toBeTruthy();
        const name = button.dataset.action ?? "";
        const key = KEYS[name];
        if (key) expect(label, name).toContain(key);
        // a key hint on screen is in the name too
        for (const kbd of button.querySelectorAll("kbd")) {
          const shown = kbd.textContent ?? "";
          if (shown === "␣") expect(label, name).toMatch(/Space|Espaço|Espacio/);
          else expect(label, name).toContain(shown);
        }
      }
    });
  }

  it("names the slot in Salvar and Carregar, and follows the picker", () => {
    const h = mount();
    expect(action("save").getAttribute("aria-label")).toBe("Salvar no slot 1, F2");
    expect(action("load").getAttribute("aria-label")).toBe("Carregar o slot 1, F4");
    h.setSlot(3);
    expect(action("save").getAttribute("aria-label")).toBe("Salvar no slot 3, F2");
    expect(action("load").getAttribute("aria-label")).toBe("Carregar o slot 3, F4");
    expect($(".loc-slot-text").textContent).toBe("Slot 3");
  });

  it("asks its owner for save, load, saves, controls, sound, fullscreen and eject, with the slot", () => {
    const h = mount({ slot: 2 });
    for (const name of ["save", "load", "saves", "controls", "sound", "fullscreen", "eject"]) action(name).click();
    expect(actions).toEqual([
      ["save", 2],
      ["load", 2],
      ["saves", 2],
      ["controls", 2],
      ["sound", 2],
      ["fullscreen", 2],
      ["eject", 2],
    ]);
    h.setSlot(4);
    action("save").click();
    expect(actions.at(-1)).toEqual(["save", 4]);
  });

  it("gives a mouse click's focus back, so the next Space is the turbo's and not the button's", () => {
    mount();
    const button = action("saves");
    button.focus();
    const click = new MouseEvent("click", { bubbles: true, detail: 1 });
    button.dispatchEvent(click);
    expect(document.activeElement).not.toBe(button);
    // a keyboard press (detail 0) keeps the focus
    button.focus();
    button.click();
    expect(document.activeElement).toBe(button);
  });

  it("shows the sound button's state in its name", () => {
    const h = mount();
    expect(action("sound").getAttribute("aria-label")).toBe("Silenciar o som, M");
    h.setMuted(true);
    expect(action("sound").getAttribute("aria-label")).toBe("Ligar o som, M");
  });

  it("puts the title and the play time on the chip, as text", () => {
    let clock = 0;
    const h = mount({ now: () => clock, info: { title: "<b>Cuia</b>", console: "NES" } });
    expect($(".loc-hud-title b").textContent).toBe("<b>Cuia</b>");
    expect($(".loc-hud-title b").children).toHaveLength(0);
    expect($(".loc-hud-title small").textContent).toBe("NES · 0 min de jogo");
    clock = 72 * 60_000;
    advance(15_000);
    expect($(".loc-hud-title small").textContent).toBe("NES · 1h12 de jogo");
    // paused time is not play time
    h.setPaused(true);
    clock += 30 * 60_000;
    advance(15_000);
    h.setPaused(false);
    expect($(".loc-hud-title small").textContent).toBe("NES · 1h12 de jogo");
  });
});

describe("shortcuts", () => {
  it("P pauses and resumes through the runtime, with the overlay and its Continuar", () => {
    const paused: boolean[] = [];
    const h = mount({ onPausedChange: (p) => paused.push(p) });
    const overlay = $(".loc-pause");
    expect(overlay.hidden).toBe(true);
    tap("KeyP");
    expect(runtime.pause).toHaveBeenLastCalledWith(true);
    expect(h.paused).toBe(true);
    expect(overlay.hidden).toBe(false);
    expect(overlay.textContent).toContain("Pausado");
    expect(host.dataset.paused).toBe("true");
    expect(action("pause").getAttribute("aria-label")).toBe("Continuar, P");
    $<HTMLButtonElement>(".loc-pause-resume").click();
    expect(runtime.pause).toHaveBeenLastCalledWith(false);
    expect(overlay.hidden).toBe(true);
    tap("KeyP");
    tap("KeyP");
    expect(paused).toEqual([true, false, true, false]);
  });

  it("F2, F4, F6, F1, M and F ask for their action", () => {
    mount();
    tap("F2");
    tap("F4");
    tap("F6");
    tap("F1");
    tap("KeyM");
    tap("KeyF");
    expect(actions.map(([name]) => name)).toEqual(["save", "load", "saves", "controls", "sound", "fullscreen"]);
  });

  it("F3 and Shift+F3 walk the four slots and wrap", () => {
    const seen: number[] = [];
    const h = mount({ onSlotChange: (slot) => seen.push(slot) });
    tap("F3");
    tap("F3");
    tap("F3");
    tap("F3");
    expect(seen).toEqual([2, 3, 4, 1]);
    tap("F3", { shiftKey: true });
    expect(h.slot).toBe(SLOT_COUNT);
    tap("F2");
    expect(actions.at(-1)).toEqual(["save", SLOT_COUNT]);
  });

  it("are ignored while a text field has focus", () => {
    mount();
    const field = document.getElementById("field") as HTMLInputElement;
    field.focus();
    for (const code of ["KeyP", "KeyM", "KeyF", "KeyT", "F2", "F3", "F4", "F6", "F1", "Space"]) press(code, {}, "keydown", field);
    press("Space", {}, "keyup", field);
    expect(runtime.pause).not.toHaveBeenCalled();
    expect(runtime.setTurbo).not.toHaveBeenCalled();
    expect(actions).toEqual([]);
    // and the game does not hear the typing either
    expect(runtime.setKeyboard).toHaveBeenLastCalledWith(false);
  });

  it("wake the HUD, except the turbo hold", () => {
    mount();
    advance(IDLE_MS);
    press("Space");
    expect(state()).toBe("hidden");
    press("Space", {}, "keyup");
    tap("F3");
    expect(state()).toBe("visible");
  });
});

describe("turbo", () => {
  it("holds while Space is down and lets go when it comes up", () => {
    const h = mount();
    press("Space");
    expect(runtime.setTurbo).toHaveBeenLastCalledWith(DEFAULT_TURBO_RATIO);
    expect(h.turbo).toBe(DEFAULT_TURBO_RATIO);
    press("Space", { repeat: true });
    press("Space", {}, "keyup");
    expect(runtime.setTurbo).toHaveBeenLastCalledWith(0);
    expect(h.turbo).toBe(0);
    expect(runtime.setTurbo).toHaveBeenCalledTimes(2);
  });

  it("T toggles, and a toggled turbo outlives a release of Space", () => {
    const h = mount();
    tap("KeyT");
    expect(h.turbo).toBe(3);
    press("Space");
    press("Space", {}, "keyup");
    // the hold ended, the toggle did not
    expect(h.turbo).toBe(3);
    expect(runtime.setTurbo).not.toHaveBeenCalledWith(0);
    tap("KeyT");
    expect(h.turbo).toBe(0);
    expect(runtime.setTurbo).toHaveBeenLastCalledWith(0);
  });

  it("shows the amber pill and the corner flag only while on, static", () => {
    mount();
    const pill = $(".loc-pill-turbo");
    const flag = $(".loc-turbo-flag");
    expect(pill.hidden).toBe(true);
    expect(flag.hidden).toBe(true);
    tap("KeyT");
    expect(pill.hidden).toBe(false);
    expect(pill.textContent).toBe("▸▸ Turbo 3x");
    expect(flag.textContent).toBe("▸▸ 3x");
    expect(flag.getAttribute("aria-hidden")).toBe("true");
    expect(action("turbo").getAttribute("aria-pressed")).toBe("true");
    pill.click();
    expect(pill.hidden).toBe(true);
    expect(flag.hidden).toBe(true);
    expect(action("turbo").getAttribute("aria-pressed")).toBe("false");
  });

  it("a click on the button toggles it", () => {
    const h = mount();
    action("turbo").click();
    expect(h.turbo).toBe(3);
    action("turbo").click();
    expect(h.turbo).toBe(0);
  });

  it("a long press opens the speed popover, picking a quick speed sets the ratio, and the press that opened it is not a click", () => {
    const h = mount();
    const button = action("turbo");
    fire(button, "pointerdown", { button: 0 });
    advance(LONG_PRESS_MS - 1);
    expect($(".loc-turbo-menu").hidden).toBe(true);
    advance(1);
    const menu = $(".loc-turbo-menu");
    expect(menu.hidden).toBe(false);
    expect(menu.getAttribute("role")).toBe("dialog");
    expect([...menu.querySelectorAll(".loc-turbo-chip")].map((b) => b.textContent)).toEqual(["2x", "4x", "8x", "10x"]);
    expect($<HTMLInputElement>(".loc-turbo-slider").value).toBe("3");
    fire(button, "pointerup");
    button.click();
    expect(h.turbo).toBe(0);
    menu.querySelector<HTMLButtonElement>('[data-ratio="8"]')!.click();
    // the popover stays up: the slider is for trying speeds, and the chips are only shortcuts on it
    expect(menu.hidden).toBe(false);
    expect(h.turboRatio).toBe(8);
    // the ratio is kept for the next hold
    press("Space");
    expect(runtime.setTurbo).toHaveBeenLastCalledWith(8);
    press("Space", {}, "keyup");
  });

  it("a short press is only a click", () => {
    const h = mount();
    const button = action("turbo");
    fire(button, "pointerdown", { button: 0 });
    advance(LONG_PRESS_MS - 100);
    fire(button, "pointerup");
    advance(LONG_PRESS_MS);
    expect($(".loc-turbo-menu").hidden).toBe(true);
    button.click();
    expect(h.turbo).toBe(3);
  });

  it("opens the popover from the keyboard too, with the focus on the slider, and Escape closes it and gives the focus back", () => {
    mount();
    const button = action("turbo");
    button.focus();
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    const menu = $(".loc-turbo-menu");
    expect(menu.hidden).toBe(false);
    expect(document.activeElement).toBe($(".loc-turbo-slider"));
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it("has no 'Turbo ligado' toast: the pill and the counter say it, and the only turbo toast is the 1x one", () => {
    mount();
    tap("KeyT");
    expect($(".loc-toasts").textContent).toBe("");
    tap("KeyT");
    press("Space");
    press("Space", {}, "keyup");
    expect($(".loc-toasts").textContent).toBe("");
    expect("toast.turbo" in STRINGS["pt-BR"]).toBe(false);
  });

  it("does not stay on after the HUD is torn down", () => {
    const h = mount();
    press("Space");
    h.destroy();
    hud = null;
    expect(runtime.setTurbo).toHaveBeenLastCalledWith(0);
  });
});

describe("the turbo slider", () => {
  const slider = () => $<HTMLInputElement>(".loc-turbo-slider");
  const setSlider = (value: number) => {
    slider().value = String(value);
    fire(slider(), "input");
  };
  const key = (name: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
    slider().dispatchEvent(event);
    return event;
  };
  const menu = () => $(".loc-turbo-menu");
  const chip = (ratio: number) => $<HTMLButtonElement>(`.loc-turbo-chip[data-ratio="${ratio}"]`);
  /** Every call to the runtime, in order: what the core would have been told. */
  const sent = () => runtime.setTurbo.mock.calls.map(([turbo]) => turbo);

  it("is a native range from 1 to 10 in half steps, with a name, a spoken value, a live readout and its two ends", () => {
    mount();
    const input = slider();
    expect(input.type).toBe("range");
    expect([input.min, input.max, input.step, input.value]).toEqual(["1", "10", "0.5", "3"]);
    expect(input.getAttribute("aria-label")).toBe("Velocidade do turbo, de 1x a 10x");
    expect(input.getAttribute("aria-valuetext")).toBe("3 vezes a velocidade normal");
    expect($(".loc-turbo-readout").textContent).toBe("3x");
    expect([...menu().querySelectorAll(".loc-turbo-scale span")].map((n) => n.textContent)).toEqual(["1x", "10x"]);
    expect(menu().getAttribute("aria-label")).toBe("Velocidade do turbo");
    expect(menu().querySelector(".loc-turbo-chips")?.getAttribute("aria-label")).toBe("Velocidades prontas");
  });

  it("opens from the visible chevron, says so on both buttons, takes the focus, and a second press closes it", () => {
    mount();
    const caret = action("turbo-caret");
    expect(caret.getAttribute("aria-label")).toBe("Ajustar a velocidade do turbo");
    expect(caret.getAttribute("aria-haspopup")).toBe("dialog");
    expect(menu().hidden).toBe(true);
    caret.click();
    expect(menu().hidden).toBe(false);
    expect(caret.getAttribute("aria-expanded")).toBe("true");
    expect(action("turbo").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(slider());
    caret.click();
    expect(menu().hidden).toBe(true);
    expect(caret.getAttribute("aria-expanded")).toBe("false");
    // the chevron is not a turbo toggle
    expect(runtime.setTurbo).not.toHaveBeenCalled();
  });

  it("keeps the popover up while the HUD would fade, and lets it fade after", () => {
    mount();
    action("turbo-caret").click();
    advance(IDLE_MS * 4);
    expect(state()).toBe("visible");
    $(".loc-turbo-menu").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    advance(IDLE_MS + HOLD_POLL_MS);
    expect(state()).toBe("hidden");
  });

  it("applies a new ratio live while turbo is on, as one change of the runtime's, and keeps the number on the pill and the flag", () => {
    const changes: number[] = [];
    const h = mount({ onTurboChange: (turbo) => changes.push(turbo) });
    tap("KeyT");
    expect(sent()).toEqual([3]);
    setSlider(4.5);
    expect(sent()).toEqual([3, 4.5]);
    expect(h.turbo).toBe(4.5);
    expect(changes).toEqual([3, 4.5]);
    expect($(".loc-pill-turbo").textContent).toBe("▸▸ Turbo 4.5x");
    expect($(".loc-turbo-flag").textContent).toBe("▸▸ 4.5x");
    expect($(".loc-turbo-readout").textContent).toBe("4.5x");
    expect(slider().getAttribute("aria-valuetext")).toBe("4.5 vezes a velocidade normal");
  });

  it("only remembers the ratio while turbo is off: the core is not told anything until it is switched on", () => {
    const h = mount();
    setSlider(6.5);
    expect(runtime.setTurbo).not.toHaveBeenCalled();
    expect(h.turboRatio).toBe(6.5);
    action("turbo").click();
    expect(sent()).toEqual([6.5]);
  });

  it("writes the speed with the language's decimal mark", () => {
    mount({ locale: "pt-BR" });
    tap("KeyT");
    setSlider(4.5);
    expect($(".loc-pill-turbo").textContent).toBe("▸▸ Turbo 4,5x");
    expect($(".loc-turbo-readout").textContent).toBe("4,5x");
    expect(slider().getAttribute("aria-valuetext")).toBe("4,5 vezes a velocidade normal");
    expect($(".loc-turbo-chips").textContent).toBe("2x4x8x10x");
  });

  it("is operable by keyboard: arrows step by half, PageUp and PageDown by one, Home and End go to the ends", () => {
    const h = mount();
    action("turbo-caret").click();
    const steps: Array<[string, number]> = [
      ["ArrowRight", 3.5],
      ["ArrowLeft", 3],
      ["ArrowUp", 3.5],
      ["ArrowDown", 3],
      ["PageUp", 4],
      ["PageDown", 3],
      ["End", 10],
      ["ArrowRight", 10],
      ["PageUp", 10],
      ["Home", 1],
      ["ArrowLeft", 1],
      ["PageDown", 1],
    ];
    for (const [name, expected] of steps) {
      const event = key(name);
      expect(event.defaultPrevented, name).toBe(true);
      expect(h.turboRatio, name).toBe(expected);
      expect(slider().value, name).toBe(String(expected));
    }
    // the keys that are not the slider's are left alone, and so are chords
    expect(key("a").defaultPrevented).toBe(false);
    expect(key("ArrowRight", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(h.turboRatio).toBe(1);
  });

  it("snaps to half steps and holds between 1 and 10, and a bad number is the default", () => {
    const h = mount();
    h.setTurboRatio(4.3);
    expect(h.turboRatio).toBe(4.5);
    h.setTurboRatio(4.74);
    expect(h.turboRatio).toBe(4.5);
    h.setTurboRatio(4.76);
    expect(h.turboRatio).toBe(5);
    h.setTurboRatio(99);
    expect(h.turboRatio).toBe(10);
    h.setTurboRatio(-3);
    expect(h.turboRatio).toBe(1);
    h.setTurboRatio(Number.NaN);
    expect(h.turboRatio).toBe(DEFAULT_TURBO_RATIO);
  });

  it("has the quick picks 2x, 4x, 8x and 10x under it, the one at the slider pressed", () => {
    const h = mount();
    expect([2, 4, 8, 10].map((n) => chip(n).getAttribute("aria-pressed"))).toEqual(["false", "false", "false", "false"]);
    chip(8).click();
    expect(h.turboRatio).toBe(8);
    expect(slider().value).toBe("8");
    expect([2, 4, 8, 10].map((n) => chip(n).getAttribute("aria-pressed"))).toEqual(["false", "false", "true", "false"]);
    setSlider(5);
    expect([2, 4, 8, 10].map((n) => chip(n).getAttribute("aria-pressed"))).toEqual(["false", "false", "false", "false"]);
  });

  it("is what the toggle and the held key run at, from the saved ratio on the first press", () => {
    mount({ turboRatio: 6.5 });
    press("Space");
    expect(sent()).toEqual([6.5]);
    press("Space", {}, "keyup");
    tap("KeyT");
    action("turbo").click();
    expect(sent()).toEqual([6.5, 0, 6.5, 0]);
    expect($(".loc-toasts").textContent).toBe("");
  });

  it("tolerates a bad saved ratio: out of range is clamped, anything that is not a number is the default", () => {
    const start = (turboRatio: unknown) => {
      hud?.destroy();
      const h = mount({ turboRatio: turboRatio as number });
      return h.turboRatio;
    };
    expect(start(99)).toBe(10);
    expect(start(0.2)).toBe(1);
    expect(start(2.7)).toBe(2.5);
    expect(start(Number.NaN)).toBe(DEFAULT_TURBO_RATIO);
    expect(start(Infinity)).toBe(DEFAULT_TURBO_RATIO);
    expect(start("4")).toBe(DEFAULT_TURBO_RATIO);
    expect(start(null)).toBe(DEFAULT_TURBO_RATIO);
    expect(start(undefined)).toBe(DEFAULT_TURBO_RATIO);
  });

  it("tells its owner about each change of the ratio, once, and not about a press that changes nothing", () => {
    const kept: number[] = [];
    mount({ onTurboRatioChange: (ratio) => kept.push(ratio) });
    setSlider(4.5);
    setSlider(4.5);
    chip(4).click();
    chip(4).click();
    key("End");
    expect(kept).toEqual([4.5, 4, 10]);
  });

  describe("at 1x", () => {
    it("does nothing when asked for: no run of the core, a hint with a way to the slider, and the button says so", () => {
      const h = mount({ turboRatio: 1 });
      expect(action("turbo").getAttribute("aria-label")).toBe("Turbo em 1x, não acelera nada. Segura pra ajustar a velocidade");
      expect(action("turbo").dataset.idle).toBe("true");
      action("turbo").click();
      expect(h.turbo).toBe(0);
      expect(action("turbo").getAttribute("aria-pressed")).toBe("false");
      expect(runtime.setTurbo).not.toHaveBeenCalled();
      expect($(".loc-toasts").textContent).toContain("Turbo em 1x não acelera nada.");
      // the hint's Ajustar goes to the slider
      $<HTMLButtonElement>(".loc-toast-action").click();
      expect(menu().hidden).toBe(false);
      expect(document.activeElement).toBe(slider());
    });

    it("says it for the key too, the toggle and the hold, and never starts a run", () => {
      const h = mount({ turboRatio: 1 });
      tap("KeyT");
      expect($(".loc-toasts").textContent).toContain("Turbo em 1x");
      advance(DEFAULT_TTL_MS + ACTION_TTL_MS);
      expect($(".loc-toasts").textContent).toBe("");
      press("Space");
      expect($(".loc-toasts").textContent).toContain("Turbo em 1x");
      press("Space", {}, "keyup");
      expect(h.turbo).toBe(0);
      expect(runtime.setTurbo).not.toHaveBeenCalled();
    });

    it("is the same hint on the pill's side: no pill, no flag", () => {
      mount({ turboRatio: 1 });
      tap("KeyT");
      expect($(".loc-pill-turbo").hidden).toBe(true);
      expect($(".loc-turbo-flag").hidden).toBe(true);
    });

    it("sliding down to 1x while turbo runs stops it, sliding back up starts it again, and closing at 1x disarms it", () => {
      const h = mount();
      action("turbo-caret").click();
      tap("KeyT");
      expect(sent()).toEqual([3]);
      setSlider(1);
      expect(sent()).toEqual([3, 0]);
      expect(h.turbo).toBe(0);
      expect(action("turbo").getAttribute("aria-pressed")).toBe("false");
      setSlider(5);
      expect(sent()).toEqual([3, 0, 5]);
      setSlider(1);
      menu().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      // it was left at 1x: raising the speed later does not start a turbo nobody asked for
      h.setTurboRatio(5);
      expect(h.turbo).toBe(0);
      expect(sent()).toEqual([3, 0, 5, 0]);
    });

    it("the readout and the end of the track read as resting, and the spoken value says there is no turbo", () => {
      mount();
      setSlider(1);
      expect(menu().dataset.idle).toBe("true");
      expect(slider().getAttribute("aria-valuetext")).toBe("1 vez, a velocidade normal, sem turbo");
      setSlider(1.5);
      expect(menu().dataset.idle).toBe("false");
      expect(slider().getAttribute("aria-valuetext")).toBe("1.5 vezes a velocidade normal");
    });
  });

  describe("the sound note", () => {
    it("shows above 3x and not at or below it, in the space it always has", () => {
      mount();
      const note = $(".loc-turbo-note");
      expect(note.textContent).toBe("Sem som no turbo acima de 3x");
      expect(note.dataset.on).toBe("false");
      expect(note.getAttribute("aria-hidden")).toBe("true");
      setSlider(3);
      expect(note.dataset.on).toBe("false");
      setSlider(3.5);
      expect(note.dataset.on).toBe("true");
      expect(note.getAttribute("aria-hidden")).toBe("false");
      setSlider(10);
      expect(note.dataset.on).toBe("true");
    });

    it("is in every language, without a comma where the number is written", () => {
      for (const locale of ["pt-BR", "en", "es"] as const) {
        const copy = STRINGS[locale];
        expect(copy["hud.turboMute"]).toContain("{n}");
        for (const key of ["hud.turboAria1x", "hud.turboCaret", "hud.turboSlider", "hud.turboValue", "hud.turboValueOff", "hud.turboPresets", "toast.turbo1x", "toast.turbo1xAction"] as const) {
          expect(copy[key].length, `${locale}.${key}`).toBeGreaterThan(0);
        }
        expect(copy["hud.turboValue"]).toContain("{n}");
      }
    });
  });

  describe("the popover's keys and clicks", () => {
    it("Escape closes it without leaving full screen, and the focus goes back to what opened it", () => {
      mount();
      const page = vi.fn();
      document.addEventListener("keydown", page);
      action("turbo-caret").click();
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      slider().dispatchEvent(event);
      document.removeEventListener("keydown", page);
      expect(event.defaultPrevented).toBe(true);
      expect(page).not.toHaveBeenCalled();
      expect(menu().hidden).toBe(true);
      expect(document.activeElement).toBe(action("turbo-caret"));
    });

    it("Escape closes it even when a click on Turbo left the focus on the page", () => {
      mount();
      action("turbo-caret").click();
      action("turbo").click();
      // a real click on a button focuses it, and the HUD blurs it again so the next Space is the turbo's
      (document.activeElement as HTMLElement).blur();
      expect(document.activeElement).toBe(document.body);
      expect(menu().hidden).toBe(false);
      press("Escape");
      expect(menu().hidden).toBe(true);
      // and the listener went with it: a later Escape is nobody's business here
      const event = press("Escape");
      expect(event.defaultPrevented).toBe(false);
    });

    it("Tab walks slider then the four picks, and past either end closes it and hands back to the opener", () => {
      mount();
      action("turbo").focus();
      fire(action("turbo"), "contextmenu");
      expect(document.activeElement).toBe(slider());
      // forward inside the popover is the browser's own
      const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      slider().dispatchEvent(forward);
      expect(forward.defaultPrevented).toBe(false);
      expect(menu().hidden).toBe(false);
      // past the last pick
      chip(10).focus();
      const past = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      chip(10).dispatchEvent(past);
      expect(past.defaultPrevented).toBe(true);
      expect(menu().hidden).toBe(true);
      expect(document.activeElement).toBe(action("turbo"));
      // back from the slider
      action("turbo-caret").click();
      const back = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
      slider().dispatchEvent(back);
      expect(back.defaultPrevented).toBe(true);
      expect(menu().hidden).toBe(true);
      expect(document.activeElement).toBe(action("turbo-caret"));
    });

    it("a press anywhere else closes it, and a press inside it does not", () => {
      mount();
      action("turbo-caret").click();
      fire(slider(), "pointerdown");
      fire(chip(4), "pointerdown");
      expect(menu().hidden).toBe(false);
      fire(document.body, "pointerdown");
      expect(menu().hidden).toBe(true);
    });

    it("opening the screen menu closes it, and the other way round", () => {
      const h = mount();
      action("turbo-caret").click();
      action("screen").click();
      expect(menu().hidden).toBe(true);
      expect(h.screenMenu.isOpen).toBe(true);
      action("turbo-caret").click();
      expect(h.screenMenu.isOpen).toBe(false);
      expect(menu().hidden).toBe(false);
    });

    it("the keyboard of the game is off while the slider has the focus, so an arrow never also moves the player", () => {
      mount();
      action("turbo-caret").click();
      expect(runtime.setKeyboard).toHaveBeenLastCalledWith(false);
      slider().blur();
      expect(runtime.setKeyboard).toHaveBeenLastCalledWith(true);
    });

    it("does not start turbo from Space while the slider has the focus", () => {
      mount();
      action("turbo-caret").click();
      press("Space", {}, "keydown", slider());
      press("Space", {}, "keyup", slider());
      expect(runtime.setTurbo).not.toHaveBeenCalled();
    });
  });

  describe("on the short bar and the phone", () => {
    function lay(stageWidth: number) {
      Object.defineProperty(host, "clientWidth", { configurable: true, get: () => stageWidth });
      vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("loc-hud-bar") ? 765 : 0;
      });
    }

    it("has no room for the chevron on the short bar: Turbo stands alone there and the speed is a line in 'Mais'", () => {
      lay(320);
      mount();
      expect($(".loc-hud-bar").dataset.compact).toBe("true");
      expect($(".loc-hb-split")?.parentElement ?? null).not.toBe($(".loc-hud-bar"));
      expect(action("turbo").parentElement).toBe($(".loc-hud-bar"));
      const line = action("turbo-speed");
      expect(line.closest(".loc-more-menu")).not.toBeNull();
      expect(line.textContent).toContain("Velocidade do turbo");
      // the line shows the speed it is at, and follows it
      expect(line.querySelector("kbd")?.textContent).toBe("3x");
      hud?.setTurboRatio(4.5);
      expect(line.querySelector("kbd")?.textContent).toBe("4.5x");
    });

    it("opens the popover from 'Mais', hung from 'Mais' and held inside the stage, and gives the focus back to it", () => {
      lay(320);
      mount();
      action("more").click();
      expect($(".loc-more-menu").hidden).toBe(false);
      action("turbo-speed").click();
      expect(menu().hidden).toBe(false);
      expect($(".loc-more-menu").hidden).toBe(true);
      expect(document.activeElement).toBe(slider());
      // placed at 'Mais' and never past the stage's left edge
      expect(parseFloat(menu().style.left)).toBeGreaterThanOrEqual(8);
      expect(menu().style.bottom).not.toBe("");
      expect(menu().style.maxHeight).not.toBe("");
      menu().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      expect(menu().hidden).toBe(true);
      expect(document.activeElement).toBe(action("more"));
    });

    it("opens from a long press on Turbo on the short bar too", () => {
      lay(320);
      mount();
      fire(action("turbo"), "pointerdown", { button: 0 });
      advance(LONG_PRESS_MS);
      expect(menu().hidden).toBe(false);
    });

    it("opening 'Mais' closes the popover", () => {
      lay(320);
      mount();
      action("more").click();
      action("turbo-speed").click();
      action("more").click();
      expect(menu().hidden).toBe(true);
      expect($(".loc-more-menu").hidden).toBe(false);
    });

    it("keeps the chevron beside Turbo on the whole bar, and puts Turbo back beside it when the bar grows again", () => {
      lay(320);
      mount();
      expect(action("turbo").parentElement).toBe($(".loc-hud-bar"));
      // the bar measures itself again whenever the stage changes shape; full screen is one such change
      lay(1400);
      hud!.setFullscreen(true);
      expect(action("turbo").parentElement?.className).toBe("loc-hb-split");
      expect([...$(".loc-hb-split").children].map((n) => (n as HTMLElement).dataset.action)).toEqual(["turbo", "turbo-caret"]);
    });

    it("fits a 320 px stage by its stylesheet: 280 px at most, 16 px of air, a 44 px thumb under a finger, no motion without a say", () => {
      const css = hudCss();
      expect(css).toMatch(/\.loc-turbo-menu\s*\{[^}]*width: min\(280px, calc\(100% - 16px\)\)/);
      expect(css).toMatch(/@media \(pointer: coarse\)\s*\{[^@]*::-webkit-slider-thumb\s*\{\s*width: 44px;\s*height: 44px/);
      expect(css).toMatch(/@media \(pointer: coarse\)\s*\{[^@]*::-moz-range-thumb\s*\{\s*width: 44px;\s*height: 44px/);
      expect(css).toMatch(/\.loc-turbo-chip\s*\{[^}]*min-height: 44px/);
      // every transition of the turbo's parts sits under no-preference
      const section = css.slice(css.indexOf("the Turbo button and its chevron"), css.indexOf("---- the turbo flag"));
      const firstTransition = section.indexOf("transition");
      expect(firstTransition).toBeGreaterThan(-1);
      expect(section.indexOf("@media (prefers-reduced-motion: no-preference)")).toBeGreaterThan(-1);
      expect(section.indexOf("@media (prefers-reduced-motion: no-preference)")).toBeLessThan(firstTransition);
      expect(section.slice(0, section.indexOf("@media (prefers-reduced-motion: no-preference)"))).not.toContain("transition");
    });
  });
});

describe("the screen menu and the stage", () => {
  it("opens from the pill and from the bar button, and says so with aria-expanded", () => {
    const h = mount();
    action("screen-pill").click();
    expect(h.screenMenu.isOpen).toBe(true);
    expect(action("screen-pill").getAttribute("aria-expanded")).toBe("true");
    expect(action("screen").getAttribute("aria-expanded")).toBe("true");
    expect(host.contains(h.screenMenu.element)).toBe(true);
    h.screenMenu.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(h.screenMenu.isOpen).toBe(false);
    expect(action("screen-pill").getAttribute("aria-expanded")).toBe("false");
    action("screen").click();
    expect(h.screenMenu.isOpen).toBe(true);
  });

  it("changes go to the stage", () => {
    const h = mount();
    h.screenMenu.open();
    h.screenMenu.element.querySelector<HTMLElement>('[data-key="fit"]')!.click();
    expect(stage.settings.scale).toBe("fit");
    h.screenMenu.element.querySelector<HTMLElement>('[data-key="crt"]')!.click();
    expect(stage.settings.crt).toBe(true);
    expect(action("crt").getAttribute("aria-pressed")).toBe("true");
    action("crt").click();
    expect(stage.settings.crt).toBe(false);
    expect(action("crt").getAttribute("aria-pressed")).toBe("false");
  });

  it("follows a change made elsewhere", () => {
    const h = mount();
    stage.update({ ambient: true });
    h.screenMenu.open();
    expect(h.screenMenu.element.querySelector('[data-key="ambient"]')?.getAttribute("aria-checked")).toBe("true");
  });

  it("reads the picture's size into the pill", () => {
    const fake = {
      settings: { scale: null, aspect: "square", crt: false, ambient: false, bezel: false },
      layout: { width: 720, height: 480, applied: "pixel", scale: 3, cssScale: 3, integerScale: 3, scaleMode: "pixel", system: "gba", baseW: 240, baseH: 160 },
      update: vi.fn(),
      onChange: vi.fn(),
      setFullscreen: vi.fn(),
    } as unknown as Stage;
    mount({ stage: fake });
    expect($(".loc-pill-screen").textContent).toBe("Pixel perfeito · 3x");
    expect($(".loc-pill-screen").getAttribute("aria-label")).toBe("Tela: Pixel perfeito · 3x");
  });
});

describe("full screen", () => {
  it("tells the stage, shows 'Sair Esc' only while full, and swaps the button", () => {
    const setFullscreen = vi.spyOn(stage, "setFullscreen");
    const h = mount();
    const exit = action("exit-fullscreen");
    expect(exit.hidden).toBe(true);
    h.setFullscreen(true);
    expect(setFullscreen).toHaveBeenCalledWith(true);
    expect(exit.hidden).toBe(false);
    expect(exit.getAttribute("aria-label")).toBe("Sair da tela cheia, Esc");
    expect(exit.textContent).toContain("Sair");
    expect(host.dataset.fs).toBe("true");
    expect(action("fullscreen").getAttribute("aria-label")).toBe("Sair da tela cheia, F");
    exit.click();
    expect(actions.at(-1)?.[0]).toBe("fullscreen");
    h.setFullscreen(false);
    expect(exit.hidden).toBe(true);
    expect(action("fullscreen").getAttribute("aria-label")).toBe("Tela cheia (F ou duplo clique)");
  });

  it("tells, in the button's hover text and spoken name, that a double click is full screen too", () => {
    const h = mount();
    const button = action("fullscreen");
    expect(button.title).toBe("Tela cheia (F ou duplo clique)");
    expect(button.getAttribute("aria-label")).toBe("Tela cheia (F ou duplo clique)");
    h.setFullscreen(true);
    expect(button.title).toBe("Sair da tela cheia, F");
    h.setFullscreen(false);
    expect(button.title).toBe("Tela cheia (F ou duplo clique)");
    expect(STRINGS.en["hud.fullAria"]).toBe("Fullscreen (F or double-click)");
    expect(STRINGS.es["hud.fullAria"]).toBe("Pantalla completa (F o doble clic)");
    for (const lang of ["pt-BR", "en", "es"] as const) expect(STRINGS[lang]["hud.fullAria"]).not.toContain(String.fromCharCode(0x2014));
  });

  it("hides the cursor with the HUD (a CSS rule keyed on the attributes)", () => {
    const css = hudCss();
    expect(css).toMatch(/\[data-fs="true"\]\[data-hud="hidden"\]\s*\{\s*cursor:\s*none/);
  });

  it("shows no hint when the controls fade in full screen: no toast, no overlay line", () => {
    const h = mount();
    expect(document.querySelector(".loc-fs-hint")).toBeNull();
    h.setFullscreen(true);
    advance(IDLE_MS);
    expect(state()).toBe("hidden");
    expect(document.querySelector(".loc-fs-hint")).toBeNull();
    expect($(".loc-toasts").textContent).toBe("");
  });

  it("fades in full screen after Tela cheia was pressed with the mouse: the bar moved away and no pointerleave came", () => {
    const h = mount();
    const bar = $(".loc-hud-bar");
    fire(bar, "pointerenter");
    // the press: the room becomes full screen and the bar is no longer under the pointer, without any pointerleave
    h.setFullscreen(true);
    advance(IDLE_MS);
    expect(state()).toBe("hidden");
  });

  it("a move over the picture takes back a hover whose pointerleave never came", () => {
    mount();
    fire($(".loc-hud-bar"), "pointerenter");
    advance(IDLE_MS * 2);
    expect(state()).toBe("visible");
    $("canvas").dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
    advance(IDLE_MS);
    expect(state()).toBe("hidden");
    // and a move over the bar still holds it up
    $(".loc-hud-bar").dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
    advance(IDLE_MS * 2);
    expect(state()).toBe("visible");
  });

});

describe("the double click on the picture", () => {
  const dblclick = (node: EventTarget) => fire(node, "dblclick", { detail: 2, button: 0, cancelable: true });

  it("asks for full screen, both ways, through the same action as the button and F", () => {
    const h = mount();
    dblclick($("canvas"));
    expect(actions).toEqual([["fullscreen", 1]]);
    h.setFullscreen(true);
    dblclick($("canvas"));
    expect(actions.map(([name]) => name)).toEqual(["fullscreen", "fullscreen"]);
  });

  it("on the black around the picture too", () => {
    mount();
    dblclick(host);
    expect(actions).toEqual([["fullscreen", 1]]);
  });

  it("not on a control of the HUD, the screen menu, the pause card or a toast", () => {
    const h = mount();
    for (const name of ["save", "pause", "fullscreen", "screen-pill"]) dblclick(action(name));
    action("screen-pill").click();
    actions = [];
    const menu = $(".loc-menu");
    expect(menu.hidden).toBe(false);
    dblclick(menu.querySelector("button")!);
    expect(actions.filter(([name]) => name === "fullscreen")).toEqual([]);
    h.setPaused(true);
    dblclick($(".loc-pause-resume"));
    dblclick($(".loc-pause"));
    h.toast("oi");
    dblclick($(".loc-hud-toasts"));
    expect(actions.filter(([name]) => name === "fullscreen")).toEqual([]);
  });

  it("a single click is just a click: no full screen, no pause", () => {
    const h = mount();
    fire($("canvas"), "click", { detail: 1 });
    expect(actions).toEqual([]);
    expect(h.paused).toBe(false);
    expect(runtime.pause).not.toHaveBeenCalledWith(true);
  });

  it("keeps the second press from selecting the words around it", () => {
    mount();
    const second = new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 2 });
    $("canvas").dispatchEvent(second);
    expect(second.defaultPrevented).toBe(true);
    const first = new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 1 });
    $("canvas").dispatchEvent(first);
    expect(first.defaultPrevented).toBe(false);
  });

  it("is not announced by a toast: the controls going away in a window says nothing", () => {
    mount();
    advance(IDLE_MS);
    expect(state()).toBe("hidden");
    expect(document.querySelector(".loc-fs-hint")).toBeNull();
    expect($(".loc-toasts").textContent).toBe("");
  });
});

describe("toasts", () => {
  it("says 'Tri! Salvo no slot 2.' with a Desfazer that runs once and closes the toast", () => {
    const h = mount();
    const undo = vi.fn();
    h.notifySaved(2, undo);
    const region = $(".loc-toasts");
    expect(region.getAttribute("role")).toBe("status");
    expect(region.textContent).toContain("Tri! Salvo no slot 2.");
    const button = region.querySelector<HTMLButtonElement>("button")!;
    expect(button.textContent).toBe("Desfazer");
    button.click();
    button.click();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(region.textContent).toBe("");
  });

  it("keeps an undo for 10 s and a plain toast for 4", () => {
    const h = mount();
    h.notifySaved(1, () => {});
    advance(ACTION_TTL_MS - 1);
    expect($(".loc-toasts").textContent).toContain("Desfazer");
    advance(1);
    expect($(".loc-toasts").textContent).toBe("");
    h.notifyLoaded(2);
    expect($(".loc-toasts").textContent).toBe("Carregado o slot 2.");
    advance(DEFAULT_TTL_MS - 1);
    expect($(".loc-toasts").textContent).toBe("Carregado o slot 2.");
    advance(1);
    expect($(".loc-toasts").textContent).toBe("");
  });

  it("one at a time: a new toast replaces the old one and its timer", () => {
    const h = mount();
    h.notifySaved(1, () => {});
    advance(3000);
    h.notifyLoaded(1);
    expect($(".loc-toasts").querySelectorAll(".loc-toast")).toHaveLength(1);
    advance(DEFAULT_TTL_MS - 1);
    expect($(".loc-toasts").textContent).toBe("Carregado o slot 1.");
    advance(1);
    expect($(".loc-toasts").textContent).toBe("");
  });

  it("waits while the pointer is on it or focus is inside it", () => {
    const h = mount();
    h.notifySaved(1, () => {});
    const toast = $(".loc-toast");
    fire(toast, "pointerenter");
    advance(60_000);
    expect($(".loc-toasts").textContent).toContain("Desfazer");
    fire(toast, "pointerleave");
    advance(1499);
    expect($(".loc-toasts").textContent).toContain("Desfazer");
    advance(1);
    expect($(".loc-toasts").textContent).toBe("");
  });

  it("is a live region that exists before the first toast", () => {
    mount();
    expect($(".loc-toasts")).not.toBeNull();
    expect($(".loc-toasts").getAttribute("aria-live")).toBe("polite");
  });
});

describe("teardown", () => {
  it("removes its DOM and its listeners", () => {
    const h = mount();
    h.destroy();
    hud = null;
    expect(host.querySelector(".loc-hud")).toBeNull();
    expect(host.querySelector(".loc-pause")).toBeNull();
    expect(host.querySelector(".loc-toasts")).toBeNull();
    expect(host.dataset.hud).toBeUndefined();
    tap("KeyP");
    expect(runtime.pause).not.toHaveBeenCalled();
    advance(IDLE_MS * 2);
  });
});

describe("pure helpers", () => {
  it("formats play time", () => {
    expect(formatPlayTime(0)).toBe("0 min");
    expect(formatPlayTime(59)).toBe("0 min");
    expect(formatPlayTime(12 * 60)).toBe("12 min");
    expect(formatPlayTime(59 * 60 + 59)).toBe("59 min");
    expect(formatPlayTime(3600)).toBe("1h00");
    expect(formatPlayTime(72 * 60)).toBe("1h12");
    expect(formatPlayTime(-5)).toBe("0 min");
  });

  it("steps through the slots and wraps", () => {
    expect(stepSlot(1, 1)).toBe(2);
    expect(stepSlot(4, 1)).toBe(1);
    expect(stepSlot(1, -1)).toBe(4);
    expect(stepSlot(3, -1)).toBe(2);
  });
});

describe("motion", () => {
  const css = hudCss();

  it("honours both reduced-motion signals", () => {
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain(':root[data-reduced-motion="true"]');
    // the fade is instant under both
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.loc-hud,[^}]*transition:\s*none/);
    expect(css).toMatch(/data-reduced-motion="true"\] \.loc-hud,[^}]*transition:\s*none/s);
  });
});

describe("the keyboard's way into the HUD (SPEC 8)", () => {
  let focusGame: Mock<() => void>;
  let swallowed: Mock<(event: KeyboardEvent) => void>;

  /** What EmulatorJS does: every key on the game's element is the game's, and cancelled (Tab included). */
  function emulatorTakesKeys() {
    swallowed = vi.fn((event: KeyboardEvent) => event.preventDefault());
    document.getElementById("game")!.addEventListener("keydown", swallowed);
  }

  function mountKeyboard() {
    focusGame = vi.fn<() => void>();
    emulatorTakesKeys();
    return mount({ game: document.getElementById("game")!, focusGame });
  }

  const canvas = () => document.querySelector("#game canvas") as HTMLCanvasElement;
  const barButtons = () => [...host.querySelectorAll<HTMLButtonElement>(".loc-hud-bar button")].filter((node) => !node.closest("[hidden]"));

  it("Tab on the game goes to the first button of the bar, and the emulator never gets it", () => {
    mountKeyboard();
    canvas().focus();
    advance(IDLE_MS);
    expect(state()).toBe("hidden");
    const event = press("Tab", {}, "keydown", canvas());
    expect(event.defaultPrevented).toBe(true);
    expect(swallowed).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(action("pause"));
    expect(state()).toBe("visible");
  });

  it("Shift+Tab on the game goes to the last one, Ejetar", () => {
    mountKeyboard();
    canvas().focus();
    press("Tab", { shiftKey: true }, "keydown", canvas());
    expect(document.activeElement).toBe(action("eject"));
  });

  it("walks the bar in the browser's own order and hands the keyboard back at either end", () => {
    mountKeyboard();
    const order = [...host.querySelectorAll<HTMLButtonElement>(".loc-hud button")].filter((node) => !node.closest("[hidden]") && node.tabIndex >= 0);
    const first = order[0]!;
    const last = order[order.length - 1]!;
    // in the middle nothing is cancelled: the browser moves the focus
    action("save").focus();
    expect(press("Tab", {}, "keydown", action("save")).defaultPrevented).toBe(false);
    expect(focusGame).not.toHaveBeenCalled();
    // past the last button: back to the game
    last.focus();
    expect(press("Tab", {}, "keydown", last).defaultPrevented).toBe(true);
    expect(focusGame).toHaveBeenCalledTimes(1);
    // before the first one (Shift+Tab): the same
    first.focus();
    expect(press("Tab", { shiftKey: true }, "keydown", first).defaultPrevented).toBe(true);
    expect(focusGame).toHaveBeenCalledTimes(2);
    expect(order).toContain(action("eject"));
    expect(barButtons().at(-1)).toBe(action("eject"));
  });

  it("Escape inside the HUD puts the keyboard back on the game, but a menu's own Escape only closes the menu", () => {
    mountKeyboard();
    action("save").focus();
    press("Escape", {}, "keydown", action("save"));
    expect(focusGame).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(action("save"));

    action("screen").click();
    const open = document.activeElement as HTMLElement;
    expect(open.closest(".loc-menu")).not.toBeNull();
    press("Escape", {}, "keydown", open);
    expect(focusGame).toHaveBeenCalledTimes(1);
  });

  it("leaves a text field's Tab alone, and does nothing while the stage is not on screen", () => {
    const h = mountKeyboard();
    const field = document.getElementById("field") as HTMLInputElement;
    field.focus();
    expect(press("Tab", {}, "keydown", field).defaultPrevented).toBe(false);
    swallowed.mockClear();
    h.setActive(false);
    canvas().focus();
    press("Tab", {}, "keydown", canvas());
    // the HUD stood aside: the key went on to the game, and the focus did not move
    expect(swallowed).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(canvas());
  });

  it("F8 ejects, and Ejetar says so on the button and in its name", () => {
    mountKeyboard();
    tap("F8");
    expect(actions).toEqual([["eject", 1]]);
    expect(action("eject").getAttribute("aria-label")).toContain("F8");
    expect(action("eject").querySelector("kbd")?.textContent).toBe("F8");
  });
});

describe("the short bar (SPEC 13)", () => {
  /** jsdom has no layout: say how wide the stage is and how wide the whole bar wants to be. */
  function lay(stageWidth: number, barWants = 765) {
    Object.defineProperty(host, "clientWidth", { configurable: true, get: () => stageWidth });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("loc-hud-bar") ? barWants : 0;
    });
  }
  const bar = () => $(".loc-hud-bar");
  const direct = () => [...bar().children].map((n) => (n as HTMLElement).dataset.action ?? (n as HTMLElement).className);

  it("keeps the whole bar when it fits, and has no 'Mais' showing", () => {
    lay(1200);
    mount();
    expect(bar().dataset.compact).toBeUndefined();
    expect($(".loc-hb-more").hidden).toBe(true);
    expect(action("screen").closest(".loc-more-menu")).toBeNull();
  });

  it("collapses to Pausar, Salvar, Carregar, Turbo, Mais and Ejetar when it would scroll", () => {
    lay(512);
    mount();
    expect(bar().dataset.compact).toBe("true");
    expect(direct().filter((x) => !x.includes("loc-hud-sep"))).toEqual(["pause", "save", "load", "turbo", "loc-hb-more", "eject"]);
    expect($(".loc-hb-more").hidden).toBe(false);
    const inMenu = [...$(".loc-more-menu").querySelectorAll("button")].map((b) => b.dataset.action ?? b.className);
    expect(inMenu).toEqual(["slot-prev", "slot-next", "saves", "turbo-speed", "screen", "controls", "sound", "fullscreen"]);
  });

  it("does not scroll: the collapsed bar asks for no hidden horizontal scroll", () => {
    lay(320);
    mount();
    expect(hudCss()).toMatch(/\.loc-hud-bar\[data-compact="true"\]\s*\{\s*overflow: visible/);
  });

  it("names 'Mais' and opens it as a disclosure that the keyboard can reach and leave", () => {
    lay(512);
    mount();
    const more = action("more");
    expect(more.getAttribute("aria-label")).toBe("Mais opções do jogo");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(more.getAttribute("aria-controls")).toBe($(".loc-more-menu").id);
    more.focus();
    more.click();
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect($(".loc-more-menu").hidden).toBe(false);
    // focus goes in, Escape comes back to "Mais" and the page's own Escape does not also run
    expect($(".loc-more-menu").contains(document.activeElement)).toBe(true);
    const escape = press("Escape", { key: "Escape" }, "keydown", document.activeElement!);
    expect(escape.defaultPrevented).toBe(true);
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(more);
  });

  it("holds the HUD up while it is open, and a press on a button in it does that button's work", () => {
    lay(512);
    mount();
    action("more").click();
    advance(IDLE_MS * 3);
    expect(state()).toBe("visible");
    action("saves").click();
    expect(actions.at(-1)?.[0]).toBe("saves");
    expect($(".loc-more-menu").hidden).toBe(true);
  });

  it("keeps the slot picker open for another step", () => {
    lay(512);
    const h = mount();
    action("more").click();
    action("slot-next").click();
    expect(h.slot).toBe(2);
    expect($(".loc-more-menu").hidden).toBe(false);
  });

  it("hands the Tela menu to 'Mais', which stays on the bar, and anchors it there", () => {
    lay(512);
    const h = mount();
    action("more").click();
    action("screen").click();
    expect(h.screenMenu.isOpen).toBe(true);
    expect($(".loc-more-menu").hidden).toBe(true);
    // placed by the button, not in the fixed top right corner
    expect(h.screenMenu.element.style.bottom).not.toBe("");
    expect(h.screenMenu.element.style.top).toBe("auto");
    h.screenMenu.close();
    expect(document.activeElement).toBe(action("more"));
  });

  it("puts the turbo menu at the Turbo button and the screen menu below the pill when that opens it", () => {
    lay(1200);
    const h = mount();
    fire(action("turbo"), "contextmenu");
    expect($(".loc-turbo-menu").style.bottom).not.toBe("");
    $(".loc-turbo-menu").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    action("screen-pill").click();
    expect(h.screenMenu.isOpen).toBe(true);
    expect(h.screenMenu.element.style.top).not.toBe("auto");
    expect(h.screenMenu.element.style.bottom).toBe("auto");
  });

  it("goes back to the whole bar when the room is there again", () => {
    lay(512);
    const h = mount();
    expect(bar().dataset.compact).toBe("true");
    lay(1200);
    h.setFullscreen(true);
    expect(bar().dataset.compact).toBe("false");
    expect(action("screen").closest(".loc-more-menu")).toBeNull();
    expect($(".loc-hb-more").hidden).toBe(true);
  });

  it("leaves labels off only below 340 px, keeping every name as an accessible one", () => {
    expect(hudCss()).toMatch(/@container hud \(max-width: 339px\)[\s\S]*?\.loc-hb-label,[\s\S]*?display: none/);
    lay(300);
    mount();
    for (const name of ["pause", "save", "load", "turbo", "more", "eject"]) expect(action(name).getAttribute("aria-label")).toBeTruthy();
  });
});

describe("the pill says the real factor", () => {
  const fake = (layout: Record<string, unknown>) =>
    ({
      settings: { scale: null, aspect: "square", crt: false, ambient: false, bezel: false },
      layout: { system: "nes", baseW: 256, baseH: 240, ...layout },
      update: vi.fn(),
      onChange: vi.fn(),
      setFullscreen: vi.fn(),
    }) as unknown as Stage;

  it("counts pixel perfect in whole device pixels (7x on a 2x screen, never 3.5x)", () => {
    mount({ stage: fake({ width: 896, height: 840, applied: "pixel", scale: 7, cssScale: 3.5, integerScale: 7, scaleMode: "pixel" }), locale: "pt-BR" });
    expect($(".loc-pill-screen").textContent).toBe("Pixel perfeito · 7x");
  });

  it("writes the fitted scale with the language's decimal mark", () => {
    const layout = { width: 973, height: 852, applied: "fit", scale: 3.8, cssScale: 3.8, integerScale: 3, scaleMode: "fit" };
    mount({ stage: fake(layout), locale: "pt-BR" });
    expect($(".loc-pill-screen").textContent).toBe("Encaixar · 3,8x");
    hud?.destroy();
    document.body.innerHTML = '<div id="stage"><div id="game"></div></div>';
    host = document.getElementById("stage")!;
    mount({ stage: fake(layout), locale: "en" });
    expect($(".loc-pill-screen").textContent).toBe("Encaixar · 3.8x");
  });

  it("says the same in the screen menu's hint", () => {
    const h = mount({ stage: fake({ width: 1, height: 1, applied: "fit", scale: 3.8, cssScale: 3.8, integerScale: 7, scaleMode: "fit" }), locale: "pt-BR" });
    h.screenMenu.open();
    expect(h.screenMenu.element.textContent).toContain("Maior múltiplo inteiro que cabe: 7x");
  });
});

describe("the keyboard and the short bar together", () => {
  let focusGame: Mock<() => void>;
  const canvas = () => document.querySelector("#game canvas") as HTMLCanvasElement;

  function mountShort() {
    Object.defineProperty(host, "clientWidth", { configurable: true, get: () => 512 });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("loc-hud-bar") ? 765 : 0;
    });
    focusGame = vi.fn<() => void>();
    document.getElementById("game")!.addEventListener("keydown", (event) => event.preventDefault());
    mount({ game: document.getElementById("game")!, focusGame });
    expect($(".loc-hud-bar").dataset.compact).toBe("true");
  }

  it("Tab from the game lands on Pausar, Shift+Tab on Ejetar, with 'Mais' between", () => {
    mountShort();
    canvas().focus();
    expect(press("Tab", {}, "keydown", canvas()).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(action("pause"));
    canvas().focus();
    press("Tab", { shiftKey: true }, "keydown", canvas());
    expect(document.activeElement).toBe(action("eject"));
  });

  it("with 'Mais' closed its items are not in the Tab order, and 'Mais' is", () => {
    mountShort();
    const order = [...$(".loc-hud-bar").querySelectorAll<HTMLButtonElement>("button")].filter((node) => !node.closest("[hidden]") && node.tabIndex >= 0);
    expect(order.map((b) => b.dataset.action)).toEqual(["pause", "save", "load", "turbo", "more", "eject"]);
    // Tab on 'Mais' is the browser's: it goes on to Ejetar
    action("more").focus();
    expect(press("Tab", {}, "keydown", action("more")).defaultPrevented).toBe(false);
  });

  it("opened, 'Mais' puts its items in the Tab order between itself and Ejetar, and Ejetar still hands back to the game", () => {
    mountShort();
    action("more").focus();
    action("more").click();
    const inMenu = [...$(".loc-more-menu").querySelectorAll<HTMLButtonElement>("button")];
    expect(inMenu.length).toBeGreaterThan(0);
    // the focus went into the menu, and Tab from its last item is the browser's, towards Ejetar
    expect($(".loc-more-menu").contains(document.activeElement)).toBe(true);
    const last = inMenu[inMenu.length - 1]!;
    last.focus();
    expect(press("Tab", {}, "keydown", last).defaultPrevented).toBe(false);
    expect(focusGame).not.toHaveBeenCalled();
    // Shift+Tab from the first item is 'Mais' itself
    expect(press("Tab", { shiftKey: true }, "keydown", inMenu[0]!).defaultPrevented).toBe(false);
    // and past Ejetar it is the game again
    action("eject").focus();
    expect(press("Tab", {}, "keydown", action("eject")).defaultPrevented).toBe(true);
    expect(focusGame).toHaveBeenCalledTimes(1);
  });

  it("Escape closes 'Mais' onto its button, and F8 still ejects", () => {
    mountShort();
    action("more").click();
    press("Escape", { key: "Escape" }, "keydown", document.activeElement!);
    expect(action("more").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(action("more"));
    tap("F8");
    expect(actions).toEqual([["eject", 1]]);
  });
});
