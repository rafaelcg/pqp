import { useSyncExternalStore } from "react";
import { fetchGlobalVoiceConfig } from "@/lib/api";
import { onConfigRefresh } from "@/lib/config-refresh";
import {
  advancedNoiseSuppressionSupported,
  parseNoiseSuppressionMode,
  type NoiseSuppressionMode,
} from "./noise-suppression";

/**
 * Which noise suppression a device starts on when nobody on it ever chose one.
 *
 * "Voz limpa" (`advanced`, RNNoise) is the default since 2026-10-20, behind
 * the runtime flag `clean_voice_default` (global, on), which the client learns
 * as `cleanVoiceDefault` on the global `GET /api/voice/config`. See
 * `docs/NOISE_SUPPRESSION.md` §"The default".
 *
 * Three rules, in this order:
 *
 * 1. A STORED CHOICE ALWAYS WINS. Any value in storage, any mode, legacy
 *    boolean included, is somebody's setting and is never moved. Only a device
 *    with nothing stored is defaulted, and the default is never written back
 *    (`saveLocalSettings` leaves it out), so turning the flag off moves every
 *    defaulted device back with nothing to migrate.
 * 2. The flag. Unknown (not asked yet, an older API that sends no field, a
 *    failed ask before any answer) is OFF: the browser's suppressor, which is
 *    what every device had before. A failed ask after an answer keeps it.
 * 3. The device. RNNoise costs a few percent of a core on the render thread,
 *    paid on the machine least able to afford it, so the default only lands
 *    where the worklet and wasm exist (the same probe the pipeline uses, so a
 *    default never produces the "not supported" notice) and where
 *    `navigator.hardwareConcurrency` is at least `CLEAN_VOICE_MIN_CORES`. An
 *    unknown core count passes: the browsers that hide it are desktop ones.
 *    Somebody below the bar can still pick Voz limpa by hand.
 */
export const CLEAN_VOICE_MIN_CORES = 4;

export interface CleanVoiceDeviceProbe {
  /** `advancedNoiseSuppressionSupported()`: AudioWorklet and WebAssembly. */
  supported: boolean;
  /** `navigator.hardwareConcurrency`, absent or not a number when unknown. */
  cores: number | undefined;
}

export function probeCleanVoiceDevice(): CleanVoiceDeviceProbe {
  let cores: number | undefined;
  try {
    const raw =
      typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency;
    cores = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
  } catch {
    cores = undefined;
  }
  return { supported: advancedNoiseSuppressionSupported(), cores };
}

/** The conservative guard: can this device carry RNNoise by default? */
export function cleanVoiceDeviceCapable(probe: CleanVoiceDeviceProbe): boolean {
  if (!probe.supported) {
    return false;
  }
  return probe.cores === undefined || probe.cores >= CLEAN_VOICE_MIN_CORES;
}

/** The default for a device that never chose. */
export function defaultNoiseSuppressionMode(input: {
  flagOn: boolean;
  capable: boolean;
}): NoiseSuppressionMode {
  return input.flagOn && input.capable ? "advanced" : "browser";
}

/**
 * A raw persisted value (anything `localStorage` ever held under
 * `micProcessing.noiseSuppression`) against the current default.
 *
 * `undefined` / `null` is "nothing stored" and the only case that takes the
 * default. Everything else is a choice: `"off" | "browser" | "advanced"`, the
 * legacy `true` / `false`, and garbage, which `parseNoiseSuppressionMode`
 * reads as `browser` the way it always did. The legacy `true` cannot be told
 * apart from somebody who ticked the box, so it is treated as one.
 */
export function resolveNoiseSuppression(input: {
  stored: unknown;
  defaultMode: NoiseSuppressionMode;
}): { mode: NoiseSuppressionMode; chosen: boolean } {
  if (input.stored === undefined || input.stored === null) {
    return { mode: input.defaultMode, chosen: false };
  }
  return { mode: parseNoiseSuppressionMode(input.stored), chosen: true };
}

// ------------------------------------------------------------ the flag

let flagOn = false;
let asked = 0;
let applied = 0;
let capableCache: boolean | null = null;
const listeners = new Set<() => void>();

function deviceCapable(): boolean {
  if (capableCache === null) {
    capableCache = cleanVoiceDeviceCapable(probeCleanVoiceDevice());
  }
  return capableCache;
}

function setFlag(next: boolean): void {
  if (next === flagOn) {
    return;
  }
  flagOn = next;
  for (const listener of listeners) {
    listener();
  }
}

/** What a device with no stored choice runs, right now. */
export function currentDefaultNoiseSuppression(): NoiseSuppressionMode {
  return defaultNoiseSuppressionMode({ flagOn, capable: deviceCapable() });
}

export async function loadCleanVoiceDefaultFlag(): Promise<void> {
  asked += 1;
  const mine = asked;
  try {
    const answer = await fetchGlobalVoiceConfig();
    if (mine > applied) {
      applied = mine;
      setFlag(answer.cleanVoiceDefault === true);
    }
  } catch {
    // An older API or a network blip: keep what was there.
  }
}

/** Ask now and on every config refresh. Returns the teardown. */
export function startCleanVoiceDefaultFlag(): () => void {
  void loadCleanVoiceDefaultFlag();
  const stop = onConfigRefresh(() => {
    void loadCleanVoiceDefaultFlag();
  });
  return () => {
    stop();
    asked += 1;
    applied = asked;
    setFlag(false);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current default as React state; re-renders when the flag moves. */
export function useCleanVoiceDefaultMode(): NoiseSuppressionMode {
  return useSyncExternalStore(
    subscribe,
    currentDefaultNoiseSuppression,
    currentDefaultNoiseSuppression,
  );
}

/** Test seam. */
export function setCleanVoiceDefaultForTests(input: {
  flagOn?: boolean;
  capable?: boolean | null;
}): void {
  if (input.capable !== undefined) {
    capableCache = input.capable;
  }
  if (input.flagOn !== undefined) {
    setFlag(input.flagOn);
  }
}
