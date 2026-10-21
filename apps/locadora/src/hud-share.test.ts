// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHud, type Hud, type HudAction } from "./hud";
import { STRINGS } from "./i18n";
import { createStage, type Stage } from "./stage";

const t = STRINGS["pt-BR"];

let host: HTMLElement;
let hud: Hud | null;
let stage: Stage;
let actions: HudAction[];

function mount(): Hud {
  hud = createHud({
    host,
    t,
    runtime: { pause: vi.fn(), setTurbo: vi.fn(), setKeyboard: vi.fn() },
    stage,
    info: { title: "Cuia Quest", console: "Game Boy Advance" },
    onAction: (action) => actions.push(action),
  });
  return hud;
}

const pill = () => host.querySelector<HTMLButtonElement>('[data-action="share"]')!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  document.body.innerHTML = '<div id="stage"><div id="game"><canvas tabindex="0"></canvas></div></div>';
  host = document.getElementById("stage")!;
  stage = createStage({ stage: host, game: document.getElementById("game")! });
  actions = [];
  hud = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  hud?.destroy();
  stage.destroy();
  vi.useRealTimers();
});

describe("the share pill", () => {
  it("is not drawn until the page says sharing is offered, and goes away when it says it is not", () => {
    const h = mount();
    expect(pill().hidden).toBe(true);
    h.setShare({ on: false, busy: false });
    expect(pill().hidden).toBe(false);
    expect(pill().textContent).toBe(t.share);
    h.setShare(null);
    expect(pill().hidden).toBe(true);
  });

  it("sits in the top row with the other pills and never in the bar, so nothing lies over the bar's buttons", () => {
    const h = mount();
    h.setShare({ on: false, busy: false });
    expect(pill().closest(".loc-hud-top")).not.toBeNull();
    expect(pill().closest(".loc-hud-bar")).toBeNull();
  });

  it("asks its owner for the share, says what is on, and ignores a press while one is being asked", () => {
    const h = mount();
    h.setShare({ on: false, busy: false });
    pill().click();
    expect(actions).toEqual(["share"]);
    h.setShare({ on: false, busy: true });
    pill().click();
    expect(actions).toHaveLength(1);
    expect(pill().getAttribute("aria-disabled")).toBe("true");
    h.setShare({ on: true, busy: false });
    expect(pill().textContent).toBe(t["hud.sharingPill"]);
    expect(pill().getAttribute("aria-pressed")).toBe("true");
    expect(pill().getAttribute("aria-label")).toBe(t.shareStop);
    expect(pill().hasAttribute("aria-disabled")).toBe(false);
  });
});
