// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EjsRuntime } from "./emulator";
import { createGameSession, type GameInput, type GameSession, type SessionContext } from "./game-session";
import { STRINGS } from "./i18n";
import { metaKey, type LibraryItem } from "./library";
import { createPrefsKeeper, defaultPrefs } from "./prefs";
import type { SavesEvent } from "./saves";
import { createScreens } from "./screen";
import { createStage } from "./stage";
import { memoryStore, type DeviceStore } from "./store";
import type { ConflictChoice, GameSync, PrepareResult, SyncAccount, SyncConflict } from "./sync";

/**
 * SAVES NA CONTA in the game session: the account is asked before the battery
 * save goes in, a battery save changed on both sides is asked on the load
 * overlay before the game boots, the "Tu parou no computador" moment takes the
 * Start's place and its "Bora" is still the click that starts the audio, the
 * saves' events reach the sync, Ejetar waits for the upload, and without an
 * account nothing of it exists. The sync itself is a script here (its own
 * tests are `sync.test.ts`).
 */

const t = STRINGS["pt-BR"];
const SHA = "c".repeat(64);
const item: LibraryItem = {
  sha256: SHA,
  platform: "gba",
  ext: ".gba",
  bytes: 1024,
  headerTitle: "",
  userTitle: "Fita",
  addedAt: 1,
  lastPlayedAt: 0,
  playSeconds: 0,
  artSeed: 1,
  hasSram: false,
  slots: [],
  hasFile: true,
};
const input: GameInput = {
  item,
  rom: new ArrayBuffer(8),
  core: "mgba",
  ext: ".gba",
  coreData: new ArrayBuffer(8),
  report: new ArrayBuffer(8),
  askName: false,
};

function fakeConsole(order: string[]) {
  const fake = {
    options: null as Parameters<EjsRuntime["start"]>[0] | null,
    resolveStart: () => {},
    begun: 0,
    loaded: 0,
    async start(options: Parameters<EjsRuntime["start"]>[0]) {
      fake.options = options;
      return new Promise<void>((resolve) => {
        fake.resolveStart = resolve;
      });
    },
    begin() {
      fake.begun += 1;
      order.push("begin");
      fake.options?.onStart?.();
      return true;
    },
    failed: () => false,
    frames: () => 5,
    stop() {},
    pause() {},
    async getState() {
      return new Uint8Array([1, 2, 3]);
    },
    async getStateRecord() {
      return { core: "mgba" as const, coreVersion: "4.2.3", data: new Uint8Array([1, 2, 3]) };
    },
    stateInfo: () => ({ core: "mgba" as const, coreVersion: "4.2.3" }),
    async loadState() {
      fake.loaded += 1;
      order.push("loadState");
    },
    async screenshot() {
      return new Blob([new Uint8Array([9])], { type: "image/png" });
    },
    async readSram() {
      return null;
    },
    async writeSram() {
      order.push("writeSram");
    },
    setTurbo() {},
    videoSize: () => ({ width: 240, height: 160 }),
    setKeyboard() {},
    setKeymap() {},
    setMuted() {},
  };
  return fake;
}

function fakeSync(prepared: Partial<PrepareResult>) {
  const events: SavesEvent[] = [];
  const resolved: ConflictChoice[] = [];
  let flushed = 0;
  const conflictListeners: Array<(conflict: SyncConflict) => void> = [];
  const game: GameSync = {
    status: "idle",
    async prepare() {
      order.push("prepare");
      return { sramConflict: null, continueOffer: null, conflicts: [], ...prepared };
    },
    onSavesEvent: (event) => void events.push(event),
    push: async () => null,
    async resolve(_conflict, choice) {
      order.push(`resolve:${choice}`);
      resolved.push(choice);
    },
    async acceptContinue() {
      order.push("acceptContinue");
      // what the real one does: the account's autosave becomes this device's
      await currentStore.put(`state:${SHA}:auto`, new Uint8Array([7, 7]), { core: "mgba", coreVersion: "4.2.3", savedAt: 5, enc: "raw" });
    },
    async declineContinue() {
      order.push("declineContinue");
    },
    async flush() {
      flushed += 1;
      order.push("flush");
    },
    dispose() {},
    onConflict: (listener) => {
      conflictListeners.push(listener);
      return () => {};
    },
    onChange: () => () => {},
  };
  const account: SyncAccount = {
    mode: "on",
    device: "phone",
    usage: { used: 10, cap: 100 },
    refresh: async () => {},
    clearAll: async () => {},
    forGame: () => game,
    onChange: () => () => {},
  };
  return { account, events, resolved, flushed: () => flushed, conflictListeners };
}

