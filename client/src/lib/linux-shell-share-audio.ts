/**
 * The computer's sound on a screen share from the LINUX desktop app.
 *
 * Chromium on Linux can only capture the default output's monitor, which
 * carries the call (the 23 Aug 2026 echo), and `restrictOwnAudio` does nothing
 * there. So the shell builds a bus of every app's sound except its own and
 * exposes it as an ordinary input device (`electron/lib/linux-share-audio.js`).
 * This file is the page's half: decide whether to offer it, and after the
 * picker, open that device and put its track on the share.
 *
 * Three things must all be true before the page offers the sound:
 *   1. the shell says it can build the bus (`capabilities.linuxShareAudio`),
 *   2. the runtime flag `linux_desktop_system_audio` is on
 *      (`GET /api/share/config`), default off,
 *   3. this machine has a sound server `pactl` can reach
 *      (`linuxShareAudioStatus()`, only asked once 1 and 2 hold).
 * Any one missing and the Linux shell behaves exactly as before: a share with
 * no sound, and the #860 hint saying so.
 *
 * The answer is warmed before a share (`ensureLinuxShellShareAudio`, awaited
 * beside `ensureOsCanExcludeCallAudio`) and read synchronously afterwards,
 * because `liveScreenCaptureEnvironment` is synchronous.
 */

import { fetchShareConfig, type ShareConfig } from "./api";
import { desktopShareCapabilities, getDesktop, isDesktopApp } from "./desktop";

/**
 * How long "this machine has a sound server" is trusted. Only that: the
 * runtime flag is read again for every share, because it is also the kill
 * switch, and an operator turning it off must not keep offering sound for a
 * minute after.
 */
export const LINUX_SHARE_AUDIO_TTL_MS = 60_000;

interface Readiness {
  flag: boolean;
  available: boolean;
}

let readiness: Readiness | null = null;
/** The shell's last answer about the sound server, and when it gave it. */
let availability: { available: boolean; at: number } | null = null;
let inflight: Promise<boolean> | null = null;

/** This shell can build the bus at all. Says nothing about the flag. */
export function shellCanBuildLinuxShareAudio(): boolean {
  const desktop = getDesktop();
  return (
    isDesktopApp() &&
    desktop?.platform === "linux" &&
    desktopShareCapabilities()?.linuxShareAudio === true &&
    typeof desktop.linuxShareAudioStatus === "function" &&
    typeof desktop.linuxShareAudioClaim === "function"
  );
}

/** The warmed answer: flag on and a sound server there. False until warmed. */
export function linuxShellShareAudioReady(): boolean {
  return readiness?.flag === true && readiness.available === true;
}

export interface EnsureDeps {
  shellCan: () => boolean;
  fetchConfig: () => Promise<ShareConfig>;
  status: () => Promise<{ available: boolean } | undefined> | undefined;
  now: () => number;
}

const liveDeps: EnsureDeps = {
  shellCan: shellCanBuildLinuxShareAudio,
  fetchConfig: fetchShareConfig,
  status: () => getDesktop()?.linuxShareAudioStatus?.(),
  now: () => Date.now(),
};

/**
 * Warm the answer. Never throws; every failure is "no", which is the share
 * everybody on Linux has today. The flag is fetched on every call (calls that
 * overlap share one request); only the sound-server answer is cached.
 */
