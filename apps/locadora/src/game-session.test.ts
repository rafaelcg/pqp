// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EjsRuntime } from "./emulator";
import {
  createGameSession,
  FRAME_CHECK_MS,
  FRAME_CHECK_TRIES,
  READY_TIMEOUT_MS,
  START_TIMEOUT_MS,
  type GameInput,
  type GameSession,
  type LeaveReason,
  type SessionContext,
} from "./game-session";
import { STRINGS } from "./i18n";
import { metaKey, type LibraryItem } from "./library";
import { createPrefsKeeper, defaultPrefs, PREFS_KEY } from "./prefs";
import { createScreens } from "./screen";
import { createStage, type Stage } from "./stage";
import { memoryStore, type DeviceStore } from "./store";

const t = STRINGS["pt-BR"];
const SHA = "b".repeat(64);

const item: LibraryItem = {
  sha256: SHA,
  platform: "nes",
  ext: ".nes",
  bytes: 24_592,
  headerTitle: "",
  userTitle: "Fita sem nome 1",
  addedAt: 1,
  lastPlayedAt: 0,
  playSeconds: 0,
  artSeed: 1,
  hasSram: false,
  slots: [],
  hasFile: true,
};

const input = (over: Partial<GameInput> = {}): GameInput => ({
  item,
  rom: new ArrayBuffer(8),
  core: "fceumm",
  ext: ".nes",
  coreData: new ArrayBuffer(8),
  report: new ArrayBuffer(8),
  askName: false,
  ...over,
});

/** A console that is only a script: the test says when it is ready, started, failed, and how many frames it ran. */
function fakeConsole() {
  const fake = {
    options: null as Parameters<EjsRuntime["start"]>[0] | null,
    resolveStart: () => {},
    rejectStart: (_e: Error) => {},
    beginResult: true,
    beginStarts: true,
    failedFlag: false,
    frameCount: 5 as number | null,
    stopped: 0,
    begun: 0,
    sram: null as Uint8Array | null,
    keyboard: [] as boolean[],
    async start(options: Parameters<EjsRuntime["start"]>[0]) {
      fake.options = options;
      return new Promise<void>((resolve, reject) => {
        fake.resolveStart = resolve;
        fake.rejectStart = reject;
      });
    },
    begin() {
      fake.begun += 1;
      if (fake.beginResult && fake.beginStarts) fake.options?.onStart?.();
      return fake.beginResult;
    },
    failed: () => fake.failedFlag,
    frames: () => fake.frameCount,
    stop() {
      fake.stopped += 1;
    },
    pause() {},
    async getState() {
      return new Uint8Array([1, 2, 3, 4]);
    },
    async getStateRecord() {
      return { core: "fceumm" as const, coreVersion: "4.2.3", data: new Uint8Array([1, 2, 3, 4]) };
    },
    stateInfo: () => ({ core: "fceumm" as const, coreVersion: "4.2.3" }),
    async loadState() {},
    async screenshot() {
      return new Blob([new Uint8Array([9])], { type: "image/png" });
    },
    async readSram() {
      return fake.sram;
    },
    async writeSram() {},
    turbos: [] as number[],
    setTurbo(turbo: number) {
      fake.turbos.push(turbo);
    },
    size: { width: 256, height: 240 },
    videoSize: () => fake.size,
    setKeyboard(on: boolean) {
      fake.keyboard.push(on);
    },
    setKeymap() {},
    setMuted() {},
  };
  return fake;
}

let host: HTMLElement;
let stage: Stage;
let consoles: Array<ReturnType<typeof fakeConsole>>;
let left: LeaveReason[];
let session: GameSession;
let store: DeviceStore;
let keeper: ReturnType<typeof createPrefsKeeper>;

async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}