let session: GameSession;
let host: HTMLElement;
let consoles: Array<ReturnType<typeof fakeConsole>>;
let order: string[];
let currentStore: DeviceStore;

async function setup(sync: SyncAccount | null) {
  const store: DeviceStore = memoryStore();
  currentStore = store;
  await store.put(metaKey(SHA), new Uint8Array([1]), { sha256: SHA });
  // a battery save on this device, so restoring it is a step the order can see
  await store.put(`sram:${SHA}`, new Uint8Array([4, 4]), { savedAt: 1 });
  document.body.innerHTML = '<main><section id="v-play"><div id="stage"><div id="game" tabindex="-1"></div></div></section></main>';
  host = document.getElementById("stage")!;
  const stage = createStage({ stage: host, game: document.getElementById("game")! });
  consoles = [];
  order = [];
  const context: SessionContext = {
    app: { hello: { locale: "pt-BR" } } as SessionContext["app"],
    t,
    locale: "pt-BR",
    language: "pt-BR",
    accent: undefined,
    store,
    prefs: createPrefsKeeper(store, defaultPrefs(), 10),
    stage,
    screens: createScreens("balcao"),
    elements: { play: document.getElementById("v-play")!, stage: host, game: document.getElementById("game")! },
    isFullscreen: () => false,
    toggleFullscreen: async () => {},
    openControls: () => {},
    onLeave: () => {},
    sync,
    createRuntime: () => {
      const next = fakeConsole(order);
      consoles.push(next);
      return next as unknown as EjsRuntime;
    },
  };
  session = createGameSession(context);
}

