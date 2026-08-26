/**
 * Contrast preference and the DOM attribute the stylesheet keys off.
 *
 * This is an accessibility axis, not a fourth appearance. It stacks on
 * Signal / Harmony / Hearth and on light / dark. Own storage key so the boot
 * script can resolve it before the bundle loads.
 */

import type { ContrastPreference } from "@pqp/shared";
import { queuePreferenceSync } from "@/lib/preferences";

export type { ContrastPreference };
export type ResolvedContrast = "default" | "more";

export const CONTRAST_STORAGE_KEY = "pqp-contrast";

const MORE_QUERY = "(prefers-contrast: more)";

export interface ContrastState {
  preference: ContrastPreference;
  resolved: ResolvedContrast;
}

function isPreference(value: string | null): value is ContrastPreference {
  return value === "default" || value === "more" || value === "system";
}

export function readStoredContrast(): ContrastPreference | null {
  try {
    const raw = localStorage.getItem(CONTRAST_STORAGE_KEY);
    return isPreference(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function storeContrast(preference: ContrastPreference): void {
  try {
    localStorage.setItem(CONTRAST_STORAGE_KEY, preference);
  } catch {
    // Persistence is a convenience.
  }
}

export function prefersMoreContrastQuery(): MediaQueryList | null {
  try {
    return window.matchMedia(MORE_QUERY);
  } catch {
    return null;
  }
}

export function systemContrast(): ResolvedContrast {
  const query = prefersMoreContrastQuery();
  if (query === null) {
    return "default";
  }
  return query.matches ? "more" : "default";
}

export function resolveContrast(preference: ContrastPreference): ResolvedContrast {
  return preference === "system" ? systemContrast() : preference;
}

export function applyContrast(resolved: ResolvedContrast): void {
  if (typeof document === "undefined") {
    return;
  }
  if (resolved === "more") {
    document.documentElement.dataset.contrast = "more";
  } else {
    delete document.documentElement.dataset.contrast;
  }
}

const listeners = new Set<() => void>();

const initialPreference = readStoredContrast() ?? "system";
let state: ContrastState = {
  preference: initialPreference,
  resolved: resolveContrast(initialPreference),
};

export function getContrastState(): ContrastState {
  return state;
}

export function subscribeContrast(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(preference: ContrastPreference): void {
  const resolved = resolveContrast(preference);
  if (preference === state.preference && resolved === state.resolved) {
    return;
  }
  state = { preference, resolved };
  applyContrast(resolved);
  for (const listener of listeners) {
    listener();
  }
}

export function setContrastPreference(preference: ContrastPreference): void {
  storeContrast(preference);
  commit(preference);
  queuePreferenceSync({ contrast: preference }, { immediate: true });
}

export function adoptContrastPreference(preference: ContrastPreference): void {
  storeContrast(preference);
  commit(preference);
}

export function syncSystemContrast(): void {
  if (state.preference !== "system") {
    return;
  }
  commit("system");
}

function followSystemContrast(): void {
  const query = prefersMoreContrastQuery();
  query?.addEventListener("change", () => {
    syncSystemContrast();
  });
}

if (typeof document !== "undefined") {
  if (!document.documentElement.dataset.contrast && state.resolved === "more") {
    applyContrast("more");
  }
  // Must live at module scope. `useContrast` only mounts inside Settings, and
  // `system` is the default, so an OS "Increase contrast" flip would otherwise
  // apply only while that modal is open (or at the next reload).
  followSystemContrast();
}
