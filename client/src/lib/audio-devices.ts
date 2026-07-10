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

export async function listAudioDevices(): Promise<{
  inputs: MediaDeviceOption[];
  outputs: MediaDeviceOption[];
}> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { inputs: [], outputs: [] };
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs: MediaDeviceOption[] = [];
  const outputs: MediaDeviceOption[] = [];

  let inputIndex = 1;
  let outputIndex = 1;

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
    }
  }

  return { inputs, outputs };
}

export function buildAudioConstraints(
  deviceId: string | undefined,
): MediaTrackConstraints | boolean {
  if (!deviceId) {
    return true;
  }
  return {
    deviceId: { exact: deviceId },
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
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
