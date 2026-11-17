/**
 * The computer's sound on a screen share from the MACOS desktop app.
 *
 * Unlike Linux (`linux-shell-share-audio.ts`) the shell builds no bus and the
 * sound arrives on the display stream itself: since Electron 39 Chromium
 * captures macOS system audio through Apple's CoreAudio Tap, and a request
 * with `restrictOwnAudio: true` taps everything except Chromium's own audio
 * process, which is where the call plays (`electron/lib/mac-share-audio.js`).
 * This file is the page's half: decide whether to ask at all, arm the shell,
 * and, after the picker, notice the one failure Electron cannot report.
 *
 * Three things must all be true before the page asks for sound:
 *   1. the shell says it can (`capabilities.macShareAudio`),
 *   2. the runtime flag `mac_desktop_system_audio` is on
 *      (`GET /api/share/config`), default ON (the kill switch),
 *   3. this Mac is on macOS 14.2 or newer (`macShareAudioStatus()`, only asked
 *      once 1 and 2 hold). Below that Chromium has no tap and an audio
 *      request fails the WHOLE capture, picture included.
 * Any one missing and a Mac share behaves exactly as before: video only.
 *
 * THE SILENT FAILURE. The tap is gated by the "System Audio Recording"
 * privacy permission, which no API can read. When it is missing Chromium
 * either fails the open (the capture rejects with `NotReadableError`, which
 * the shell's silent retry already turns into the same share without sound)
 * or hands over an audio track that is created `ended` and never delivers a
 * sample, with no error anywhere (Electron's `desktopCapturer` docs). The
 * second shape is what `watchMacShareAudioTrack` catches.
 */

import { fetchShareConfig, type ShareConfig } from "./api";
import { desktopShareCapabilities, getDesktop, isDesktopApp } from "./desktop";

interface Readiness {
  flag: boolean;
  supported: boolean;
}

let readiness: Readiness | null = null;
let inflight: Promise<boolean> | null = null;

/** This shell can carry the sound at all. Says nothing about the flag. */
export function shellCanOfferMacShareAudio(): boolean {
  const desktop = getDesktop();
  return (
    isDesktopApp() &&
    desktop?.platform === "darwin" &&
    desktopShareCapabilities()?.macShareAudio === true &&
    typeof desktop.macShareAudioStatus === "function" &&
    typeof desktop.macShareAudioArm === "function"
  );
}

/** The warmed answer: flag on and a Mac that can. False until warmed. */
export function macShellShareAudioReady(): boolean {
  return readiness?.flag === true && readiness.supported === true;
}

export interface MacEnsureDeps {
  shellCan: () => boolean;
  fetchConfig: () => Promise<ShareConfig>;
  status: () => Promise<{ supported: boolean } | undefined> | undefined;
}

const liveDeps: MacEnsureDeps = {
  shellCan: shellCanOfferMacShareAudio,
  fetchConfig: fetchShareConfig,
  status: () => getDesktop()?.macShareAudioStatus?.(),
};

/**
 * Warm the answer. Never throws; every failure is "no", which is the share
 * everybody on a Mac has today. The flag is fetched on every call (calls that
 * overlap share one request), because it is also the kill switch: an operator
 * turning it off must not keep offering sound. The OS version cannot change
 * under a running app, but it is one cheap local IPC, so it is asked each
 * time rather than cached.
 */
export async function ensureMacShellShareAudio(
  deps: MacEnsureDeps = liveDeps,
): Promise<boolean> {
  if (!deps.shellCan()) {
    readiness = null;
    return false;
  }
  if (!inflight) {
    inflight = (async () => {
      const config = await deps.fetchConfig().catch(() => null);
      if (config?.macDesktopSystemAudio !== true) {
        readiness = { flag: false, supported: false };
        return false;
      }
      const status = await Promise.resolve(deps.status()).catch(() => undefined);
      readiness = { flag: true, supported: status?.supported === true };
      return macShellShareAudioReady();
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export function resetMacShellShareAudioForTests(): void {
  readiness = null;
  inflight = null;
}

/**
 * Right before `getDisplayMedia`, for a share that asks for sound with the
 * flag on: tell the shell it may answer the next display request with
 * loopback. The shell answers video only without it, so a request that
 * merely carries `audioRequested` can never tap the machine's sound. Never
 * throws; a refused arm is a share with no sound.
 */
export async function armMacShellShareAudio(
  arm: () => Promise<boolean> | undefined = () => getDesktop()?.macShareAudioArm?.(),
): Promise<boolean> {
  try {
    return (await arm()) === true;
  } catch {
    return false;
  }
}

/** Opens System Settings at Privacy & Security > System Audio Recording. */
export async function openMacShareAudioSettings(): Promise<boolean> {
  try {
    return (await getDesktop()?.macShareAudioOpenSettings?.()) === true;
  } catch {
    return false;
  }
}

type SettleStream = {
  getAudioTracks(): readonly (WatchedTrack & { stop(): void })[];
  removeTrack(track: never): void;
};

/**
 * Right after `getDisplayMedia` on a Mac share that asked for sound.
 *
 * A track that is already `ended` is the documented dead stream: it is taken
 * off the stream before anything publishes it (a dead track in a publish is
 * an error and a silent tile either way) and `onDead` fires. A live track is
 * watched for a short window, because the `ended` can land just after the
 * promise resolves; if it does, `onDead` fires then and the track is left to
 * the stream's own handling of an ended track. Returns a disposer that stops
 * the watching.
 */
export function settleMacShareAudio(
  stream: SettleStream,
  onDead: () => void,
  windowMs: number = MAC_AUDIO_DEAD_WINDOW_MS,
): () => void {
  const tracks = stream.getAudioTracks();
  const dead = tracks.filter((track) => track.readyState === "ended");
  if (dead.length > 0) {
    for (const track of dead) {
      stream.removeTrack(track as never);
      track.stop();
    }
    onDead();
    return () => {};
  }
  const disposers = tracks.map((track) => watchMacShareAudioTrack(track, onDead, windowMs));
  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}

/**
 * How long a fresh audio track gets to prove it is alive. The dead stream is
 * created `ended`, so the answer is normally immediate; the wait only covers
 * an `ended` event that lands a moment after resolve.
 */
export const MAC_AUDIO_DEAD_WINDOW_MS = 2500;

type WatchedTrack = {
  readyState: string;
  addEventListener(type: "ended", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener?(type: "ended", listener: () => void): void;
};

/**
 * Calls `onDead` once when a system-audio track is, or within
 * `MAC_AUDIO_DEAD_WINDOW_MS` becomes, `ended`. After that window an `ended`
 * track is a share that stopped on purpose or a device that went away, which
 * is not a permission problem, so it is left alone. Returns a disposer.
 *
 * What it cannot catch: a track that is `live` and silent. That is also what
 * a Mac playing nothing looks like, and telling the two apart would mean
 * reading samples and calling every quiet moment a failure.
 */
export function watchMacShareAudioTrack(
  track: WatchedTrack | undefined,
  onDead: () => void,
  windowMs: number = MAC_AUDIO_DEAD_WINDOW_MS,
): () => void {
  if (!track) {
    return () => {};
  }
  if (track.readyState === "ended") {
    onDead();
    return () => {};
  }
  let settled = false;
  const fire = () => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    onDead();
  };
  const timer = setTimeout(() => {
    settled = true;
    track.removeEventListener?.("ended", fire);
  }, windowMs);
  track.addEventListener("ended", fire, { once: true });
  return () => {
    settled = true;
    clearTimeout(timer);
    track.removeEventListener?.("ended", fire);
  };
}