function setup(over: { store?: DeviceStore; prefs?: Partial<ReturnType<typeof defaultPrefs>> } = {}) {
  store = over.store ?? memoryStore();
  keeper = createPrefsKeeper(store, { ...defaultPrefs(), ...over.prefs }, 10);
  document.body.innerHTML =
    '<main><section id="v-play"><div id="stage"><div id="game" tabindex="-1"></div></div></section></main>';
  host = document.getElementById("stage")!;
  stage = createStage({ stage: host, game: document.getElementById("game")! });
  consoles = [];
  left = [];
  const context: SessionContext = {
    app: { hello: { locale: "pt-BR" } } as SessionContext["app"],
    t,
    locale: "pt-BR",
    language: "pt-BR",
    accent: undefined,
    store,
    prefs: keeper,
    stage,
    screens: createScreens("balcao"),
    elements: { play: document.getElementById("v-play")!, stage: host, game: document.getElementById("game")! },
    isFullscreen: () => false,
    toggleFullscreen: async () => {},
    openControls: () => {},
    onLeave: (reason) => {
      left.push(reason);
    },
    createRuntime: () => {
      const next = fakeConsole();
      consoles.push(next);
      return next as unknown as EjsRuntime;
    },
  };
  session = createGameSession(context);
  return session;
}

