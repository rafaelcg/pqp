import { browserStorage } from "./arrival";

/**
 * Whether a `MediaDeviceInfo.label` names OBS's virtual camera.
 *
 * OBS ships two label shapes across platforms: "OBS Virtual Camera" on
 * Windows/Linux and "OBS-Camera" on macOS (the CamTwist-style plugin OBS
 * bundles there). Neither is a stable device id, only a string the OS hands
 * back, so this stays a loose match rather than an exact one.
 *
 * A pure function on purpose: every camera picker (voice settings today, any
 * future one) calls the same rule against whatever label it already has, no
 * DOM or storage involved.
 */
export function isObsVirtualCameraLabel(label: string): boolean {
  if (!label) {
    return false;
  }
  return /obs.*virtual/i.test(label) || /obs-camera/i.test(label);
}

/** Remembered once they close the OBS Virtual Camera tip. */
export const OBS_VIRTUAL_CAMERA_HINT_STORAGE_KEY =
  "pqp:obs-virtual-camera-hint-dismissed";

/**
 * Whether this browser already dismissed the tip.
 *
 * Missing or hostile storage shows the tip: a reminder that comes back is
 * cheaper than one that never appears because we could not read the flag.
 */
export function isObsVirtualCameraHintDismissed(
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
): boolean {
  try {
    return storage?.getItem(OBS_VIRTUAL_CAMERA_HINT_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Persist the dismiss. Callers still hide the tip in React state for this
 * session even when the write fails (quota, private mode, locked-down store).
 */
export function dismissObsVirtualCameraHint(
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
): void {
  try {
    storage?.setItem(OBS_VIRTUAL_CAMERA_HINT_STORAGE_KEY, "1");
  } catch {
    // Session-only hide lives in the component that called this.
  }
}
