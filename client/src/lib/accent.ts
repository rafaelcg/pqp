/**
 * Accent hue preference and the DOM attributes the stylesheet keys off.
 *
 * This is a fourth axis: it retints accent tokens on top of the named look.
 * Own storage key so the boot script can set `--accent-hue` before paint.
 */

import type { AccentHuePreference, AppearancePreference } from "@pqp/shared";
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

function syncPickerAccentRgb(): void {
  if (typeof document === "undefined" || !document.body) {
    return;
  }
  const probe = document.createElement("div");
  probe.style.color = "var(--color-accent)";
  document.body.appendChild(probe);
  const match = getComputedStyle(probe).color.match(
    /(\d+)[,\s]+(\d+)[,\s]+(\d+)/,
  );
  probe.remove();
  if (match) {
    document.documentElement.style.setProperty(
      "--rgb-picker-accent",
      `${match[1]}, ${match[2]}, ${match[3]}`,
    );
  }
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
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(syncPickerAccentRgb);
  }
}

const listeners = new Set<() => void>();

let state: AccentHuePreference = readStoredAccentHue() ?? DEFAULT_ACCENT_HUE;

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

export function setAccentHuePreference(preference: AccentHuePreference): void {
  storeAccentHue(preference);
  commit(preference);
  queuePreferenceSync(
    { accentHue: preference },
    { immediate: preference === "default" },
  );
}

export function adoptAccentHuePreference(preference: AccentHuePreference): void {
  storeAccentHue(preference);
  commit(preference);
}

if (typeof document !== "undefined") {
  if (!document.documentElement.dataset.accent && state !== "default") {
    applyAccentHue(state);
  }
}
