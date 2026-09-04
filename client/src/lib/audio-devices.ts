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

export async function ensureMediaPermission(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    for (const track of stream.getTracks()) {
      track.stop();
    }
    return true;
  } catch {
    return false;
  }
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
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export const defaultMicProcessing: MicProcessing = {
  echoCancellation: true,
  noiseSuppression: true,
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
    noiseSuppression: processing.noiseSuppression,
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
