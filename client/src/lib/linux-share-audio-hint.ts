import {
  detectPlatform,
  readPlatformSignals,
  type PlatformSignals,
} from "./downloads";
import {
  HINTS_PERSIST_OVERRIDE_KEY,
  isHintSeen,
  rememberHint,
  shouldPersistHints,
} from "./hints";

/**
 * "Does screen share carry sound on Linux?" A Linux user on Chrome 154 / X11,
 * then on the Electron app, could not tell, and the honest answer is
 * platform-shaped, not a bug:
 *
 * - In a BROWSER, Chromium on Linux only ever attaches sound to a **tab**
 *   share ("Also share tab audio"). `systemAudio` on a window or the whole
 *   screen is a checkbox Chromium shows and then silently refuses on Linux;
 *   `voice.error.shareAudioUnavailable` already says this for the case where
 *   the picked surface came back with no audio track. This hint says it
 *   BEFORE the picker, where the question actually gets asked.
 * - In the DESKTOP SHELL, sound over `getDisplayMedia` is Windows-only in
 *   Chromium (WASAPI loopback). `electron/lib/display-sources.js` is
 *   deliberately video-only on Linux (and macOS): there is no tab to fall
 *   back to inside Electron's picker, so a Linux desktop share never carries
 *   the computer's sound, full stop. The browser is the only route to sound.
 *
 * Persistence rides `lib/hints.ts` (one store, localhost never persists
 * unless `HINTS_PERSIST_OVERRIDE_KEY` is set), same as `cinema-hint.ts`.
 */

export const LINUX_SHARE_AUDIO_HINT_STORAGE_KEY =
  "pqp:linux-share-audio-hint-2026-09";

export { HINTS_PERSIST_OVERRIDE_KEY };

export function linuxShareAudioHintPersists(
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
  hostname?: string,
): boolean {
  return shouldPersistHints(hostname, storage);
}

export function isLinuxShareAudioHintSeen(
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
  persist: boolean = linuxShareAudioHintPersists(storage),
): boolean {
  return isHintSeen(LINUX_SHARE_AUDIO_HINT_STORAGE_KEY, storage, persist);
}

export function rememberLinuxShareAudioHint(
  storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage(),
  persist: boolean = linuxShareAudioHintPersists(storage),
): void {
  rememberHint(LINUX_SHARE_AUDIO_HINT_STORAGE_KEY, storage, persist);
}

/**
 * `detectPlatform` already rules Android out before Linux (Android's UA also
 * says "Linux") and handles the `userAgentData.platform` fast path, so this
 * is a thin wrapper rather than a second sniff.
 */
export function isLinuxPlatform(
  signals: PlatformSignals = readPlatformSignals(),
): boolean {
  return detectPlatform(signals) === "linux";
}

export interface LinuxShareAudioHintAudience {
  linux: boolean;
  seen: boolean;
}

export function readLinuxShareAudioHintAudience(
  input: Partial<LinuxShareAudioHintAudience> = {},
): LinuxShareAudioHintAudience {
  return {
    linux: input.linux ?? isLinuxPlatform(),
    seen: input.seen ?? isLinuxShareAudioHintSeen(),
  };
}

/**
 * Linux, not yet dismissed. Every other platform already gets a straight
 * answer from the OS picker itself (Windows) or has no whole-screen system
 * audio to promise in the first place (mac, mobile has no `getDisplayMedia`
 * at all), so this never renders there.
 */
export function shouldShowLinuxShareAudioHint(
  audience: LinuxShareAudioHintAudience = readLinuxShareAudioHintAudience(),
): boolean {
  return audience.linux && !audience.seen;
}

/**
 * Same eligibility, for the reactive trigger: a share that just started on
 * Linux with literally no audio track. Sharing the `seen` flag with the
 * proactive hint above means dismissing either one keeps it gone. This is
 * one hint with two doors in, not two hints.
 */
export function shouldShowLinuxShareAudioNoticeForStartedShare(input: {
  linux: boolean;
  seen: boolean;
  hasAudio: boolean;
}): boolean {
  return input.linux && !input.seen && !input.hasAudio;
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
