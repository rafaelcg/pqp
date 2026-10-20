import { defaultKeymaps, parseKeymaps, type Keymaps } from "./keymap";
import { DEFAULT_SETTINGS, type AspectMode, type ScaleMode, type StageSettings } from "./stage";
import type { DeviceStore } from "./store";
import { clampTurboRatio, DEFAULT_TURBO_RATIO } from "./turbo";

/**
 * What a person set up and would miss: their keys, how the picture is drawn,
 * the autosave switch. One JSON row of the device store (`prefs`, SPEC 9),
 * read once at the start and written a moment after each change.
 *
 * It is read the way every row of the store is: as something the person owns
 * but the code does not trust. A row that is not an object, or a field that is
 * not what it should be, falls back to the default for that field only, so a
 * half-bad row never costs the person the half that was good.
 */
export const PREFS_KEY = "prefs";
/** How long a change waits for a second one before it is written. */
export const PREFS_WRITE_DELAY_MS = 400;

export interface Prefs {
  keymaps: Keymaps;
  /** The rolling autosave (SPEC 4.5): on unless the person turned it off. */
  autosave: boolean;
  stage: StageSettings;
  /** The sound switch (`M`): kept so a person who muted is not blasted by the next game. */
  muted: boolean;
  /** The turbo's speed, 1 to 10 in half steps: what the button and the held key run at. */
  turboRatio: number;
}

export function defaultPrefs(): Prefs {
  return { keymaps: defaultKeymaps(), autosave: true, stage: { ...DEFAULT_SETTINGS }, muted: false, turboRatio: DEFAULT_TURBO_RATIO };
}

const SCALES: readonly (ScaleMode | null)[] = ["pixel", "fit", null];
const ASPECTS: readonly AspectMode[] = ["square", "tv"];

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function parseStageSettings(raw: unknown): StageSettings {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const scale = SCALES.includes(record.scale as ScaleMode | null) ? (record.scale as ScaleMode | null) : DEFAULT_SETTINGS.scale;
  const aspect = ASPECTS.includes(record.aspect as AspectMode) ? (record.aspect as AspectMode) : DEFAULT_SETTINGS.aspect;
  return {
    scale,
    aspect,
    crt: bool(record.crt, DEFAULT_SETTINGS.crt),
    ambient: bool(record.ambient, DEFAULT_SETTINGS.ambient),
    bezel: bool(record.bezel, DEFAULT_SETTINGS.bezel),
  };
}

export function parsePrefs(raw: unknown): Prefs {
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    keymaps: parseKeymaps(record.keymaps),
    autosave: bool(record.autosave, true),
    stage: parseStageSettings(record.stage),
    muted: bool(record.muted, false),
    turboRatio: clampTurboRatio(record.turboRatio),
  };
}

export async function loadPrefs(store: DeviceStore): Promise<Prefs> {
  try {
    const row = await store.get(PREFS_KEY);
    if (!row) return defaultPrefs();
    return parsePrefs(JSON.parse(new TextDecoder().decode(row.bytes)));
  } catch {
    // an unreadable row or an unreachable store: the defaults are a fine day
    return defaultPrefs();
  }
}

export async function savePrefs(store: DeviceStore, prefs: Prefs): Promise<void> {
  try {
    await store.put(PREFS_KEY, new TextEncoder().encode(JSON.stringify(prefs)));
  } catch {
    // a full or refusing store only means the next visit starts from the defaults
  }
}

export interface PrefsKeeper {
  readonly prefs: Prefs;
  /** Changes some of the prefs and schedules the write. */
  update(patch: Partial<Prefs>): void;
  /** Writes now, if anything is waiting. */
  flush(): Promise<void>;
}

/** The prefs in memory plus the debounced write behind them. */
export function createPrefsKeeper(store: DeviceStore, initial: Prefs, delayMs: number = PREFS_WRITE_DELAY_MS): PrefsKeeper {
  let current = initial;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  async function write(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (!dirty) return;
    dirty = false;
    await savePrefs(store, current);
  }
  return {
    get prefs() {
      return current;
    },
    update(patch) {
      current = { ...current, ...patch };
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(() => void write(), delayMs);
    },
    flush: write,
  };
}
