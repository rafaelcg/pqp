import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDefaultControllers,
  createEmulatorRuntime,
  DEFAULT_KEYMAP,
  ejsKeyName,
  EjsRuntime,
  sameConsole,
  SCREENSHOT_TIMEOUT_MS,
  type GameManagerLike,
  type StartOptions,
} from "./emulator";

/*
 * A fake EmulatorJS: the class `window.EmulatorJS`, an element the start pill
 * is built into, and a `gameManager` that records what it was asked. No ROM
 * bytes anywhere: the "game" is four zeros.
 */

interface FakeButton {
  style: { display?: string };
  removed: boolean;
  click: () => void;
}

interface Harness {
  gm: ReturnType<typeof fakeGameManager>;
  button: FakeButton;
  created: { selector: string; config: Record<string, unknown> }[];
  instance: () => FakeInstance;
  /** What `click()` saw: the value of `userActive` at that moment. */
  clicks: boolean[];
  setUserActive(active: boolean): void;
}

function fakeGameManager() {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const calls: string[] = [];
  const gm = {
    calls,
    files,
    dirs,
    dims: { width: 256, height: 240, aspect: 1.0667 } as Record<string, number | undefined>,
    state: new Uint8Array([1, 2, 3, 4]),
    save: new Uint8Array([9, 9]) as Uint8Array | null,
    shot: Promise.resolve(new Uint8Array([0x89, 0x50, 0x4e, 0x47])) as Promise<Uint8Array>,
    getState: vi.fn(() => gm.state),
    loadState: vi.fn((state: Uint8Array) => {
      calls.push(`loadState:${state.length}`);
    }),
    screenshot: vi.fn(() => gm.shot),
    getSaveFile: vi.fn(() => gm.save),
    getSaveFilePath: vi.fn(() => "/data/saves/rom.srm"),
    loadSaveFiles: vi.fn(() => {
      calls.push("loadSaveFiles");
    }),
    toggleFastForward: vi.fn((active: number) => {
      calls.push(`ff:${active}`);
    }),
    setFastForwardRatio: vi.fn((ratio: number) => {
      calls.push(`ratio:${ratio}`);
    }),
    toggleMainLoop: vi.fn((playing: number) => {
      calls.push(`loop:${playing}`);
    }),
    getVideoDimensions: vi.fn((type: string) => gm.dims[type]),
    setKeyboardEnabled: vi.fn((enabled: boolean) => {
      calls.push(`keyboard:${enabled}`);
    }),
    FS: {
      analyzePath: vi.fn((path: string) => ({ exists: files.has(path) || dirs.has(path) })),
      mkdir: vi.fn((path: string) => {
        dirs.add(path);
      }),
      unlink: vi.fn((path: string) => {
        files.delete(path);
      }),
      writeFile: vi.fn((path: string, data: Uint8Array) => {
        files.set(path, data);
      }),
    },
  };
  return gm satisfies GameManagerLike & Record<string, unknown>;
}

class FakeInstance {
  ejs_version = "4.2.3";
  failedToStart = false;
  gameManager?: GameManagerLike;
  paused?: boolean;
  isFastForward?: boolean;
  volume?: number;
  muted?: boolean;
  setVolume?: (volume: number) => void;
  controls?: Record<number, Record<number, { value?: number | string; value2?: string }>>;
  private listeners = new Map<string, (() => void)[]>();

  on(event: string, callback: () => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), callback]);
  }

  emit(event: string): void {
    for (const callback of this.listeners.get(event) ?? []) callback();
  }

  callEvent = vi.fn((_event: string) => 1);
}