export async function ensureLinuxShellShareAudio(
  deps: EnsureDeps = liveDeps,
): Promise<boolean> {
  if (!deps.shellCan()) {
    readiness = null;
    availability = null;
    return false;
  }
  if (!inflight) {
    inflight = (async () => {
      const config = await deps.fetchConfig().catch(() => null);
      const flag = config?.linuxDesktopSystemAudio === true;
      if (!flag) {
        // Off: not ready now, and the shell is not asked anything (it runs
        // `pactl info`), so nothing here reaches the user's sound server.
        readiness = { flag: false, available: false };
        return false;
      }
      if (!availability || deps.now() - availability.at >= LINUX_SHARE_AUDIO_TTL_MS) {
        const status = await Promise.resolve(deps.status()).catch(() => undefined);
        availability = { available: status?.available === true, at: deps.now() };
      }
      readiness = { flag: true, available: availability.available };
      return linuxShellShareAudioReady();
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export function resetLinuxShellShareAudioForTests(): void {
  readiness = null;
  availability = null;
  inflight = null;
}

/**
 * Right before `getDisplayMedia`, for a share the person said yes to sound
 * for with the flag on: tell the shell it may build the bus for the next
 * display request. The shell builds nothing without it, so a request that
 * merely carries `audioRequested` (a console probe, a page from before this)
 * can never touch the sound server. Never throws; a refused arm is a share
 * with no sound.
 */
export async function armLinuxShellShareAudio(
  arm: () => Promise<boolean> | undefined = () => getDesktop()?.linuxShareAudioArm?.(),
): Promise<boolean> {
  try {
    return (await arm()) === true;
  } catch {
    return false;
  }
}

/** The shell's capture source among the machine's inputs, by its label. */
export function pickShareAudioInput<T extends { kind: string; label: string }>(
  devices: readonly T[],
  label: string | null,
): T | null {
  if (!label) {
    return null;
  }
  return devices.find((d) => d.kind === "audioinput" && d.label === label) ?? null;
}

/**
 * What the capture is opened with. Every voice-processing stage off, for the
 * same reason as a display capture (`screenCaptureOptions`): they exist for a
 * person talking into a laptop and chew holes in a film's soundtrack. Stereo,
 * because it is a mix of apps, not a voice.
 */
export function shareAudioInputConstraints(deviceId: string): MediaTrackConstraints {
  return {
    deviceId: { exact: deviceId },
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 2 },
  };
}

type TrackLike = {
  stop(): void;
  addEventListener?(type: "ended", listener: () => void, options?: { once?: boolean }): void;
};

type StreamLike = {
  getAudioTracks(): readonly TrackLike[];
  getVideoTracks(): readonly TrackLike[];
  addTrack(track: TrackLike): void;
};

export interface AttachDeps {
  claim: () => Promise<{ active: boolean; label: string | null } | undefined> | undefined;
  enumerate: () => Promise<readonly { kind: string; label: string; deviceId: string }[]>;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<{
    getAudioTracks(): readonly TrackLike[];
  }>;
}

const liveAttachDeps: AttachDeps = {
  claim: () => getDesktop()?.linuxShareAudioClaim?.(),
  enumerate: () => navigator.mediaDevices.enumerateDevices(),
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
};

/** The longest a share waits for the shell's capture to open. */
export const ATTACH_TIMEOUT_MS = 4_000;

export type AttachResult = "attached" | "skipped" | "unavailable";

/**
 * After the picker: open the shell's capture and put its track on the share.
 *
 * `skipped` when the stream already carries audio (the watch party setup
 * preview attached it, and the same stream is published). `unavailable` for
 * every way it can fail, which leaves a silent share, never a failed one:
 * the picture already went out and sound is the extra.
 *
 * The track is stopped with the picture, so the shell sees the capture close
 * and takes its bus down (`IDLE_AFTER_READ_MS` in the shell).
 */
export async function attachLinuxShellShareAudio(
  stream: StreamLike,
  deps: AttachDeps = liveAttachDeps,
  timeoutMs: number = ATTACH_TIMEOUT_MS,
): Promise<AttachResult> {
  if (stream.getAudioTracks().length > 0) {
    return "skipped";
  }
  // Sound is the extra, so waiting on it is bounded: a device open that never
  // answers (a stalled sound server, a permission flow) must not hold up a
  // picture that is already captured. A track that arrives after the deadline
  // is stopped, never added to a share that has moved on.
  let abandoned = false;
  const work = (async (): Promise<AttachResult> => {
    const claim = await deps.claim();
    if (!claim?.active || !claim.label) {
      return "unavailable";
    }
    const device = pickShareAudioInput(await deps.enumerate(), claim.label);
    if (!device) {
      return "unavailable";
    }
    const media = await deps.getUserMedia({
      audio: shareAudioInputConstraints(device.deviceId),
      video: false,
    });
    const track = media.getAudioTracks()[0];
    if (!track) {
      return "unavailable";
    }
    if (abandoned) {
      media.getAudioTracks().forEach((late) => late.stop());
      return "unavailable";
    }
    stream.addTrack(track);
    stream.getVideoTracks()[0]?.addEventListener?.("ended", () => track.stop(), {
      once: true,
    });
    return "attached";
  })().catch((): AttachResult => "unavailable");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<AttachResult>((resolve) => {
    timer = setTimeout(() => {
      abandoned = true;
      resolve("unavailable");
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
