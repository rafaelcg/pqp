/**
 * The controller map's rules, with no DOM in it: which buttons each console
 * has, the default key of each, which keys belong to Locadora's own shortcuts
 * (SPEC 8) and what happens when a person rebinds one.
 *
 * A map is `KeyMap` from `runtime.ts`: button name to `KeyboardEvent.code`.
 * Codes, not characters, so the layout the person types on never matters.
 * One map per console, because the SNES has X and Y and the NES does not.
 */
import type { KeyMap } from "./runtime";

export type Platform = "nes" | "snes" | "gb" | "gba";

export const PLATFORMS: readonly Platform[] = ["nes", "snes", "gb", "gba"];

export type PadButton =
  | "up"
  | "down"
  | "left"
  | "right"
  | "a"
  | "b"
  | "x"
  | "y"
  | "l"
  | "r"
  | "start"
  | "select";

export const DPAD: readonly PadButton[] = ["up", "down", "left", "right"];

/** What each console has. Order is the order the map walks them in. */
export const BUTTONS_BY_PLATFORM: Readonly<Record<Platform, readonly PadButton[]>> = {
  nes: ["up", "down", "left", "right", "b", "a", "select", "start"],
  snes: ["up", "down", "left", "right", "b", "a", "y", "x", "l", "r", "select", "start"],
  gb: ["up", "down", "left", "right", "b", "a", "select", "start"],
  gba: ["up", "down", "left", "right", "b", "a", "l", "r", "select", "start"],
};

const BASE_KEYS: Readonly<Partial<Record<PadButton, string>>> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  b: "KeyX",
  a: "KeyZ",
  start: "Enter",
  select: "KeyV",
  l: "KeyQ",
  r: "KeyE",
};

const SNES_KEYS: Readonly<Partial<Record<PadButton, string>>> = { ...BASE_KEYS, y: "KeyA", x: "KeyS" };

/** The keys everybody starts with, and what "Voltar ao padrao" restores. */
export function defaultKeymap(platform: Platform): KeyMap {
  const source = platform === "snes" ? SNES_KEYS : BASE_KEYS;
  const map: Record<string, string> = {};
  for (const button of BUTTONS_BY_PLATFORM[platform]) {
    const code = source[button];
    if (code) map[button] = code;
  }
  return map;
}

export type Keymaps = Record<Platform, KeyMap>;

export function defaultKeymaps(): Keymaps {
  return { nes: defaultKeymap("nes"), snes: defaultKeymap("snes"), gb: defaultKeymap("gb"), gba: defaultKeymap("gba") };
}

/**
 * The keys of Locadora's own shortcuts (SPEC 8): Espaco, P, M, F, T, F1 to F4, F6, F8, Esc, Tab.
 * A game button on one of them would fire both, so the map refuses them.
 */
export const RESERVED_CODES: ReadonlySet<string> = new Set([
  "Space",
  "KeyP",
  "KeyM",
  "KeyF",
  "KeyT",
  "F1",
  "F2",
  "F3",
  "F4",
  "F6",
  "F8",
  "Escape",
  "Tab",
]);

export function isReserved(code: string): boolean {
  return RESERVED_CODES.has(code);
}

/** Keys that are not a key on their own: held to make a chord, never a game button. */
const MODIFIER = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$|^(CapsLock|NumLock|ScrollLock|ContextMenu|Fn|FnLock)$/;

export function isModifier(code: string): boolean {
  return MODIFIER.test(code);
}

const NAMES: Readonly<Record<string, string>> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Space: "Space",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  IntlBackslash: "<",
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
  ControlLeft: "Ctrl",
  ControlRight: "Ctrl",
  AltLeft: "Alt",
  AltRight: "Alt",
};

/** What to write on a keycap: `KeyZ` is "Z", `ArrowUp` is an arrow. Unknown codes read as themselves. */
export function keyLabel(code: string): string {
  const named = NAMES[code];
  if (named) return named;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `Num ${code.slice(6)}`;
  if (/^F[0-9]{1,2}$/.test(code)) return code;
  return code;
}

/** The four arrows, in the order `DPAD` lists them. */
const ARROWS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

export function dpadIsArrows(map: KeyMap): boolean {
  return DPAD.every((button, i) => map[button] === ARROWS[i]);
}

export type RemapProposal =
  /** The key belongs to a Locadora shortcut: refuse, say so. */
  | { status: "reserved" }
  /** Not a key a game can use on its own (Shift alone, Caps Lock): ignore it, say nothing. */
  | { status: "ignored" }
  /** The button already has this key. */
  | { status: "same"; map: KeyMap }
  /** Free: `map` is the result. */
  | { status: "free"; map: KeyMap }
  /** Another button holds the key: ask. `swap` is the result if the person says yes. */
  | { status: "duplicate"; other: PadButton; swap: KeyMap };

/** What happens if `button` of `platform` is rebound to `code`. Never mutates `map`. */
export function proposeRemap(map: KeyMap, platform: Platform, button: PadButton, code: string): RemapProposal {
  if (isModifier(code)) return { status: "ignored" };
  if (isReserved(code)) return { status: "reserved" };
  if (map[button] === code) return { status: "same", map };
  const holder = BUTTONS_BY_PLATFORM[platform].find((other) => other !== button && map[other] === code);
  if (holder) {
    const previous = map[button];
    const swap: Record<string, string> = { ...map, [button]: code };
    if (previous) swap[holder] = previous;
    else delete swap[holder];
    return { status: "duplicate", other: holder, swap };
  }
  return { status: "free", map: { ...map, [button]: code } };
}

