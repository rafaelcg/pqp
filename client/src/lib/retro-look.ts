/**
 * Modo 2005: discovery, the kill switch and the look's own little settings.
 *
 * The look itself is an entry on the appearance axis (`appearance.ts`, see
 * `Look`). This module is everything around it that has to be in the main
 * bundle, because it decides whether the lazy chunk is ever loaded:
 *
 *  - DISCOVERY. `/2005` in any composer or the Konami code. The first time
 *    writes `pqp-retro-found` (an ISO date), which is what puts the tile in
 *    Aparência and the command in the slash menu. Local to this browser for
 *    now; see the note on `Look` for why nothing here is synced yet.
 *  - THE KILL SWITCH. `retro_look` on the server, answered by
 *    `GET /api/fun/config` as `{ retroLook }`. Asked only by a browser that
 *    found the look (or is trying to), so nobody else pays a request. An
 *    answer of `false` paints the look underneath and hides the tile and the
 *    command; a server that does not have the route yet (404) counts as on.
 *  - SETTINGS. "Sons do Modo 2005" and "Avisar quando amigo entrar", both on
 *    by default and local.
 */

import type { UserStatus } from "@pqp/shared";
import { useSyncExternalStore } from "react";
import {
  isRetroLookAvailable,
  isRetroLookOn,
  RETRO_STORAGE_KEY,
  setRetroLook,
  setRetroLookAvailable,
  subscribeAppearance,
} from "@/lib/appearance";
import { ApiError, apiFetch } from "@/lib/api";
import { onConfigRefresh } from "@/lib/config-refresh";
import type { MessageKey } from "@/lib/i18n";

export const RETRO_FOUND_KEY = "pqp-retro-found";
export const RETRO_SOUNDS_KEY = "pqp-retro-sounds";
export const RETRO_TOASTS_KEY = "pqp-retro-toasts";
/** How long the tile in Aparência wears its "novo" tag after the find. */
export const RETRO_NEW_BADGE_MS = 14 * 24 * 60 * 60 * 1000;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // A convenience; the session still works.
  }
}

// ------------------------------------------------------------ the snapshot

export interface RetroState {
  /** When this browser first found the look, or null. */
  foundAt: string | null;
  /** The operator has not switched it off. */
  available: boolean;
  on: boolean;
  sounds: boolean;
  toasts: boolean;
  /** The "Tu achou o Modo 2005!" card is owed. Set by a first find only. */
  foundCardPending: boolean;
}

const listeners = new Set<() => void>();
let foundCardPending = false;
let soundsOverride: boolean | null = null;
let toastsOverride: boolean | null = null;
let snapshot: RetroState = buildSnapshot();

function buildSnapshot(): RetroState {
  return {
    foundAt: read(RETRO_FOUND_KEY),
    available: isRetroLookAvailable(),
    on: isRetroLookOn(),
    sounds: soundsOverride ?? read(RETRO_SOUNDS_KEY) !== "0",
    toasts: toastsOverride ?? read(RETRO_TOASTS_KEY) !== "0",
    foundCardPending,
  };
}

function changed(): void {
  snapshot = buildSnapshot();
  for (const listener of listeners) {
    listener();
  }
}

// Picking another look in Aparência turns Modo 2005 off from `appearance.ts`.
subscribeAppearance(changed);

export function getRetroState(): RetroState {
  return snapshot;
}

export function subscribeRetroState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the tile and the command are offered at all. */
export function isRetroOffered(state: RetroState = snapshot): boolean {
  return state.available && (state.foundAt !== null || state.on);
}

/** The tile's "novo" tag: for a couple of weeks after the find. */
export function isRetroNew(
  state: RetroState = snapshot,
  now: number = Date.now(),
): boolean {
  if (!state.foundAt) {
    return false;
  }
  const at = Date.parse(state.foundAt);
  return Number.isFinite(at) && now - at < RETRO_NEW_BADGE_MS;
}

export function setRetroSounds(on: boolean): void {
  // Held in memory too, so the switch sticks for this page even when the
  // browser refuses the write (private mode, full storage).
  soundsOverride = on;
  write(RETRO_SOUNDS_KEY, on ? null : "0");
  changed();
}

export function setRetroToasts(on: boolean): void {
  toastsOverride = on;
  write(RETRO_TOASTS_KEY, on ? null : "0");
  changed();
}

export function dismissRetroFoundCard(): void {
  foundCardPending = false;
  changed();
}

/** From the Aparência tile: turns it on without the discovery card. */
export async function chooseRetroLook(): Promise<void> {
  await preloadChunk().catch(() => {});
  await switchWithTransition(() => {
    if (!read(RETRO_FOUND_KEY)) {
      write(RETRO_FOUND_KEY, new Date().toISOString());
    }
    setRetroLook(true);
    changed();
  });
}

/** Off, from anywhere (the card's Desfazer, the slash command). */
export function leaveRetroLook(): void {
  foundCardPending = false;
  setRetroLook(false);
  changed();
}

