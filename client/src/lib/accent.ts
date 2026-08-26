/**
 * Accent hue preference and the DOM attributes the stylesheet keys off.
 *
 * This is a fourth axis: it retints accent tokens on top of the named look.
 * Own storage key so the boot script can set `--accent-hue` before paint.
 */

import type { AccentHuePreference, AppearancePreference } from "@pqp/shared";
import { oklchToRgb, parseOklch } from "@/lib/oklch";
import { queuePreferenceSync } from "@/lib/preferences";

export type { AccentHuePreference };

export const ACCENT_HUE_STORAGE_KEY = "pqp-accent-hue";
export const DEFAULT_ACCENT_HUE: AccentHuePreference = "default";

export const APPEARANCE_ACCENT_HUE: Record<AppearancePreference, number> = {
  signal: 125,
  harmony: 255,
  hearth: 200,
  night: 125,
};

export const ACCENT_SWATCHES = [15, 80, 125, 180, 210, 255, 300, 340] as const;

export function isAccentHuePreference(
  value: unknown,
): value is AccentHuePreference {
  if (value === "default") {
    return true;
  }
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 360
  );
}

export function parseStoredAccentHue(raw: string | null): AccentHuePreference | null {
  if (raw === null || raw === "") {
    return null;
  }
  if (raw === "default") {
    return "default";
  }
  const hue = Number(raw);
  return isAccentHuePreference(hue) ? hue : null;
}

export function readStoredAccentHue(): AccentHuePreference | null {
  try {
    return parseStoredAccentHue(localStorage.getItem(ACCENT_HUE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function storeAccentHue(preference: AccentHuePreference): void {
  try {
    localStorage.setItem(ACCENT_HUE_STORAGE_KEY, String(preference));
  } catch {
    // Persistence is a convenience.
  }
}

export function effectiveAccentHue(
  preference: AccentHuePreference,
  appearance: AppearancePreference,
): number {
  return preference === "default" ? APPEARANCE_ACCENT_HUE[appearance] : preference;
}

/**
 * emoji-mart wants an sRGB triplet. Chromium echoes `oklch()` from
 * `getComputedStyle`, so an rgb() regex never matches a custom hue.
 */
export function rgbTripletFromCssColor(color: string): string | null {
  const rgb = color.match(
    /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/,
  );
  if (rgb) {
    return `${Math.round(Number(rgb[1]))}, ${Math.round(Number(rgb[2]))}, ${Math.round(Number(rgb[3]))}`;
  }
  const oklch = parseOklch(color);
  if (oklch) {
    const { r, g, b } = oklchToRgb(oklch);
    return `${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}`;
  }
  return rgbTripletFromCanvas(color);
}

function rgbTripletFromCanvas(color: string): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  try {
    const canvas = document.createElement("canvas");
    if (typeof canvas.getContext !== "function") {
      return null;
    }
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return null;
    }
    // Sentinel so an unparsed colour does not become 0, 0, 0.
    context.fillStyle = "rgb(1, 2, 3)";
    context.fillStyle = color;
    const applied = context.fillStyle.replace(/\s/g, "");
    if (applied === "rgb(1,2,3)" || applied === "#010203") {
      return null;
    }
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    if (r === undefined || g === undefined || b === undefined) {
      return null;
    }
    return `${r}, ${g}, ${b}`;
  } catch {
    return null;
  }
}

function syncPickerAccentRgb(): void {
  if (
    typeof document === "undefined" ||
    !document.body ||
    typeof getComputedStyle !== "function"
  ) {
    return;
  }
  const probe = document.createElement("div");
  probe.style.color = "var(--color-accent)";
  document.body.appendChild(probe);
  const triplet = rgbTripletFromCssColor(getComputedStyle(probe).color);
  probe.remove();
  if (triplet) {
    document.documentElement.style.setProperty("--rgb-picker-accent", triplet);
  }
}

function schedulePickerAccentRgb(): void {
  if (typeof document === "undefined") {
    return;
  }
  const run = () => {
    syncPickerAccentRgb();
  };
  if (!document.body) {
    document.addEventListener("DOMContentLoaded", run, { once: true });
    return;
  }
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(run);
    return;
  }
  run();
}

export function applyAccentHue(preference: AccentHuePreference): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  if (preference === "default") {
    delete root.dataset.accent;
    root.style.removeProperty("--accent-hue");
    root.style.removeProperty("--rgb-picker-accent");
    return;
  }
  root.dataset.accent = "custom";
  root.style.setProperty("--accent-hue", String(preference));
  // The stylesheet has to apply first; the picker reads a computed rgb triplet.
  schedulePickerAccentRgb();
}

const listeners = new Set<() => void>();

let state: AccentHuePreference = readStoredAccentHue() ?? DEFAULT_ACCENT_HUE;

/**
 * Finish what the boot script started.
 *
 * `index.html` can already have `data-accent="custom"` and `--accent-hue` on
 * the root. Calling `applyAccentHue` again is unnecessary; the emoji picker's
 * `--rgb-picker-accent` probe still has to run. Call this on load whenever a
 * custom hue is already on the document or only in storage.
 */
export function hydrateAccentHue(): void {
  if (typeof document === "undefined" || state === "default") {
    return;
  }
  if (!document.documentElement.dataset.accent) {
    applyAccentHue(state);
    return;
  }
  if (document.documentElement.dataset.accent === "custom") {
    schedulePickerAccentRgb();
  }
}

export function getAccentHue(): AccentHuePreference {
  return state;
}

export function subscribeAccentHue(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(preference: AccentHuePreference): void {
  if (preference === state) {
    return;
  }
  state = preference;
  applyAccentHue(preference);
  for (const listener of listeners) {
    listener();
  }
}

export function setAccentHuePreference(
  preference: AccentHuePreference,
  { immediate }: { immediate?: boolean } = {},
): void {
  storeAccentHue(preference);
  commit(preference);
  // Swatches and reset are one click. The slider stays on the debounce path
  // so a drag does not spend the write budget. A reload before the debounce
  // flushes would let `/api/me` adopt the previous `default` and undo the pick.
  queuePreferenceSync(
    { accentHue: preference },
    { immediate: immediate ?? preference === "default" },
  );
}

export function adoptAccentHuePreference(preference: AccentHuePreference): void {
  storeAccentHue(preference);
  commit(preference);
}

if (typeof document !== "undefined") {
  hydrateAccentHue();
}