function install(): Harness {
  const gm = fakeGameManager();
  const created: Harness["created"] = [];
  const clicks: boolean[] = [];
  let userActive = false;
  let instance!: FakeInstance;

  const button: FakeButton = {
    style: {},
    removed: false,
    click() {
      clicks.push(userActive);
      // what startButtonClicked does: take the pill away and bring the core up
      button.removed = true;
      instance.gameManager = gm;
      instance.emit("start");
    },
  };
  const container = {
    querySelector: (selector: string) => (selector === ".ejs_start_button" && !button.removed ? button : null),
    replaceChildren: vi.fn(),
  };
  vi.stubGlobal("document", {
    querySelector: (selector: string) => (selector === "#game" ? container : null),
  });

  class FakeEmulatorJS extends FakeInstance {
    constructor(selector: string, config: Record<string, unknown>) {
      super();
      created.push({ selector, config });
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      instance = this;
      // the real constructor builds the pill and, 20 ms later, says ready
      setTimeout(() => this.emit("ready"), 20);
    }
  }
  const win: Record<string, unknown> = { EmulatorJS: FakeEmulatorJS };
  vi.stubGlobal("window", win);
  return {
    gm,
    button,
    created,
    instance: () => instance,
    clicks,
    setUserActive: (active) => {
      userActive = active;
    },
  };
}

function options(extra: Partial<StartOptions> = {}): StartOptions {
  return {
    container: "#game",
    core: "fceumm",
    ext: ".nes",
    rom: new Uint8Array(4).buffer,
    coreData: new Uint8Array(4).buffer,
    report: new Uint8Array(4).buffer,
    language: "pt-BR",
    ...extra,
  };
}

let h: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("URL", { createObjectURL: () => "blob:fake" });
  h = install();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Starts the runtime and lets EmulatorJS say ready; our Start has not been pressed yet. */
async function ready(extra: Partial<StartOptions> = {}): Promise<EjsRuntime> {
  const runtime = createEmulatorRuntime();
  const started = runtime.start(options(extra));
  await vi.advanceTimersByTimeAsync(25);
  await started;
  return runtime;
}

/** Ready and pressed: the core is up and `gameManager` exists. */
async function running(extra: Partial<StartOptions> = {}): Promise<EjsRuntime> {
  const runtime = await ready(extra);
  runtime.begin();
  return runtime;
}