/**
 * Reads a stored map back. Anything that is not exactly a valid map of this
 * console (an unknown button, a reserved or repeated key, a missing button)
 * gives the console's defaults, so a bad row never leaves a button unbound.
 */
export function parseKeymap(raw: unknown, platform: Platform): KeyMap {
  const fallback = defaultKeymap(platform);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fallback;
  const record = raw as Record<string, unknown>;
  const buttons = BUTTONS_BY_PLATFORM[platform];
  const seen = new Set<string>();
  const map: Record<string, string> = {};
  for (const button of buttons) {
    const code = record[button];
    if (typeof code !== "string" || code.length === 0 || code.length > 32) return fallback;
    if (isReserved(code) || isModifier(code) || seen.has(code)) return fallback;
    seen.add(code);
    map[button] = code;
  }
  for (const key of Object.keys(record)) if (!buttons.includes(key as PadButton)) return fallback;
  return map;
}

export function parseKeymaps(raw: unknown): Keymaps {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    nes: parseKeymap(record.nes, "nes"),
    snes: parseKeymap(record.snes, "snes"),
    gb: parseKeymap(record.gb, "gb"),
    gba: parseKeymap(record.gba, "gba"),
  };
}

/* ---- the listening session ---- */

export type RemapNote =
  | { kind: "reserved"; code: string }
  | { kind: "duplicate"; code: string; other: PadButton };

export interface RemapState {
  platform: Platform;
  maps: Keymaps;
  /** The buttons still waiting for a key; the first is the one listening. Empty: not listening. */
  queue: readonly PadButton[];
  /** A duplicate the person has not answered yet. */
  pending: { button: PadButton; code: string; other: PadButton; swap: KeyMap } | null;
  /** The last thing worth telling the person (a refused key); cleared by the next accepted one. */
  note: RemapNote | null;
}

export type PressResult = "ignored" | "reserved" | "bound" | "asks" | "cancelled";

export interface RemapSession {
  readonly state: RemapState;
  /** Starts listening for `buttons` one after the other (a d-pad is four). */
  begin(buttons: readonly PadButton[]): void;
  /** A key went down while listening. */
  press(code: string): PressResult;
  /** Esc: stops listening, keeps what was already bound. */
  cancel(): void;
  confirmSwap(): void;
  declineSwap(): void;
  /** Voltar ao padrao: the shown console only. */
  reset(): void;
  setPlatform(platform: Platform): void;
}

export interface RemapOptions {
  platform?: Platform;
  maps?: Keymaps;
  /** After any change to the state (the view redraws) */
  onChange?: (state: RemapState) => void;
  /** After a map changed (persist it, hand it to the runtime). */
  onMap?: (platform: Platform, map: KeyMap) => void;
}

export function createRemapSession(options: RemapOptions = {}): RemapSession {
  let state: RemapState = {
    platform: options.platform ?? "nes",
    maps: options.maps ?? defaultKeymaps(),
    queue: [],
    pending: null,
    note: null,
  };

  function set(next: Partial<RemapState>) {
    state = { ...state, ...next };
    options.onChange?.(state);
  }

  function writeMap(map: KeyMap) {
    set({ maps: { ...state.maps, [state.platform]: map } });
    options.onMap?.(state.platform, map);
  }

  function advance() {
    set({ queue: state.queue.slice(1), pending: null });
  }

  return {
    get state() {
      return state;
    },
    begin(buttons) {
      const own = BUTTONS_BY_PLATFORM[state.platform];
      const queue = buttons.filter((button) => own.includes(button));
      set({ queue, pending: null, note: null });
    },
    press(code) {
      const button = state.queue[0];
      if (!button) return "ignored";
      if (state.pending) return "ignored";
      const proposal = proposeRemap(state.maps[state.platform], state.platform, button, code);
      switch (proposal.status) {
        case "ignored":
          return "ignored";
        case "reserved":
          set({ note: { kind: "reserved", code } });
          return "reserved";
        case "same":
          set({ note: null });
          advance();
          return "bound";
        case "free":
          set({ note: null });
          writeMap(proposal.map);
          advance();
          return "bound";
        case "duplicate":
          set({
            note: { kind: "duplicate", code, other: proposal.other },
            pending: { button, code, other: proposal.other, swap: proposal.swap },
          });
          return "asks";
      }
    },
    cancel() {
      if (state.queue.length === 0 && !state.pending && !state.note) return;
      set({ queue: [], pending: null, note: null });
    },
    confirmSwap() {
      const pending = state.pending;
      if (!pending) return;
      set({ note: null });
      writeMap(pending.swap);
      advance();
    },
    declineSwap() {
      // the key is still wanted by the other button: ask for another one for the same button
      if (!state.pending) return;
      set({ pending: null, note: null });
    },
    reset() {
      const map = defaultKeymap(state.platform);
      set({ queue: [], pending: null, note: null });
      writeMap(map);
    },
    setPlatform(platform) {
      if (platform === state.platform) return;
      set({ platform, queue: [], pending: null, note: null });
    },
  };
}
