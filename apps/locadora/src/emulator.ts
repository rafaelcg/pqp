import esLanguage from "@emulatorjs/emulatorjs/data/localization/es-ES.json";
import ptLanguage from "@emulatorjs/emulatorjs/data/localization/pt-BR.json";
import { unpackContainer } from "./container";
import type { EmulatorRuntime, KeyMap, Turbo, VideoSize } from "./runtime";
import { coreRatio, silencesGame } from "./turbo";
import { FRONTEND_FILE_NAMES, type CoreName } from "./systems";

/*
 * The EmulatorJS frontend is loaded by index.html as a plain script (vendored
 * and patched at build time, `build/patch.mts`), so what is here is the part
 * that replaces its `loader.js`: it sets the page-level hooks the patches use,
 * builds the config, and starts it. See docs/EMULATOR_ROOM.md for the rules
 * and docs/APPS.md for how the sandbox is set up.
 *
 * What it never does: fetch anything (every file comes from the host as bytes
 * and reaches EmulatorJS as a blob URL), keep anything (databases and settings
 * storage are off), or read the file's name (the game is a `File` named
 * `rom.<ext>`, a fixed word plus the extension the host reported).
 */

/** The part of `window.EJS_emulator.gameManager` the facade touches (EmulatorJS `GameManager.js`). */
export interface GameManagerLike {
  getState(): Uint8Array;
  loadState(state: Uint8Array): void;
  screenshot(): Promise<Uint8Array>;
  /** `save` false reads the file as it is; the default asks the core to write it out first. */
  getSaveFile(save?: boolean): Uint8Array | null;
  getSaveFilePath(): string;
  loadSaveFiles(): void;
  toggleFastForward(active: number): void;
  setFastForwardRatio(ratio: number): void;
  toggleMainLoop(playing: number): void;
  getVideoDimensions(type: "width" | "height" | "aspect"): number | undefined;
  setKeyboardEnabled(enabled: boolean): void;
  /** The core's frame counter: it stays 0 while RetroArch sits in its menu because no game loaded. */
  getFrameNum?(): number;
  /** The raw calls `getState` wraps: `size|pointer|1` for a state, `reason||0` for none, `pending||2` while the bsnes build's main loop is still making it. */
  functions?: { saveStateInfo?(): string };
  Module?: { HEAPU8?: Uint8Array };
  FS: {
    analyzePath(path: string): { exists: boolean };
    mkdir(path: string): void;
    unlink(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
  };
}

export interface EmulatorJSInstance {
  on(event: string, callback: () => void): void;
  callEvent?(event: string): number;
  failedToStart?: boolean;
  gameManager?: GameManagerLike;
  /** The core's runtime; its `abort` is what EmulatorJS's exit calls a second after the game stops. */
  Module?: { abort?: (what?: unknown) => unknown };
  ejs_version?: string;
  /** EmulatorJS's own bookkeeping, kept true to what we did so its menus do not lie. */
  paused?: boolean;
  isFastForward?: boolean;
  /** `controls[player][buttonId]`, `value` being a `keyCode` once EmulatorJS has set its keys up. */
  controls?: Record<number, Record<number, { value?: number | string; value2?: string }>>;
  /** The volume it goes back to when unmuted (0 to 1), and the mute flag its own menu keeps. */
  volume?: number;
  muted?: boolean;
  /** Set up with its settings menu once the core is ready; scales every audio source's gain. */
  setVolume?(volume: number): void;
}

declare global {
  interface Window {
    EmulatorJS?: new (selector: string, config: Record<string, unknown>) => EmulatorJSInstance;
    EJS_emulator?: EmulatorJSInstance;
    EJS_GameManager?: { prototype: { getRetroArchCfg?: () => string } };
    PQP_UNPACK?: (data: Uint8Array) => Promise<Record<string, Uint8Array>>;
    PQP_CORE_JS_URL?: string;
    PQP_CORE_JS_SRI?: Readonly<Record<string, string>>;
  }
}

/** The buttons that would write somewhere, download something or leave the frame stay off. */
export const BUTTONS = {
  saveState: false,
  loadState: false,
  quickSave: false,
  quickLoad: false,
  saveSavFiles: false,
  loadSavFiles: false,
  cacheManager: false,
  screenRecord: false,
  screenshot: false,
  cheat: false,
  netplay: false,
  exitEmulation: false,
  diskButton: false,
  // the host fullscreens the iframe element itself (`ui.fullscreen`), the emulator's own button cannot
  fullscreen: false,
} as const;

export type EmulatorLanguage = "pt-BR" | "es-ES" | "en-US";

const LANGUAGE_JSON: Partial<Record<EmulatorLanguage, Record<string, string>>> = {
  "pt-BR": ptLanguage,
  "es-ES": esLanguage,
};

export interface StartOptions {
  /** A CSS selector: EmulatorJS looks its element up with `document.querySelector`. */
  container: string;
  core: CoreName;
  /** `.nes`, `.sfc`, `.smc`, `.gb`, `.gbc` or `.gba`, from the closed list. */
  ext: string;
  rom: ArrayBuffer;
  /** The core's repacked archive (`assets[]`). */
  coreData: ArrayBuffer;
  /** The core's report (`assets[]`). */
  report: ArrayBuffer;
  language: EmulatorLanguage;
  /** `#rrggbb`, taken from the host's theme, or nothing for EmulatorJS's own blue. */
  accent?: string;
  /** What a recorded state is stamped with; defaults to the frontend's version, which every core ships in step with. */
  coreVersion?: string;
  /** Action name to `KeyboardEvent.code`; what is missing keeps `DEFAULT_KEYMAP`. */
  keymap?: KeyMap;
  /**
   * Hides EmulatorJS's own start pill, so the host's button is the only Start. The
   * host then calls `begin()` from its click (the audio needs that gesture).
   */
  ownStart?: boolean;
  onReady?: () => void;
  onStart?: () => void;
  /** EmulatorJS gave up (it draws its own message too). */
  onError?: () => void;
}

/** What `EJS_paths` has to answer: file name to blob URL. EmulatorJS matches by basename. */
export function buildFilePaths(core: CoreName, coreData: ArrayBuffer, report: ArrayBuffer): Record<string, string> {
  const names = FRONTEND_FILE_NAMES[core];
  return {
    [names.data]: URL.createObjectURL(new Blob([coreData], { type: "application/octet-stream" })),
    [names.report]: URL.createObjectURL(new Blob([report], { type: "application/json" })),
  };
}

/**
 * What is added to RetroArch's own config. RetroArch has a menu of its own (F1 opens it, and a game that fails to
 * load falls into it, in English, with a file browser that reads nothing of ours): none of its ways in is bound,
 * and neither is the one that quits it, so the person only ever sees our screens.
 */
export const RETROARCH_LOCKDOWN = [
  'input_menu_toggle = "nul"',
  'input_menu_toggle_btn = "nul"',
  'input_menu_toggle_axis = "nul"',
  'input_menu_toggle_gamepad_combo = "0"',
  'input_exit_emulator = "nul"',
  'input_exit_emulator_btn = "nul"',
  "quit_press_twice = false",
].join("\n");

const LOCKED = Symbol.for("pqp.locadora.retroarch-lockdown");

type ConfigWriter = { getRetroArchCfg?: () => string; [LOCKED]?: boolean };

/** Appends `RETROARCH_LOCKDOWN` to the config the game manager writes. Once: a second call changes nothing. */
export function lockRetroArchMenu(): void {
  const manager = window.EJS_GameManager?.prototype as ConfigWriter | undefined;
  const original = manager?.getRetroArchCfg;
  if (!manager || typeof original !== "function" || manager[LOCKED]) return;
  manager.getRetroArchCfg = function (this: unknown) {
    const cfg = original.call(this);
    return `${cfg}${cfg.endsWith("\n") ? "" : "\n"}${RETROARCH_LOCKDOWN}\n`;
  };
  manager[LOCKED] = true;
}

export function installHooks(): void {
  window.PQP_UNPACK = (data) => unpackContainer(data);
  lockRetroArchMenu();
}

/** `#rrggbb` only: EmulatorJS parses a hex colour and nothing else. */
export function hexAccent(value: string | undefined): string | undefined {
  return value && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : undefined;
}

/**
 * Ends the running game the way the emulator's own exit does (its `exit` event
 * stops the main loop, unmounts its file system and aborts the core a second
 * later) and empties its element, so another game can start in the same frame.
 */
export function stopEmulator(container = "#game"): void {
  const running = window.EJS_emulator;
  window.EJS_emulator = undefined;
  quietAbort(running);
  try {
    running?.callEvent?.("exit");
  } catch {
    // a core that is already gone has nothing left to stop
  }
  document.querySelector(container)?.replaceChildren();
}

/**
 * The exit above ends with `Module.abort()` a second later, and an emscripten abort throws a `RuntimeError`
 * ("Aborted(undefined)") by design, which the frontend then prints as a warning on every Ejetar. The abort is
 * the point (it frees the core), the throw is not: it is swallowed here, for this instance only.
 */
export function quietAbort(running: EmulatorJSInstance | undefined): void {
  const module = running?.Module;
  const abort = module?.abort;
  if (!module || typeof abort !== "function") return;
  module.abort = (what?: unknown) => {
    try {
      return abort.call(module, what);
    } catch {
      return undefined;
    }
  };
}

export function startEmulator(options: StartOptions): EmulatorJSInstance {
  const Emulator = window.EmulatorJS;
  if (!Emulator) throw new Error("the emulator frontend is not loaded");
  installHooks();
  // the glue of the core, from the bundle: the patched frontend refuses it without its integrity
  window.PQP_CORE_JS_URL = `./core-js/${options.core}.js`;

  const config: Record<string, unknown> = {
    gameUrl: new File([options.rom], `rom${options.ext}`, { type: "application/octet-stream" }),
    gameName: "rom",
    dataPath: "./",
    system: options.core,
    volume: 0.5,
    // the click on EmulatorJS's own Start button is what lets the audio run
    startOnLoad: false,
    filePaths: buildFilePaths(options.core, options.coreData, options.report),
    threads: false,
    disableDatabases: true,
    disableLocalStorage: true,
    forceLegacyCores: true,
    buttonOpts: { ...BUTTONS },
    shaders: {},
    language: options.language,
    defaultControllers: buildDefaultControllers({ ...DEFAULT_KEYMAP, ...options.keymap }),
  };
  const langJson = LANGUAGE_JSON[options.language];
  if (langJson) config.langJson = langJson;
  const color = hexAccent(options.accent);
  if (color) config.color = color;

  const instance = new Emulator(options.container, config);
  window.EJS_emulator = instance;
  // the pill is built inside the constructor; display none through CSSOM, which the page's CSP allows
  if (options.ownStart) hideStartButton(options.container);
  if (options.onReady) instance.on("ready", options.onReady);
  if (options.onStart) instance.on("start", options.onStart);
  if (options.onError) {
    const watch = setInterval(() => {
      if (instance.failedToStart) {
        clearInterval(watch);
        options.onError?.();
      }
    }, 500);
    instance.on("start", () => clearInterval(watch));
  }
  return instance;
}

const START_BUTTON = ".ejs_start_button";

function startButton(container: string): HTMLElement | null {
  return document.querySelector(container)?.querySelector<HTMLElement>(START_BUTTON) ?? null;
}

function hideStartButton(container: string): void {
  const button = startButton(container);
  if (button) button.style.display = "none";
}

/*
 * The keymap. EmulatorJS binds a key by the name its `keyMap` table gives a
 * `keyCode`, and a button by the libretro RetroPad id; ours are action names
 * and `KeyboardEvent.code`, so both ends are translated here and nowhere else.
 */

/** The RetroPad id and the gamepad name EmulatorJS binds, per action. */
const BUTTONS_BY_ACTION: Readonly<Record<string, { id: number; pad: string }>> = {
  b: { id: 0, pad: "BUTTON_2" },
  y: { id: 1, pad: "BUTTON_4" },
  select: { id: 2, pad: "SELECT" },
  start: { id: 3, pad: "START" },
  up: { id: 4, pad: "DPAD_UP" },
  down: { id: 5, pad: "DPAD_DOWN" },
  left: { id: 6, pad: "DPAD_LEFT" },
  right: { id: 7, pad: "DPAD_RIGHT" },
  a: { id: 8, pad: "BUTTON_1" },
  x: { id: 9, pad: "BUTTON_3" },
  l: { id: 10, pad: "LEFT_TOP_SHOULDER" },
  r: { id: 11, pad: "RIGHT_TOP_SHOULDER" },
};

/** Keys the HUD keeps for itself are left out on purpose (Space, P, M, F, T, F1 to F4, F6, F8, Esc, Tab). */
export const DEFAULT_KEYMAP: KeyMap = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  a: "KeyZ",
  b: "KeyX",
  x: "KeyA",
  y: "KeyS",
  l: "KeyQ",
  r: "KeyE",
  select: "KeyV",
  start: "Enter",
};