/** For a component: the snapshot, re-rendered on every change. */
export function useRetroState(): RetroState {
  return useSyncExternalStore(subscribeRetroState, getRetroState, getRetroState);
}

// ------------------------------------------------------------ kill switch

let probe: Promise<boolean> | null = null;
/** Bumped per request: only the newest answer may move the switch. */
let probeGeneration = 0;

async function askServer(): Promise<boolean> {
  try {
    const config = await apiFetch<{ retroLook?: unknown }>("/api/fun/config");
    return config.retroLook !== false;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      // A server that predates the switch: nothing has been switched off.
      return true;
    }
    // Unreachable: keep whatever this browser last heard.
    return isRetroLookAvailable();
  }
}

/** Ask once per page (and again on every config refresh pass). */
export function ensureRetroLookFlag(): Promise<boolean> {
  if (!probe) {
    const generation = ++probeGeneration;
    probe = askServer().then((available) => {
      // A slower, older answer must not undo a newer one.
      if (generation !== probeGeneration) {
        return isRetroLookAvailable();
      }
      setRetroLookAvailable(available);
      changed();
      return available;
    });
  }
  return probe;
}

/**
 * For the app shell: re-ask on the config refresh cadence, but only in a
 * browser that has found the look. Everyone else never sends the request.
 */
export function startRetroLookFlag(): () => void {
  const relevant = () =>
    read(RETRO_FOUND_KEY) !== null || read(RETRO_STORAGE_KEY) === "1";
  if (relevant()) {
    void ensureRetroLookFlag();
  }
  return onConfigRefresh(() => {
    if (relevant()) {
      probe = null;
      void ensureRetroLookFlag();
    }
  });
}

// ------------------------------------------------------------ the moment

/**
 * The look's own chunk (its stylesheet included), fetched before the switch
 * so the new skin arrives whole instead of in two steps. Swappable for tests.
 */
let preloadChunk: () => Promise<unknown> = () =>
  import("@/components/retro/retro-chunk");

export function setRetroChunkLoaderForTests(loader: () => Promise<unknown>): void {
  preloadChunk = loader;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => Promise<void> | void) => {
    finished: Promise<void>;
  };
};

/**
 * Switching the look in or out as one moment: the browser's view transition
 * cross-fades the old skin away while the new one rises in (opacity and
 * transform only, `index.css` `[data-look-transition]`). No transition API, or
 * reduced motion asked for: the switch is instant, which is the whole fallback.
 */
async function switchWithTransition(update: () => void): Promise<void> {
  const doc = typeof document === "undefined" ? null : (document as ViewTransitionDocument);
  if (!doc?.startViewTransition || prefersReducedMotion()) {
    update();
    return;
  }
  const root = doc.documentElement;
  root.dataset.lookTransition = "";
  try {
    const transition = doc.startViewTransition(
      () =>
        new Promise<void>((resolve) => {
          update();
          // Two frames: React commits the new structure (the contact list,
          // the window) before the "after" picture is taken.
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await transition.finished.catch(() => {});
  } finally {
    delete root.dataset.lookTransition;
  }
}

// ------------------------------------------------------------ discovery

export type RetroToggleResult = "found" | "on" | "off" | "unavailable";

let toggling: Promise<RetroToggleResult> = Promise.resolve("off");

/**
 * `/2005` and the Konami code. Same toggle, same card on the first find.
 * Serialized: a second toggle while the first is still fetching the chunk
 * waits for it, so two quick toggles land on and then off, not on twice.
 */
export function toggleRetroLook(): Promise<RetroToggleResult> {
  toggling = toggling.catch(() => "off" as const).then(toggleOnce);
  return toggling;
}

async function toggleOnce(): Promise<RetroToggleResult> {
  const available = await ensureRetroLookFlag();
  if (!available) {
    return "unavailable";
  }
  if (isRetroLookOn()) {
    await switchWithTransition(leaveRetroLook);
    return "off";
  }
  const first = read(RETRO_FOUND_KEY) === null;
  // A failed fetch only costs the transition; the lazy components retry.
  await preloadChunk().catch(() => {});
  await switchWithTransition(() => {
    if (first) {
      write(RETRO_FOUND_KEY, new Date().toISOString());
      foundCardPending = true;
    }
    setRetroLook(true);
    changed();
  });
  return first ? "found" : "on";
}

// ------------------------------------------------------------ status names

/** The status names of the era. Only the labels move; the wire is unchanged. */
export function retroStatusKey(status: UserStatus | "invisible"): MessageKey {
  switch (status) {
    case "online":
      return "retro.status.online";
    case "idle":
      return "retro.status.idle";
    case "dnd":
      return "retro.status.dnd";
    case "invisible":
      return "retro.status.invisible";
    default:
      return "retro.status.offline";
  }
}

/** Tests only. */
export function resetRetroLookForTests(): void {
  probe = null;
  toggling = Promise.resolve("off");
  soundsOverride = null;
  toastsOverride = null;
  foundCardPending = false;
  snapshot = buildSnapshot();
}
