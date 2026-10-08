import {
  browserNoiseSuppression,
  type NoiseSuppressionMode,
} from "./noise-suppression";

export interface MediaDeviceOption {
  deviceId: string;
  label: string;
}

export function supportsAudioOutputSelection(): boolean {
  return (
    typeof HTMLMediaElement !== "undefined" &&
    "setSinkId" in HTMLMediaElement.prototype
  );
}

/**
 * What opening the microphone came to:
 * - `granted`: it opened (and was closed again).
 * - `denied`: the person or the browser said no. The only case that is about
 *   permission, so the only one "Permitir microfone" can fix.
 * - `none`: this machine has no microphone to open.
 * - `busy`: there is one and it would not start, usually because another app
 *   holds it.
 */
export type MicProbe = "granted" | "denied" | "none" | "busy";

/**
 * Tells a refusal from a missing or busy microphone by the error's name. An
 * error with no name we know is read as a refusal, which is what every failure
 * was read as before the names were told apart.
 */
export function classifyMicError(error: unknown): Exclude<MicProbe, "granted"> {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name: unknown }).name)
      : "";
  switch (name) {
    case "NotFoundError":
    case "OverconstrainedError":
    case "DevicesNotFoundError":
      return "none";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "busy";
    default:
      return "denied";
  }
}

export async function probeMicrophone(): Promise<MicProbe> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    for (const track of stream.getTracks()) {
      track.stop();
    }
    return "granted";
  } catch (error) {
    return classifyMicError(error);
  }
}

export async function ensureMediaPermission(): Promise<boolean> {
  return (await probeMicrophone()) === "granted";
}

/**
 * Whether the browser already shows microphone names, which it does only once
 * the microphone was allowed (or is open right now). Then a list can be read
 * without opening a capture of its own. Reads the raw list: `listAudioDevices`
 * fills blank names in, which would answer yes to everything.
 */
export async function microphoneLabelsReadable(): Promise<boolean> {
  try {
    const devices = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
    return devices.some((device) => device.kind === "audioinput" && device.label !== "");
  } catch {
    return false;
  }
}

let micTestRunning = false;

/**
 * Set while Voz's "Ouvir meu microfone" holds the microphone. The shell reads
 * it before it probes the microphone for a device list, because a second
 * capture of the default microphone can mute the first on Safari.
 */
export function setMicTestRunning(running: boolean): void {
  micTestRunning = running;
}

export function isMicTestRunning(): boolean {
  return micTestRunning;
}

/** Same job as the mic prompt, for webcam labels. */
export async function ensureCameraPermission(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: true,
    });
    for (const track of stream.getTracks()) {
      track.stop();
    }
    return true;
  } catch {
    return false;
  }
}

export async function listAudioDevices(): Promise<{
  inputs: MediaDeviceOption[];
  outputs: MediaDeviceOption[];
  cameras: MediaDeviceOption[];
}> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { inputs: [], outputs: [], cameras: [] };
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs: MediaDeviceOption[] = [];
  const outputs: MediaDeviceOption[] = [];
  const cameras: MediaDeviceOption[] = [];

  let inputIndex = 1;
  let outputIndex = 1;
  let cameraIndex = 1;

  for (const device of devices) {
    if (device.kind === "audioinput") {
      inputs.push({
        deviceId: device.deviceId,
        label: device.label || `Microphone ${inputIndex++}`,
      });
    } else if (device.kind === "audiooutput") {
      outputs.push({
        deviceId: device.deviceId,
        label: device.label || `Speaker ${outputIndex++}`,
      });
    } else if (device.kind === "videoinput" && device.deviceId) {
      cameras.push({
        deviceId: device.deviceId,
        label: device.label || `Camera ${cameraIndex++}`,
      });
    }
  }

  return { inputs, outputs, cameras };
}

/**
 * The three `getUserMedia` audio processors a user is allowed to turn off.
 *
 * All three are on by default because that is what a laptop speaker in a shared
 * room needs. They are exposed because they are also what ruins a condenser mic
 * on a boom arm: auto gain rides the noise floor up between sentences and noise
 * suppression eats the tail of every word.
 */
export interface MicProcessing {
  echoCancellation: boolean;
  /**
   * Three settings, not a tick box: `off`, `browser` (the constraint), or
   * `advanced` (RNNoise in a worklet). See `./noise-suppression`. It was a
   * boolean until Sep 2026 and persisted values are migrated on read.
   */
  noiseSuppression: NoiseSuppressionMode;
  autoGainControl: boolean;
}

export const defaultMicProcessing: MicProcessing = {
  echoCancellation: true,
  noiseSuppression: "browser",
  autoGainControl: true,
};

export function sameMicProcessing(a: MicProcessing, b: MicProcessing): boolean {
  return (
    a.echoCancellation === b.echoCancellation &&
    a.noiseSuppression === b.noiseSuppression &&
    a.autoGainControl === b.autoGainControl
  );
}

/**
 * Always an object, never `true`.
 *
 * `audio: true` means "the browser's defaults", and the browser's defaults have
 * all three processors on. Someone who unticked noise suppression while on the
 * system default device used to get it back anyway, silently, because the
 * device-less branch threw the constraints away. Naming every flag every time
 * is the only thing that makes the toggles mean anything on the default device.
 */
export function buildAudioConstraints(
  deviceId: string | undefined,
  processing: MicProcessing = defaultMicProcessing,
): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    echoCancellation: processing.echoCancellation,
    // FALSE in advanced mode. RNNoise runs on the raw capture; letting the
    // browser suppress first would hand it a signal unlike anything it was
    // trained on, and the two together sound worse than either alone.
    noiseSuppression: browserNoiseSuppression(processing.noiseSuppression),
    autoGainControl: processing.autoGainControl,
  };
  if (deviceId) {
    constraints.deviceId = { exact: deviceId };
  }
  return constraints;
}

export async function applyAudioOutputDevice(
  element: HTMLMediaElement,
  deviceId: string,
): Promise<void> {
  const media = element as HTMLMediaElement & {
    setSinkId?: (id: string) => Promise<void>;
  };
  if (typeof media.setSinkId !== "function") {
    return;
  }
  try {
    await media.setSinkId(deviceId || "");
  } catch {
    // Device may have been unplugged; keep default output.
  }
}