const KEYS: Record<string, { name: string; keyCode: number }> = {
  Backspace: { name: "backspace", keyCode: 8 },
  Tab: { name: "tab", keyCode: 9 },
  Enter: { name: "enter", keyCode: 13 },
  NumpadEnter: { name: "enter", keyCode: 13 },
  Space: { name: "space", keyCode: 32 },
  PageUp: { name: "page up", keyCode: 33 },
  PageDown: { name: "page down", keyCode: 34 },
  End: { name: "end", keyCode: 35 },
  Home: { name: "home", keyCode: 36 },
  ArrowLeft: { name: "left arrow", keyCode: 37 },
  ArrowUp: { name: "up arrow", keyCode: 38 },
  ArrowRight: { name: "right arrow", keyCode: 39 },
  ArrowDown: { name: "down arrow", keyCode: 40 },
  Insert: { name: "insert", keyCode: 45 },
  Delete: { name: "delete", keyCode: 46 },
  NumpadMultiply: { name: "multiply", keyCode: 106 },
  NumpadAdd: { name: "add", keyCode: 107 },
  NumpadSubtract: { name: "subtract", keyCode: 109 },
  NumpadDecimal: { name: "decimal point", keyCode: 110 },
  NumpadDivide: { name: "divide", keyCode: 111 },
  Semicolon: { name: "semi-colon", keyCode: 186 },
  Equal: { name: "equal sign", keyCode: 187 },
  Comma: { name: "comma", keyCode: 188 },
  Minus: { name: "dash", keyCode: 189 },
  Period: { name: "period", keyCode: 190 },
  Slash: { name: "forward slash", keyCode: 191 },
  Backquote: { name: "grave accent", keyCode: 192 },
  BracketLeft: { name: "open bracket", keyCode: 219 },
  Backslash: { name: "back slash", keyCode: 220 },
  BracketRight: { name: "close braket", keyCode: 221 }, // sic, EmulatorJS's spelling
  Quote: { name: "single quote", keyCode: 222 },
};
for (let i = 0; i < 26; i += 1) {
  const letter = String.fromCharCode(97 + i);
  KEYS[`Key${letter.toUpperCase()}`] = { name: letter, keyCode: 65 + i };
}
for (let i = 0; i < 10; i += 1) {
  KEYS[`Digit${i}`] = { name: String(i), keyCode: 48 + i };
  KEYS[`Numpad${i}`] = { name: `numpad ${i}`, keyCode: 96 + i };
}
for (let i = 1; i <= 12; i += 1) KEYS[`F${i}`] = { name: `f${i}`, keyCode: 111 + i };