const errorText = () => host.querySelector<HTMLElement>(".loc-load-error")?.textContent ?? null;
const errorButtons = () => [...host.querySelectorAll<HTMLButtonElement>(".loc-load-actions button")].map((b) => b.textContent);
const hudUp = () => host.querySelector(".loc-hud") !== null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  // jsdom has no stream plumbing: states are stored as they are
  vi.stubGlobal("CompressionStream", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Boots the console and presses Start, the way a person does. */
async function boot(over: Partial<GameInput> = {}) {
  setup();
  void session.start(input(over));
  const console_ = consoles[0]!;
  console_.resolveStart();
  await settle(0);
  return console_;
}

const pressStart = () => host.querySelector<HTMLButtonElement>(".loc-start")!.click();

describe("the stage follows the core's frame size all game long, never the first answer", () => {
  // jsdom lays nothing out: give the stage a room, or its layout is never computed
  function room() {
    Object.defineProperty(host, "clientWidth", { configurable: true, get: () => 1280 });
    Object.defineProperty(host, "clientHeight", { configurable: true, get: () => 800 });
  }

  it("lays the picture out again when the core reports another size, and not when it reports the same one", async () => {
    const console_ = await boot();
    room();
    pressStart();
    await settle(600);
    expect(stage.layout?.baseW).toBe(256);
    expect(stage.layout?.baseH).toBe(240);
    const setBase = vi.spyOn(stage, "setBase");
    await settle(2000);
    // the same answer every half second: asked each time, and the layout is left alone
    expect(setBase).toHaveBeenCalled();
    expect(stage.layout?.baseH).toBe(240);

    console_.size = { width: 256, height: 224 };
    await settle(600);
    expect(stage.layout?.baseW).toBe(256);
    expect(stage.layout?.baseH).toBe(224);

    console_.size = { width: 512, height: 448 };
    await settle(600);
    expect(stage.layout?.baseW).toBe(512);
    expect(stage.layout?.baseH).toBe(448);

    // and back, which a game that goes between two modes does all the time
    console_.size = { width: 256, height: 239 };
    await settle(600);
    expect(stage.layout?.baseW).toBe(256);
    expect(stage.layout?.baseH).toBe(239);
  });

  it("asks at once when the canvas's own size changes, not on the next half second", async () => {
    setup();
    room();
    const canvas = document.createElement("canvas");
    canvas.className = "ejs_canvas";
    document.getElementById("game")!.append(canvas);
    void session.start(input());
    const console_ = consoles[0]!;
    console_.resolveStart();
    await settle(0);
    pressStart();
    await settle(0);
    console_.size = { width: 256, height: 224 };
    canvas.setAttribute("width", "640");
    // one turn of the microtask queue, far under the half second
    await settle(1);
    expect(stage.layout?.baseH).toBe(224);
  });

  it("stops when the game is put away: no read of a console that is gone", async () => {
    const console_ = await boot();
    pressStart();
    await settle(0);
    let reads = 0;
    console_.videoSize = () => {
      reads += 1;
      return { width: 256, height: 240 };
    };
    await settle(600);
    expect(reads).toBeGreaterThan(0);
    await session.eject();
    await settle(0);
    const before = reads;
    await settle(3000);
    expect(reads).toBe(before);
  });
});

describe("a file the console cannot run ends on the error screen, never on a dead one (SPEC 4.7)", () => {
  it("says so, with 'Tentar de novo' and 'Voltar pra prateleira', when the game fails the moment Start is pressed", async () => {
    const console_ = await boot();
    console_.failedFlag = true;
    console_.beginStarts = false;
    pressStart();
    expect(errorText()).toBe(t["err.core"]);
    expect(errorButtons()).toEqual([t["err.retry"], t["err.back"]]);
    // no HUD offering buttons that cannot work, and the console that did not run is put away
    expect(hudUp()).toBe(false);
    expect(console_.stopped).toBeGreaterThan(0);
  });

  it("'Tentar de novo' boots a new console, 'Voltar pra prateleira' leaves", async () => {
    const console_ = await boot();
    console_.failedFlag = true;
    console_.beginStarts = false;
    pressStart();
    host.querySelectorAll<HTMLButtonElement>(".loc-load-actions button")[0]!.click();
    expect(consoles).toHaveLength(2);
    expect(console_.stopped).toBeGreaterThan(0);
    // the second one fails too: the way back is still there
    consoles[1]!.resolveStart();
    await settle(0);
    consoles[1]!.failedFlag = true;
    consoles[1]!.beginStarts = false;
    pressStart();
    host.querySelectorAll<HTMLButtonElement>(".loc-load-actions button")[1]!.click();
    await settle(0);
    expect(left).toEqual(["back"]);
  });

  it("'Voltar pra prateleira' takes a cartridge that never ran off the shelf, but keeps one that ran before", async () => {
    for (const fresh of [true, false]) {
      const kept = memoryStore();
      await kept.put(metaKey(SHA), new Uint8Array([1]), { sha256: SHA });
      await kept.put(`rom:${SHA}`, new Uint8Array([1, 2, 3]));
      setup({ store: kept });
      void session.start(input({ isNew: fresh }));
      consoles[0]!.resolveStart();
      await settle(0);
      consoles[0]!.failedFlag = true;
      consoles[0]!.beginStarts = false;
      pressStart();
      host.querySelectorAll<HTMLButtonElement>(".loc-load-actions button")[1]!.click();
      await settle(0);
      expect((await kept.list("")).map((row) => row.key), `isNew ${fresh}`).toEqual(fresh ? [] : [metaKey(SHA), `rom:${SHA}`].sort());
      expect(left.at(-1)).toBe("back");
    }
  });

  it("hears the emulator giving up after `ready` (it announces that on its own clock)", async () => {
    const console_ = await boot();
    console_.options!.onError?.();
    expect(errorText()).toBe(t["err.core"]);
  });

  it("hears it giving up before `ready` too", async () => {
    setup();
    void session.start(input());
    consoles[0]!.rejectStart(new Error("the emulator could not start"));
    await settle(0);
    expect(errorText()).toBe(t["err.core"]);
  });

  it("does not stay on the loading screen for good when the console never says ready", async () => {
    setup();
    void session.start(input());
    await settle(READY_TIMEOUT_MS - 1);
    expect(errorText()).toBeNull();
    await settle(1);
    expect(errorText()).toBe(t["err.core"]);
  });

  it("does not wait for ever on a Start that neither starts nor fails", async () => {
    const console_ = await boot();
    console_.beginStarts = false;
    pressStart();
    expect(errorText()).toBeNull();
    await settle(START_TIMEOUT_MS);
    expect(errorText()).toBe(t["err.core"]);
  });

  it("a game that 'starts' into RetroArch's empty menu (the frame counter never moves) is the same error", async () => {
    const console_ = await boot();
    console_.frameCount = 0;
    pressStart();
    await settle(400);
    expect(hudUp()).toBe(true);
    await settle(FRAME_CHECK_MS * FRAME_CHECK_TRIES);
    expect(errorText()).toBe(t["err.core"]);
    // the HUD that had come up is taken away, and what the menu was running on is stopped
    expect(hudUp()).toBe(false);
    expect(console_.stopped).toBeGreaterThan(0);
  });

  it("a game that runs is left alone: frames moving, or a counter that cannot be read, never raise the error", async () => {
    const console_ = await boot();
    pressStart();
    await settle(FRAME_CHECK_MS * (FRAME_CHECK_TRIES + 2));
    expect(errorText()).toBeNull();
    expect(console_.stopped).toBe(0);

    // a core whose counter cannot be read at all gets the benefit of the doubt
    const other = await boot();
    other.frameCount = null;
    pressStart();
    await settle(FRAME_CHECK_MS * (FRAME_CHECK_TRIES + 2));
    expect(errorText()).toBeNull();
  });

  it("a paused game with no frame yet is not mistaken for a dead one", async () => {
    const console_ = await boot();
    pressStart();
    console_.frameCount = 0;
    // the person pauses at once (P), before the first frame was ever read
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyP", key: "p", bubbles: true, cancelable: true }));
    await settle(FRAME_CHECK_MS * (FRAME_CHECK_TRIES + 2));
    expect(errorText()).toBeNull();
  });
});

describe("a cartridge that is not on the shelf leaves nothing behind, and F2 never says Salvo for it", () => {
  async function playing(withMeta: boolean) {
    const store = memoryStore();
    if (withMeta) await store.put(metaKey(SHA), new Uint8Array([1]), { sha256: SHA });
    setup({ store });
    void session.start(input());
    consoles[0]!.resolveStart();
    await settle(0);
    pressStart();
    await settle(600);
    return store;
  }
  const toast = () => host.querySelector(".loc-hud-toasts")?.textContent ?? "";
  // the game's rows: the device's own preferences (the double click hint, once seen) are not the cartridge's
  const rows = async (s: DeviceStore) =>
    (await s.list("")).map((row) => row.key).filter((k) => !k.startsWith("meta:") && k !== PREFS_KEY);

  it("F2 says it did not fit, offers the shelf, and writes nothing", async () => {
    const store = await playing(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "F2", key: "F2", bubbles: true, cancelable: true }));
    await settle(50);
    expect(toast()).toContain(t["err.storage"]);
    expect(toast()).not.toContain("Salvo");
    expect(await rows(store)).toEqual([]);
  });

  it("Ejetar writes no battery save and no autosave for it either", async () => {
    const store = await playing(false);
    consoles[0]!.sram = new Uint8Array([1, 2, 3]);
    await settle(15_000);
    void session.eject();
    await settle(200);
    expect(await rows(store)).toEqual([]);
    expect(left).toEqual(["eject"]);
  });

  it("a cartridge that is on the shelf saves as before", async () => {
    const store = await playing(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "F2", key: "F2", bubbles: true, cancelable: true }));
    await settle(50);
    expect(toast()).toContain("Salvo");
    expect((await rows(store)).some((key) => key.startsWith("state:"))).toBe(true);
  });
});

