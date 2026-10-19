import esLanguage from "@emulatorjs/emulatorjs/data/localization/es-ES.json";
import ptLanguage from "@emulatorjs/emulatorjs/data/localization/pt-BR.json";
import { unpackContainer } from "./container";
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

interface EmulatorJSInstance {
  on(event: string, callback: () => void): void;
  callEvent?(event: string): number;
  failedToStart?: boolean;
}

declare global {
  interface Window {
    EmulatorJS?: new (selector: string, config: Record<string, unknown>) => EmulatorJSInstance;
    EJS_emulator?: EmulatorJSInstance;
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
  /** `.nes`, `.gb`, `.gbc` or `.gba`, from the closed list. */
  ext: string;
  rom: ArrayBuffer;
  /** The core's repacked archive (`assets[]`). */
  coreData: ArrayBuffer;
  /** The core's report (`assets[]`). */
  report: ArrayBuffer;
  language: EmulatorLanguage;
  /** `#rrggbb`, taken from the host's theme, or nothing for EmulatorJS's own blue. */
  accent?: string;
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

export function installHooks(): void {
  window.PQP_UNPACK = (data) => unpackContainer(data);
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
  try {
    running?.callEvent?.("exit");
  } catch {
    // a core that is already gone has nothing left to stop
  }
  document.querySelector(container)?.replaceChildren();
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
  };
  const langJson = LANGUAGE_JSON[options.language];
  if (langJson) config.langJson = langJson;
  const color = hexAccent(options.accent);
  if (color) config.color = color;

  const instance = new Emulator(options.container, config);
  window.EJS_emulator = instance;
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
