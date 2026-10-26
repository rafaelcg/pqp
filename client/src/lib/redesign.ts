import { useSyncExternalStore } from "react";

/**
 * The redesign toggle (docs/redesign/LOG.md). On, `<html>` carries
 * `data-redesign` and the `redesign:` Tailwind variant in `index.css` applies,
 * so every redesigned element draws its new look. Off, nothing differs from
 * before: the attribute is absent and no `redesign:` class matches.
 *
 * Who decides, strongest first:
 *
 * 1. `?redesign=1` or `?redesign=0` on the URL, for this page only. It is how
 *    the design council capture photographs both looks of one build.
 * 2. The person's own choice, Settings > Beta > Novo visual, kept on this
 *    device under `pqp-redesign` ("on" or "off"). The boot script in
 *    `index.html` reads the same key, so a chosen look paints on the first
 *    frame with no flash.
 * 3. The runtime flag `redesign` (global, default off), served as `redesign`
 *    on `GET /api/onboarding/config` and applied by `lib/hint-config.ts` with
 *    the other switches that route carries. It is the default for people who
 *    never chose, which is how the new look is eventually rolled out.
 */

export const REDESIGN_STORAGE_KEY = "pqp-redesign";
const URL_PARAM = "redesign";

type Choice = "on" | "off" | null;

let flagDefault = false;
const listeners = new Set<() => void>();

function readUrlOverride(): Choice {
  try {
    const value = new URLSearchParams(window.location.search).get(URL_PARAM);
    if (value === "1" || value === "on") {
      return "on";
    }
    if (value === "0" || value === "off") {
      return "off";
    }
  } catch {
    // No window (tests without a DOM): no override.
  }
  return null;
}

export function readRedesignChoice(): Choice {
  try {
    const raw = localStorage.getItem(REDESIGN_STORAGE_KEY);
    return raw === "on" || raw === "off" ? raw : null;
  } catch {
    // Safari private mode throws on storage access.
    return null;
  }
}

export function isRedesignOn(): boolean {
  const override = readUrlOverride();
  if (override) {
    return override === "on";
  }
  const choice = readRedesignChoice();
  if (choice) {
    return choice === "on";
  }
  return flagDefault;
}

/** Puts the attribute on `<html>` to match `isRedesignOn`. */
export function applyRedesign(): void {
  const root = document.documentElement;
  if (isRedesignOn()) {
    root.dataset.redesign = "";
  } else {
    delete root.dataset.redesign;
  }
}

function changed(): void {
  applyRedesign();
  for (const listener of [...listeners]) {
    listener();
  }
}

/** The person's switch in Settings > Beta. */
export function setRedesignChoice(on: boolean): void {
  try {
    localStorage.setItem(REDESIGN_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // The page still switches; it just will not remember.
  }
  changed();
}

/** The runtime flag's answer, from `GET /api/onboarding/config`. */
export function setRedesignFlag(on: boolean): void {
  if (on === flagDefault) {
    return;
  }
  flagDefault = on;
  changed();
}

/** Reads `redesign` off a config answer. Anything but `true` is off. */
export function redesignFromConfig(answer: { redesign?: unknown }): boolean {
  return answer.redesign === true;
}

/** For the few components whose markup, not just their classes, differs. */
export function useRedesign(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isRedesignOn,
    () => false,
  );
}

/** Test seam. */
export function resetRedesignForTests(): void {
  flagDefault = false;
  listeners.clear();
}