describe("the name field while the console boots", () => {
  it("Enter commits the name and the keyboard goes on to Start", async () => {
    const store = memoryStore();
    await store.put(metaKey(SHA), new Uint8Array([1]), { ...item });
    setup({ store });
    void session.start(input({ askName: true }));
    consoles[0]!.resolveStart();
    await settle(0);
    const field = host.querySelector<HTMLInputElement>(".loc-nameprompt input")!;
    field.value = "Padrão verde";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle(0);
    expect(host.querySelector(".loc-nameprompt")).toBeNull();
    expect(document.activeElement?.classList.contains("loc-start")).toBe(true);
    expect((await store.get(metaKey(SHA)))?.meta?.userTitle).toBe("Padrão verde");
  });
});

describe("the turbo's speed is the person's own, and is kept", () => {
  async function play(prefs: { turboRatio?: number } = {}) {
    setup({ prefs });
    void session.start(input());
    consoles[0]!.resolveStart();
    await settle(0);
    pressStart();
    await settle(600);
    return consoles[0]!;
  }
  const key = (code: string, type: "keydown" | "keyup" = "keydown") =>
    document.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true }));

  it("starts the HUD at the saved ratio, and the held key runs the console at it", async () => {
    const console_ = await play({ turboRatio: 6.5 });
    key("Space");
    expect(console_.turbos).toEqual([6.5]);
    key("Space", "keyup");
    expect(console_.turbos).toEqual([6.5, 0]);
  });

  it("writes a change from the slider to the prefs row",async () => {
    await play();
    const slider = host.querySelector<HTMLInputElement>(".loc-turbo-slider")!;
    slider.value = "7.5";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    expect(keeper.prefs.turboRatio).toBe(7.5);
    await keeper.flush();
    const row = JSON.parse(new TextDecoder().decode((await store.get("prefs"))!.bytes));
    expect(row.turboRatio).toBe(7.5);
  });

  it("a bad saved ratio is the default 3x, not a broken turbo", async () => {
    const console_ = await play({ turboRatio: Number.NaN });
    key("Space");
    expect(console_.turbos).toEqual([3]);
  });
});