describe("start and our own Start", () => {
  it("builds the config with the buttons off, our start, the keymap and no storage", async () => {
    await ready();
    const { selector, config } = h.created[0]!;
    expect(selector).toBe("#game");
    expect(config.startOnLoad).toBe(false);
    expect(config.disableDatabases).toBe(true);
    expect(config.disableLocalStorage).toBe(true);
    const buttons = config.buttonOpts as Record<string, boolean>;
    expect(Object.values(buttons).every((on) => on === false)).toBe(true);
    const controllers = config.defaultControllers as ReturnType<typeof buildDefaultControllers>;
    expect(controllers[0]![8]).toEqual({ value: "z", value2: "BUTTON_1" });
  });

  it("hides EmulatorJS's pill and resolves on ready, before anything starts", async () => {
    const runtime = createEmulatorRuntime();
    let resolved = false;
    const started = runtime.start(options()).then(() => {
      resolved = true;
    });
    expect(h.button.style.display).toBe("none");
    await vi.advanceTimersByTimeAsync(5);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    await started;
    expect(resolved).toBe(true);
    expect(h.clicks).toEqual([]);
    expect(h.instance().gameManager).toBeUndefined();
  });

  it("presses the pill synchronously inside the caller's click", async () => {
    const runtime = await ready();
    const onStart = vi.fn();
    h.instance().on("start", onStart);

    // the host's click handler: the gesture is active only while it runs
    h.setUserActive(true);
    const result = runtime.begin();
    h.setUserActive(false);

    expect(result).toBe(true); // a boolean, not a promise: nothing was awaited
    expect(h.clicks).toEqual([true]); // EmulatorJS's click ran while the gesture was live
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(h.instance().gameManager).toBeDefined();
  });

  it("answers false once the pill is gone, and before anything was started", async () => {
    expect(createEmulatorRuntime().begin()).toBe(false);
    const runtime = await running();
    expect(runtime.begin()).toBe(false);
    expect(h.clicks).toHaveLength(1);
  });

  it("rejects when the frontend is not loaded", async () => {
    vi.stubGlobal("window", {});
    await expect(createEmulatorRuntime().start(options())).rejects.toThrow("not loaded");
  });

  it("tells the caller when EmulatorJS gives up after Start (start() has resolved by then)", async () => {
    const onError = vi.fn();
    const runtime = createEmulatorRuntime();
    const started = runtime.start(options({ onError }));
    await vi.advanceTimersByTimeAsync(25);
    await started;
    h.instance().failedToStart = true;
    await vi.advanceTimersByTimeAsync(600);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("stop empties the element and ends the game", async () => {
    const runtime = await running();
    const instance = h.instance();
    runtime.stop();
    expect(instance.callEvent).toHaveBeenCalledWith("exit");
    expect((window as { EJS_emulator?: unknown }).EJS_emulator).toBeUndefined();
    expect(() => runtime.pause(true)).toThrow("not running");
  });

  it("refuses everything that needs a core until the game is started", async () => {
    const runtime = await ready();
    expect(() => runtime.pause(true)).toThrow("not running");
    await expect(runtime.getState()).rejects.toThrow("not running");
    expect(runtime.videoSize()).toBeNull();
  });
});

describe("pause", () => {
  it("toggles the main loop and keeps EmulatorJS's own flag true", async () => {
    const runtime = await running();
    runtime.pause(true);
    expect(h.gm.toggleMainLoop).toHaveBeenLastCalledWith(0);
    expect(h.instance().paused).toBe(true);
    runtime.pause(false);
    expect(h.gm.toggleMainLoop).toHaveBeenLastCalledWith(1);
    expect(h.instance().paused).toBe(false);
  });
});

describe("states", () => {
  it("getState returns the core's bytes", async () => {
    const runtime = await running();
    expect(await runtime.getState()).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("records the core and its version with each state", async () => {
    const runtime = await running();
    const record = await runtime.getStateRecord();
    expect(record.core).toBe("fceumm");
    expect(record.coreVersion).toBe("4.2.3"); // the frontend's, which the cores ship in step with
    expect(record.data).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("prefers the version the caller names", async () => {
    const runtime = await running({ coreVersion: "9.9.9", core: "mgba", ext: ".gba" });
    expect(runtime.stateInfo()).toEqual({ core: "mgba", coreVersion: "9.9.9" });
  });

  it("knows a state from another console", () => {
    const a = { core: "fceumm", coreVersion: "4.2.3" } as const;
    expect(sameConsole(a, { ...a })).toBe(true);
    expect(sameConsole(a, { ...a, coreVersion: "4.3.0" })).toBe(false);
    expect(sameConsole(a, { core: "mgba", coreVersion: "4.2.3" })).toBe(false);
  });

  it("loadState hands the bytes to the core", async () => {
    const runtime = await running();
    await runtime.loadState(new Uint8Array(7));
    expect(h.gm.loadState).toHaveBeenCalledTimes(1);
    expect(h.gm.calls).toContain("loadState:7");
  });
});

describe("screenshot", () => {
  it("wraps the core's frame in a PNG blob", async () => {
    const runtime = await running();
    const blob = await runtime.screenshot();
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(4);
  });

  it("gives up when the core never writes the frame", async () => {
    const runtime = await running();
    h.gm.shot = new Promise<Uint8Array>(() => undefined);
    const shot = runtime.screenshot();
    const settled = expect(shot).rejects.toThrow("no frame");
    await vi.advanceTimersByTimeAsync(SCREENSHOT_TIMEOUT_MS + 1);
    await settled;
  });
});

describe("the game's own save", () => {
  it("reads a copy of the save file", async () => {
    const runtime = await running();
    const sram = await runtime.readSram();
    expect(sram).toEqual(new Uint8Array([9, 9]));
    expect(sram).not.toBe(h.gm.save);
  });

  it("answers null when the core has none, or an empty one", async () => {
    const runtime = await running();
    h.gm.save = null;
    expect(await runtime.readSram()).toBeNull();
    h.gm.save = new Uint8Array(0);
    expect(await runtime.readSram()).toBeNull();
  });

  it("writes through the core's save path, making the directories, and reloads", async () => {
    const runtime = await running();
    const data = new Uint8Array([5, 6, 7]);
    await runtime.writeSram(data);
    expect(h.gm.dirs).toEqual(new Set(["/data", "/data/saves"]));
    expect(h.gm.files.get("/data/saves/rom.srm")).toBe(data);
    expect(h.gm.calls.at(-1)).toBe("loadSaveFiles");
  });

  it("replaces a save that is already there", async () => {
    const runtime = await running();
    h.gm.files.set("/data/saves/rom.srm", new Uint8Array([1]));
    await runtime.writeSram(new Uint8Array([2]));
    expect(h.gm.FS.unlink).toHaveBeenCalledWith("/data/saves/rom.srm");
    expect(h.gm.files.get("/data/saves/rom.srm")).toEqual(new Uint8Array([2]));
  });
});

describe("turbo", () => {
  it("sets the ratio then turns fast forward on, and off again", async () => {
    const runtime = await running();
    runtime.setTurbo(3);
    expect(h.gm.calls).toEqual(["ratio:3", "ff:1"]);
    expect(h.instance().isFastForward).toBe(true);
    runtime.setTurbo(0);
    expect(h.gm.calls.slice(2)).toEqual(["ff:0"]);
    expect(h.instance().isFastForward).toBe(false);
  });

  it("goes from one ratio to another through off, never stacking", async () => {
    const runtime = await running();
    runtime.setTurbo(2);
    h.gm.calls.length = 0;
    runtime.setTurbo(4);
    expect(h.gm.calls).toEqual(["ff:0", "ratio:4", "ff:1"]);
  });

  it("does nothing to the core when turbo was already off", async () => {
    const runtime = await running();
    runtime.setTurbo(0);
    expect(h.gm.calls).toEqual([]);
  });

  it("hands the core a float: 4.5 is 4.5, not 4 and not 5", async () => {
    const runtime = await running();
    runtime.setTurbo(4.5);
    expect(h.gm.calls).toEqual(["ratio:4.5", "ff:1"]);
    const asked = h.gm.setFastForwardRatio.mock.calls[0]![0];
    expect(typeof asked).toBe("number");
    expect(asked).toBe(4.5);
  });

  it("changes the ratio of a running turbo live: off, then the ratio, then on, every time", async () => {
    const runtime = await running();
    runtime.setTurbo(3);
    h.gm.calls.length = 0;
    runtime.setTurbo(6.5);
    runtime.setTurbo(1.5);
    expect(h.gm.calls).toEqual(["ff:0", "ratio:6.5", "ff:1", "ff:0", "ratio:1.5", "ff:1"]);
    expect(h.instance().isFastForward).toBe(true);
  });

  it("degrades above what is ever offered: a ratio past 10 reaches the core as 10, and nonsense as normal speed", async () => {
    const runtime = await running();
    runtime.setTurbo(25);
    expect(h.gm.calls).toEqual(["ratio:10", "ff:1"]);
    h.gm.calls.length = 0;
    runtime.setTurbo(Number.NaN);
    expect(h.gm.calls).toEqual(["ff:0"]);
    expect(h.instance().isFastForward).toBe(false);
  });

  it("fast forwards at the core's own ratio when the core has no ratio call", async () => {
    const runtime = await running();
    (h.gm as unknown as { setFastForwardRatio?: unknown }).setFastForwardRatio = undefined;
    expect(() => runtime.setTurbo(8)).not.toThrow();
    expect(h.gm.calls).toEqual(["ff:1"]);
    expect(h.instance().isFastForward).toBe(true);
  });

  it("leaves the game at normal speed, and does not throw into the HUD, when the core refuses the ratio", async () => {
    const runtime = await running();
    h.gm.setFastForwardRatio.mockImplementationOnce(() => {
      throw new Error("no such export");
    });
    expect(() => runtime.setTurbo(8)).not.toThrow();
    expect(h.instance().isFastForward).toBe(false);
    // and it is not remembered as running: turning it off asks the core for nothing
    h.gm.calls.length = 0;
    runtime.setTurbo(0);
    expect(h.gm.calls).toEqual([]);
  });

  it("survives a core that refuses to switch fast forward off before the next ratio", async () => {
    const runtime = await running();
    runtime.setTurbo(2);
    h.gm.toggleFastForward.mockImplementationOnce(() => {
      throw new Error("gone");
    });
    h.gm.calls.length = 0;
    expect(() => runtime.setTurbo(5)).not.toThrow();
    expect(h.gm.calls).toEqual(["ratio:5", "ff:1"]);
  });
});

describe("turbo and sound", () => {
  /** A core with EmulatorJS's own volume setter: what it was last told, in order. */
  async function withVolume(volume = 0.7) {
    const runtime = await running();
    const volumes: number[] = [];
    h.instance().volume = volume;
    h.instance().setVolume = (v) => {
      volumes.push(v);
    };
    return { runtime, volumes };
  }

  it("holds the game's sound back above 3x and gives the volume the person had back when turbo ends", async () => {
    const { runtime, volumes } = await withVolume(0.7);
    runtime.setTurbo(4);
    expect(volumes).toEqual([0]);
    runtime.setTurbo(0);
    expect(volumes).toEqual([0, 0.7]);
  });

  it("leaves the sound alone at 3x and below", async () => {
    const { runtime, volumes } = await withVolume();
    runtime.setTurbo(2);
    runtime.setTurbo(3);
    runtime.setTurbo(0);
    expect(volumes).toEqual([]);
  });

  it("goes quiet and loud again as the speed crosses 3x, without touching the volume in between", async () => {
    const { runtime, volumes } = await withVolume(0.4);
    runtime.setTurbo(2);
    runtime.setTurbo(5);
    runtime.setTurbo(10);
    runtime.setTurbo(3);
    expect(volumes).toEqual([0, 0.4]);
  });

  it("keeps the person's own mute through a turbo: still silent after, and the volume comes back only on unmute", async () => {
    const { runtime, volumes } = await withVolume(0.6);
    runtime.setMuted(true);
    runtime.setTurbo(8);
    runtime.setTurbo(0);
    expect(volumes).toEqual([0]);
    expect(h.instance().muted).toBe(true);
    runtime.setMuted(false);
    expect(volumes).toEqual([0, 0.6]);
  });

  it("does not let an unmute during a fast turbo bring the sound back until it ends", async () => {
    const { runtime, volumes } = await withVolume(0.6);
    runtime.setMuted(true);
    runtime.setTurbo(8);
    runtime.setMuted(false);
    expect(volumes[volumes.length - 1]).toBe(0);
    runtime.setTurbo(0);
    expect(volumes[volumes.length - 1]).toBe(0.6);
    expect(h.instance().muted).toBe(false);
  });

  it("never comes back into silence: a stored volume of 0 is 0.5", async () => {
    const { runtime, volumes } = await withVolume(0);
    runtime.setTurbo(9);
    runtime.setTurbo(0);
    expect(volumes).toEqual([0, 0.5]);
  });

  it("does nothing about sound before the setter exists, and does not throw", async () => {
    const runtime = await running();
    expect(() => runtime.setTurbo(9)).not.toThrow();
    expect(() => runtime.setTurbo(0)).not.toThrow();
  });
});

describe("video size", () => {
  it("reads width and height from the core", async () => {
    const runtime = await running();
    expect(runtime.videoSize()).toEqual({ width: 256, height: 240 });
  });

  it("is null before the first frame (zero, undefined or not a number)", async () => {
    const runtime = await running();
    h.gm.dims = { width: 0, height: 0 };
    expect(runtime.videoSize()).toBeNull();
    h.gm.dims = {};
    expect(runtime.videoSize()).toBeNull();
    h.gm.dims = { width: Number.NaN, height: 240 };
    expect(runtime.videoSize()).toBeNull();
  });
});

describe("keyboard", () => {
  it("lets game keys through only while it is on", async () => {
    const runtime = await running();
    runtime.setKeyboard(false);
    runtime.setKeyboard(true);
    expect(h.gm.calls).toEqual(["keyboard:false", "keyboard:true"]);
  });
});

describe("keymap", () => {
  it("translates codes to EmulatorJS key names and keeps the gamepad names", () => {
    const controllers = buildDefaultControllers(DEFAULT_KEYMAP);
    expect(controllers[0]![4]).toEqual({ value: "up arrow", value2: "DPAD_UP" });
    expect(controllers[0]![3]).toEqual({ value: "enter", value2: "START" });
    expect(controllers[0]![2]).toEqual({ value: "v", value2: "SELECT" });
    expect(controllers[0]![0]).toEqual({ value: "x", value2: "BUTTON_2" });
    expect(controllers[1]).toEqual({});
  });

  it("never gives the game a key the HUD keeps (Tab, the defaults of EmulatorJS bind it)", () => {
    const names = Object.values(buildDefaultControllers(DEFAULT_KEYMAP)[0]!).map((b) => b.value);
    for (const reserved of ["tab", "space", "p", "m", "f", "t", "f1", "f2", "f3", "f4", "f6", "escape"]) {
      expect(names).not.toContain(reserved);
    }
  });

  it("leaves a button unbound when its key has no EmulatorJS name", () => {
    const controllers = buildDefaultControllers({ ...DEFAULT_KEYMAP, a: "IntlBackslash" });
    expect(controllers[0]![8]).toEqual({ value2: "BUTTON_1" });
  });

  it("names punctuation, digits and the numpad", () => {
    expect(ejsKeyName("Digit7")).toBe("7");
    expect(ejsKeyName("Numpad3")).toBe("numpad 3");
    expect(ejsKeyName("Semicolon")).toBe("semi-colon");
    expect(ejsKeyName("NotAKey")).toBeNull();
  });

  it("starts with the map the caller gave, over the defaults", async () => {
    await ready({ keymap: { a: "KeyK" } });
    const controllers = h.created[0]!.config.defaultControllers as ReturnType<typeof buildDefaultControllers>;
    expect(controllers[0]![8]!.value).toBe("k");
    expect(controllers[0]![0]!.value).toBe("x");
  });

  it("a map set before start becomes the config", async () => {
    const runtime = createEmulatorRuntime();
    runtime.setKeymap({ start: "Space" });
    const started = runtime.start(options());
    await vi.advanceTimersByTimeAsync(25);
    await started;
    const controllers = h.created[0]!.config.defaultControllers as ReturnType<typeof buildDefaultControllers>;
    expect(controllers[0]![3]!.value).toBe("space");
  });

  it("rebinds live by keyCode, leaving the gamepad side alone", async () => {
    const runtime = await running();
    h.instance().controls = { 0: { 8: { value: 90, value2: "BUTTON_1" } }, 1: {}, 2: {}, 3: {} };
    runtime.setKeymap({ a: "KeyK", nonsense: "KeyJ", b: "NotAKey" });
    expect(h.instance().controls![0]![8]).toEqual({ value: 75, value2: "BUTTON_1" });
    expect(h.instance().controls![0]![0]).toBeUndefined();
  });

  it("does not throw when EmulatorJS has not set its controls up yet", async () => {
    const runtime = await running();
    expect(() => runtime.setKeymap({ a: "KeyK" })).not.toThrow();
  });
});

describe("sound", () => {
  it("mutes with EmulatorJS's own volume setter and unmutes to the volume it had", async () => {
    const runtime = await running();
    const volumes: number[] = [];
    h.instance().volume = 0.5;
    h.instance().setVolume = (volume) => {
      volumes.push(volume);
      h.instance().muted = volume === 0;
    };
    runtime.setMuted(true);
    expect(h.instance().muted).toBe(true);
    runtime.setMuted(false);
    expect(h.instance().muted).toBe(false);
    expect(volumes).toEqual([0, 0.5]);
  });

  it("never unmutes into silence, and does nothing before the setter exists", async () => {
    const runtime = await running();
    expect(() => runtime.setMuted(true)).not.toThrow();
    const volumes: number[] = [];
    h.instance().volume = 0;
    h.instance().setVolume = (volume) => void volumes.push(volume);
    runtime.setMuted(false);
    expect(volumes).toEqual([0.5]);
  });
});

describe("RetroArch's own menu stays shut", () => {
  function frontendWithConfig() {
    class Manager {
      getRetroArchCfg() {
        return 'autosave_interval = 60\nsavefile_directory = "/data/saves"\n';
      }
    }
    (window as unknown as { EJS_GameManager: unknown }).EJS_GameManager = Manager;
    return Manager;
  }

  it("adds no way into the menu, and no way to quit, to the config the game manager writes", async () => {
    const Manager = frontendWithConfig();
    await ready();
    const cfg = new Manager().getRetroArchCfg();
    // what was there is still there, and the lockdown follows it on lines of its own
    expect(cfg.startsWith('autosave_interval = 60\nsavefile_directory = "/data/saves"\n')).toBe(true);
    for (const line of [
      'input_menu_toggle = "nul"',
      'input_menu_toggle_btn = "nul"',
      'input_menu_toggle_axis = "nul"',
      'input_menu_toggle_gamepad_combo = "0"',
      'input_exit_emulator = "nul"',
    ]) {
      expect(cfg.split("\n"), line).toContain(line);
    }
    expect(cfg.endsWith("\n")).toBe(true);
  });

  it("tells RetroArch to fill the canvas (aspect \"Full\", index 24): the stage's box IS the picture, no second letterbox inside it", async () => {
    const Manager = frontendWithConfig();
    await ready();
    const lines = new Manager().getRetroArchCfg().split("\n");
    expect(lines).toContain("aspect_ratio_index = 24");
    // it is the last of RetroArch's aspect table, FULL: 4:3 0, ... 32:9 19, config 20, square 21, core 22, custom 23, full 24
    expect(lines.filter((line) => line.startsWith("aspect_ratio_index"))).toHaveLength(1);
  });

  it("is written once however many games are started", async () => {
    const Manager = frontendWithConfig();
    await ready();
    await ready();
    await ready();
    const cfg = new Manager().getRetroArchCfg();
    expect(cfg.split('input_menu_toggle = "nul"').length - 1).toBe(1);
  });

  it("a frontend with no game manager yet is left alone (nothing to hook, nothing thrown)", async () => {
    await expect(ready()).resolves.toBeDefined();
  });
});

describe("the exit's abort is quiet", () => {
  it("Ejetar swallows the RuntimeError the core's abort throws by design, and still aborts", async () => {
    const runtime = await running();
    const abort = vi.fn(() => {
      throw new Error("Aborted(undefined)");
    });
    const instance = h.instance();
    (instance as unknown as { Module: { abort: () => unknown } }).Module = { abort };
    runtime.stop();
    const module = (instance as unknown as { Module: { abort: () => unknown } }).Module;
    // what EmulatorJS's exit does a second later, inside its own try/catch that would `console.warn` the throw
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => module.abort()).not.toThrow();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a core with no Module yet is stopped without a word", async () => {
    const runtime = await running();
    expect(() => runtime.stop()).not.toThrow();
  });
});

describe("telling a game from RetroArch's empty menu", () => {
  it("failed() is the emulator's own verdict", async () => {
    const runtime = await ready();
    expect(runtime.failed()).toBe(false);
    h.instance().failedToStart = true;
    expect(runtime.failed()).toBe(true);
  });

  it("frames() reads the core's frame counter, and is null when there is none to read", async () => {
    const runtime = await running();
    expect(runtime.frames()).toBeNull();
    (h.gm as unknown as { getFrameNum: () => number }).getFrameNum = () => 0;
    expect(runtime.frames()).toBe(0);
    (h.gm as unknown as { getFrameNum: () => number }).getFrameNum = () => 120;
    expect(runtime.frames()).toBe(120);
    (h.gm as unknown as { getFrameNum: () => number }).getFrameNum = () => {
      throw new Error("the core is gone");
    };
    expect(runtime.frames()).toBeNull();
  });
});