/** EmulatorJS's name for a `KeyboardEvent.code`, or null for a key it has no name for. */
export function ejsKeyName(code: string): string | null {
  return KEYS[code]?.name ?? null;
}

type Controls = Record<number, Record<number, { value?: string; value2?: string }>>;

/** The `defaultControllers` of the config: player one from the map, with the gamepad names kept. */
export function buildDefaultControllers(map: KeyMap): Controls {
  const one: Controls[number] = {};
  for (const [action, { id, pad }] of Object.entries(BUTTONS_BY_ACTION)) {
    const code = map[action];
    const name = code ? ejsKeyName(code) : null;
    one[id] = name ? { value: name, value2: pad } : { value2: pad };
  }
  return { 0: one, 1: {}, 2: {}, 3: {} };
}

/** Which core, at which version, made a state: a state from another build may not open. */
export interface StateInfo {
  core: CoreName;
  coreVersion: string;
}

export interface StateRecord extends StateInfo {
  data: Uint8Array;
}

export function sameConsole(a: StateInfo, b: StateInfo): boolean {
  return a.core === b.core && a.coreVersion === b.coreVersion;
}

/** How long `screenshot()` waits for the core to write the frame before giving up. */
export const SCREENSHOT_TIMEOUT_MS = 3000;

/** How long `getState()` waits for a core that makes its state on the main loop (bsnes). */
export const STATE_TIMEOUT_MS = 3000;