describe("Voltar on the load overlay: back to the shelf without playing", () => {
  const backButton = () => host.querySelector<HTMLButtonElement>(".loc-load-back");
  const escape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

  it("is there while the console boots and at Start, and stops the console without starting the game", async () => {
    setup();
    void session.start(input());
    // before `ready` the corner already offers the way back
    expect(backButton()?.textContent).toBe(t["load.back"]);
    expect(backButton()?.getAttribute("aria-label")).toBe(t["load.backAria"]);
    consoles[0]!.resolveStart();
    await settle(0);
    expect(host.querySelector(".loc-start")).not.toBeNull();
    backButton()!.click();
    await settle(0);
    expect(left).toEqual(["back"]);
    expect(consoles[0]!.begun).toBe(0);
    expect(consoles[0]!.stopped).toBeGreaterThan(0);
    expect(host.querySelector(".loc-load")).toBeNull();
    expect(hudUp()).toBe(false);
    expect(session.playing).toBe(false);
    // nothing of the old console keeps running: no clock of it fires into the stage afterwards
    await settle(START_TIMEOUT_MS + READY_TIMEOUT_MS);
    expect(host.querySelector(".loc-load")).toBeNull();
    expect(left).toEqual(["back"]);
  });

  it("works before the console is ready too, and a late `ready` changes nothing", async () => {
    setup();
    void session.start(input());
    backButton()!.click();
    await settle(0);
    expect(left).toEqual(["back"]);
    expect(consoles[0]!.stopped).toBeGreaterThan(0);
    consoles[0]!.resolveStart();
    await settle(0);
    expect(host.querySelector(".loc-load")).toBeNull();
    expect(consoles[0]!.begun).toBe(0);
  });

  it("Escape is the same Back, and writes nothing to the device", async () => {
    const kept = memoryStore();
    await kept.put(metaKey(SHA), new Uint8Array([1]), { sha256: SHA });
    await kept.put(`rom:${SHA}`, new Uint8Array([1, 2, 3]));
    await kept.put(`state:${SHA}:auto`, new Uint8Array([7, 7, 7]), { savedAt: 5 });
    const rows = async () => (await kept.list("")).map((row) => `${row.key}:${JSON.stringify(row.meta)}`);
    const before = await rows();
    setup({ store: kept });
    void session.start(input({ isNew: true }));
    consoles[0]!.resolveStart();
    await settle(0);
    escape();
    await settle(0);
    expect(left).toEqual(["back"]);
    // the cartridge stays on the shelf (a Back is not the error screen's "never ran"), the autosave is untouched
    expect(await rows()).toEqual(before);
    expect(Array.from(new Uint8Array((await kept.get(`state:${SHA}:auto`))!.bytes))).toEqual([7, 7, 7]);
  });

  it("is not on the error screen, and Escape there does not leave; once the game runs it is gone", async () => {
    const console_ = await boot();
    console_.failedFlag = true;
    console_.beginStarts = false;
    pressStart();
    expect(errorText()).toBe(t["err.core"]);
    expect(backButton()?.hidden ?? true).toBe(true);
    escape();
    await settle(0);
    expect(left).toEqual([]);

    const running = await boot();
    pressStart();
    expect(running.begun).toBe(1);
    escape();
    await settle(400);
    expect(left).toEqual([]);
    expect(session.playing).toBe(true);
  });

  it("leaves the name field's Escape to the field: it skips the name and stays", async () => {
    setup();
    void session.start(input({ askName: true }));
    consoles[0]!.resolveStart();
    await settle(0);
    const field = host.querySelector<HTMLInputElement>(".loc-nameprompt input")!;
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle(0);
    expect(left).toEqual([]);
    expect(host.querySelector(".loc-nameprompt")).toBeNull();
  });
});