const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const conflict = (slot: SyncConflict["slot"]): SyncConflict => ({
  slot,
  local: { savedAt: 1, device: "phone", thumb: null },
  remote: { savedAt: 2, device: "computer", thumb: null, bytes: new Uint8Array([1]), entry: {} as SyncConflict["remote"]["entry"] },
  freeSlot: slot === 2 ? 3 : null,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal("CompressionStream", undefined);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the game session with Saves na conta", () => {
  it("asks the account before the battery save goes in", async () => {
    const sync = fakeSync({});
    await setup(sync.account);
    void session.start(input);
    consoles[0]!.resolveStart();
    await settle(0);
    expect(order.indexOf("prepare")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("prepare")).toBeLessThan(order.indexOf("writeSram"));
  });

  it("a battery save changed on both sides is asked on the load overlay, before it is written into the console", async () => {
    const sync = fakeSync({ sramConflict: conflict("sram") });
    await setup(sync.account);
    void session.start(input);
    consoles[0]!.resolveStart();
    await settle(0);
    const sheet = host.querySelector(".loc-load .loc-conflict");
    expect(sheet).not.toBeNull();
    expect(sheet!.querySelector(".loc-conflict-title")!.textContent).toBe(t["sync.conflictSram"]);
    expect(order).not.toContain("writeSram");
    expect(host.querySelector(".loc-start")).toBeNull();
    sheet!.querySelector<HTMLButtonElement>('[data-choice="remote"]')!.click();
    await settle(0);
    expect(order.slice(-2)).toEqual(["resolve:remote", "writeSram"]);
    expect(host.querySelector(".loc-start")).not.toBeNull();
  });

  it("'Tu parou no computador' takes the Start's place; Bora starts the console in the same click and loads the account's autosave", async () => {
    const sync = fakeSync({ continueOffer: { remote: { savedAt: Date.now() - 20 * 60_000, device: "computer", thumb: null }, local: null } });
    await setup(sync.account);
    void session.start(input);
    consoles[0]!.resolveStart();
    await settle(0);
    expect(host.querySelector(".loc-load-ask")!.textContent).toBe("Tu parou no computador há 20 min. Bora continuar daqui?");
    host.querySelector<HTMLButtonElement>('[data-choice="remote"]')!.click();
    // the console began inside the click, before anything was awaited
    expect(consoles[0]!.begun).toBe(1);
    await settle(1000);
    expect(order.indexOf("acceptContinue")).toBeGreaterThan(order.indexOf("begin"));
    expect(order.indexOf("loadState")).toBeGreaterThan(order.indexOf("acceptContinue"));
  });

  it("asks even after 'Continuar' on the shelf, and 'Começar do zero' is then a fresh start", async () => {
    const sync = fakeSync({ continueOffer: { remote: { savedAt: 2, device: "phone", thumb: null }, local: { savedAt: 1, thumb: null } } });
    await setup(sync.account);
    void session.start(input, { continueAuto: true });
    consoles[0]!.resolveStart();
    await settle(0);
    expect(host.querySelector('[data-sync="continue"]')).not.toBeNull();
    expect(host.querySelector('[data-choice="continue"]')!.textContent).toBe(t["sync.keepLocal"]);
    host.querySelector<HTMLButtonElement>('[data-choice="fresh"]')!.click();
    await settle(1000);
    expect(consoles[0]!.loaded).toBe(0);
    expect(order).toContain("declineContinue");
  });

  it("starting from zero instead keeps this device's, and the account's is overwritten later", async () => {
    const sync = fakeSync({ continueOffer: { remote: { savedAt: 2, device: "computer", thumb: null }, local: null } });
    await setup(sync.account);
    void session.start(input);
    consoles[0]!.resolveStart();
    await settle(0);
    host.querySelector<HTMLButtonElement>('[data-choice="fresh"]')!.click();
    await settle(1000);
    expect(order).toContain("declineContinue");
    expect(order).not.toContain("acceptContinue");
    expect(consoles[0]!.loaded).toBe(0);
  });

  it("hands every saves event to the sync, asks a slot's conflict over the game, and Ejetar waits for the upload", async () => {
    const sync = fakeSync({ conflicts: [conflict(2)] });
    await setup(sync.account);
    void session.start(input);
    consoles[0]!.resolveStart();
    await settle(0);
    host.querySelector<HTMLButtonElement>(".loc-start")!.click();
    await settle(600);
    // the conflict found at boot is asked once the game is up, with "Guardar os dois" (slot 3 is free)
    const sheet = host.querySelector<HTMLElement>(":scope > .loc-conflict");
    expect(sheet).not.toBeNull();
    sheet!.querySelector<HTMLButtonElement>('[data-choice="both"]')!.click();
    await settle(0);
    expect(sync.resolved).toEqual(["both"]);
    expect(host.querySelector(".loc-conflict")).toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { code: "F2", key: "F2", bubbles: true, cancelable: true }));
    await settle(50);
    expect(sync.events.map((event) => event.type)).toContain("slot-saved");

    void session.eject();
    await settle(200);
    expect(sync.flushed()).toBe(1);
  });

  it("without an account there is no prompt, no sheet and no chip", async () => {
    await setup(null);
    void session.start(input);
    consoles[0]!.resolveStart();
    await settle(0);
    expect(host.querySelector(".loc-conflict")).toBeNull();
    expect(host.querySelector('[data-sync="continue"]')).toBeNull();
    host.querySelector<HTMLButtonElement>(".loc-start")!.click();
    await settle(600);
    expect(document.querySelector(".loc-slots-chip")).toBeNull();
  });
});