type Running = EmulatorJSInstance & { gameManager: GameManagerLike };

export class EjsRuntime implements EmulatorRuntime {
  private options: StartOptions | null = null;
  private keymap: Record<string, string> = { ...DEFAULT_KEYMAP };
  private turbo: Turbo = 0;
  /** The person's own sound switch, kept apart from the turbo's: the game is silent while either holds it down. */
  private userMuted = false;
  private turboMuted = false;
  private silentApplied = false;

  /** Boots the console; resolves on EmulatorJS's `ready`, with our Start still to be pressed (`begin`). */
  start(options: StartOptions): Promise<void> {
    this.options = options;
    this.turbo = 0;
    this.turboMuted = false;
    this.silentApplied = false;
    if (options.keymap) this.keymap = { ...this.keymap, ...options.keymap };
    return new Promise<void>((resolve, reject) => {
      try {
        startEmulator({
          ...options,
          keymap: this.keymap,
          ownStart: true,
          onReady: () => {
            options.onReady?.();
            resolve();
          },
          onError: () => {
            options.onError?.();
            reject(new Error("the emulator could not start"));
          },
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error("the emulator could not start"));
      }
    });
  }

  /**
   * Our Start button's job. Runs EmulatorJS's own start from inside the caller's
   * click, synchronously and with nothing awaited before it: the browser lets the
   * audio run only for a page the person has acted on, and this is that action.
   * False when there is no pill (already started, or never loaded).
   */
  begin(): boolean {
    const button = this.options ? startButton(this.options.container) : null;
    if (!button) return false;
    button.click();
    return true;
  }

  /** EmulatorJS gave up starting the game (its own error text sits behind our overlay). */
  failed(): boolean {
    return window.EJS_emulator?.failedToStart === true;
  }

  /**
   * The core's frame counter, or null when it cannot be read. It stays 0 when the game did not load and RetroArch
   * sits in its menu instead, the one failure the emulator does not announce.
   */
  frames(): number | null {
    try {
      const count = window.EJS_emulator?.gameManager?.getFrameNum?.();
      return typeof count === "number" && Number.isFinite(count) ? count : null;
    } catch {
      return null;
    }
  }

  /** Ends the running game and empties its element. */
  stop(): void {
    this.turbo = 0;
    this.turboMuted = false;
    stopEmulator(this.options?.container);
  }

  pause(paused: boolean): void {
    const ejs = this.running();
    ejs.gameManager.toggleMainLoop(paused ? 0 : 1);
    ejs.paused = paused;
  }

  /**
   * The core's state. FCEUmm and mGBA answer at once. The bsnes build (vendor/emulatorjs-core-bsnes) answers
   * `pending` first and makes the state at the top of its next main loop tick, because its threads are fibers
   * that may only switch there; a paused game gets one tick that serves the state and pauses again before a
   * frame runs, so the picture does not move.
   */
  async getState(): Promise<Uint8Array> {
    const ejs = this.running();
    const { gameManager } = ejs;
    const info = gameManager.functions?.saveStateInfo;
    const heap = () => gameManager.Module?.HEAPU8;
    if (!info || !heap()) return gameManager.getState();
    const deadline = Date.now() + STATE_TIMEOUT_MS;
    let kicked = false;
    for (;;) {
      const [first = "", second = "", flag = ""] = info.call(gameManager.functions).split("|");
      if (flag === "1") {
        const size = Number.parseInt(first, 10);
        const start = Number.parseInt(second, 10);
        return new Uint8Array(heap()!.subarray(start, start + size));
      }
      if (flag !== "2") throw new Error(first || "the core gave no state");
      if (ejs.paused && !kicked) {
        kicked = true;
        gameManager.toggleMainLoop(1);
        gameManager.toggleMainLoop(0);
      }
      if (Date.now() > deadline) throw new Error("the core did not make the state in time");
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
  }

  /** A state stamped with the core that made it. */
  async getStateRecord(): Promise<StateRecord> {
    const data = await this.getState();
    return { ...this.stateInfo(), data };
  }

  /** What a state taken now would be stamped with. */
  stateInfo(): StateInfo {
    const ejs = this.running();
    return { core: this.options!.core, coreVersion: this.options!.coreVersion ?? ejs.ejs_version ?? "unknown" };
  }

  async loadState(state: Uint8Array): Promise<void> {
    this.running().gameManager.loadState(state);
  }

  async screenshot(): Promise<Blob> {
    const { gameManager } = this.running();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("the core wrote no frame")), SCREENSHOT_TIMEOUT_MS);
    });
    try {
      const png = await Promise.race([gameManager.screenshot(), timeout]);
      return new Blob([png as BlobPart], { type: "image/png" });
    } finally {
      clearTimeout(timer);
    }
  }

  async readSram(): Promise<Uint8Array | null> {
    const file = this.running().gameManager.getSaveFile();
    return file && file.length > 0 ? new Uint8Array(file) : null;
  }

  async writeSram(data: Uint8Array): Promise<void> {
    const { gameManager } = this.running();
    const path = gameManager.getSaveFilePath();
    let directory = "";
    for (const part of path.split("/").slice(0, -1)) {
      if (part === "") continue;
      directory += `/${part}`;
      if (!gameManager.FS.analyzePath(directory).exists) gameManager.FS.mkdir(directory);
    }
    if (gameManager.FS.analyzePath(path).exists) gameManager.FS.unlink(path);
    gameManager.FS.writeFile(path, data);
    gameManager.loadSaveFiles();
  }

  /**
   * Fast forward at `turbo` times (0 is normal speed). A change goes through off, then the ratio, then on, so two
   * speeds never stack. The ratio goes to the core as a float ("4.5"), held between 1 and 10: a core that lacks the
   * ratio call just fast-forwards at its own default, and one that refuses it leaves the game at normal speed
   * instead of throwing into the HUD. Above 3x the game's sound is held back and comes back, exactly as the
   * person had it, when turbo ends.
   */
  setTurbo(turbo: Turbo): void {
    const ejs = this.running();
    const { gameManager } = ejs;
    const wanted = turbo > 0 ? coreRatio(turbo) : 0;
    try {
      if (this.turbo !== 0) gameManager.toggleFastForward(0);
    } catch {
      // the core is already past caring about fast forward; start from normal speed below
    }
    let applied = 0;
    if (wanted !== 0) {
      try {
        if (typeof gameManager.setFastForwardRatio === "function") gameManager.setFastForwardRatio(wanted);
        gameManager.toggleFastForward(1);
        applied = wanted;
      } catch {
        applied = 0;
      }
    }
    ejs.isFastForward = applied !== 0;
    this.turbo = applied;
    this.turboMuted = silencesGame(applied);
    this.applyVolume(false);
  }

  videoSize(): VideoSize | null {
    const gameManager = window.EJS_emulator?.gameManager;
    if (!gameManager) return null;
    const width = gameManager.getVideoDimensions("width");
    const height = gameManager.getVideoDimensions("height");
    if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) return null;
    return { width, height };
  }

  setKeyboard(enabled: boolean): void {
    this.running().gameManager.setKeyboardEnabled(enabled);
  }

  /** Before the game starts this feeds `defaultControllers`; during it, the live bindings. */
  setKeymap(map: KeyMap): void {
    this.keymap = { ...this.keymap, ...map };
    const player = window.EJS_emulator?.controls?.[0];
    if (!player) return;
    for (const [action, code] of Object.entries(map)) {
      const button = BUTTONS_BY_ACTION[action];
      const key = KEYS[code];
      if (!button || !key) continue;
      player[button.id] = { ...player[button.id], value: key.keyCode };
    }
  }

  /**
   * EmulatorJS's own mute: its volume setter scales every audio source (it is what its
   * mute button calls). The remembered volume is never 0, so unmuting is never silence.
   */
  setMuted(muted: boolean): void {
    this.userMuted = muted;
    const ejs = this.running();
    if (!ejs.setVolume) return;
    if (!muted && (ejs.volume === undefined || ejs.volume === 0)) ejs.volume = 0.5;
    ejs.muted = muted;
    this.applyVolume(true);
  }

  /**
   * Silence while the person muted or turbo is above 3x, else the volume they had. Only touches the core's volume
   * when the answer changes (or when asked to), so a turbo at 2x never nudges a volume nobody changed.
   */
  private applyVolume(force: boolean): void {
    const ejs = this.running();
    if (!ejs.setVolume) return;
    const silent = this.userMuted || this.turboMuted;
    if (!force && silent === this.silentApplied) return;
    this.silentApplied = silent;
    ejs.setVolume(silent ? 0 : ejs.volume === undefined || ejs.volume === 0 ? 0.5 : ejs.volume);
  }

  private running(): Running {
    const ejs = window.EJS_emulator;
    if (!ejs?.gameManager || !this.options) throw new Error("the emulator is not running");
    return ejs as Running;
  }
}

export function createEmulatorRuntime(): EjsRuntime {
  return new EjsRuntime();
}
