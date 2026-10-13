import { STORY_IMAGE_MAX_EDGE } from "@pqp/shared";

/**
 * The browser camera, as far as the story composer needs it. Everything that
 * can be decided without a camera is a pure function here so it has a test:
 * which container to record in, which way a preview mirrors, what an error
 * from `getUserMedia` means, which part of a wide sensor frame is the 9:16
 * the story shows.
 */

export type CameraFacing = "user" | "environment";

/**
 * Why there is no picture. `denied` is the person (or a policy) saying no and
 * is fixed in the browser's site settings; `none` is no camera at all; `busy`
 * is another app holding it; `insecure` is a page that is not HTTPS, where
 * browsers hide `getUserMedia` entirely; `unsupported` is a browser without
 * the API; `failed` is anything else.
 */
export type CameraProblem = "denied" | "none" | "busy" | "insecure" | "unsupported" | "failed";

export function classifyCameraError(error: unknown): CameraProblem {
  const name =
    error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "none";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "busy";
    case "TypeError":
      return "unsupported";
    default:
      return "failed";
  }
}

/** What stops a camera before it is asked: no API, or a page the browser will not trust. */
export function cameraAvailability(env: {
  hasGetUserMedia: boolean;
  isSecureContext: boolean;
}): CameraProblem | null {
  if (!env.hasGetUserMedia) {
    return env.isSecureContext ? "unsupported" : "insecure";
  }
  return null;
}

/**
 * Constraints for the preview. A phone held upright reports a portrait sensor,
 * a laptop webcam a landscape one, so the ideal size follows the device and
 * the stage crops either to 9:16. `ideal`, never `exact`: a camera that cannot
 * match still opens.
 */
export function videoConstraints(options: {
  facing: CameraFacing;
  deviceId: string | null;
  portrait: boolean;
}): MediaTrackConstraints {
  const size = options.portrait
    ? { width: { ideal: 1080 }, height: { ideal: 1920 } }
    : { width: { ideal: 1920 }, height: { ideal: 1080 } };
  if (options.deviceId) {
    return { deviceId: { exact: options.deviceId }, ...size };
  }
  return { facingMode: { ideal: options.facing }, ...size };
}

const REAR_LABEL = /\b(back|rear|environment|traseira|trasera|posterior)\b/i;

/**
 * Mirror the preview the way a platform camera does: the front camera shows
 * you as a mirror would, the back camera never mirrors. A laptop webcam
 * reports no `facingMode` at all and is a front camera in every way that
 * matters, so "unknown" mirrors.
 */
export function shouldMirror(settings: { facingMode?: string | undefined }, label = ""): boolean {
  if (settings.facingMode === "environment") {
    return false;
  }
  if (settings.facingMode === "user") {
    return true;
  }
  return !REAR_LABEL.test(label);
}

/** The next camera in the list after `currentId`, wrapping. Null with fewer than two. */
export function nextDeviceId(
  devices: readonly { deviceId: string }[],
  currentId: string | null,
): string | null {
  if (devices.length < 2) {
    return null;
  }
  const index = devices.findIndex((device) => device.deviceId === currentId);
  return devices[(index + 1) % devices.length]!.deviceId;
}

// ------------------------------------------------------------------ recording

/**
 * The containers a story video may be, best first. The server takes MP4 only
 * today, which Safari and Chromium (126 and up) record natively and Firefox
 * does not. Null means this browser cannot record a clip the story accepts;
 * the camera then offers photos only and says so.
 */
export const RECORDER_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4;codecs=avc1",
  "video/mp4",
] as const;

export function pickRecorderType(isSupported: (type: string) => boolean): string | null {
  return RECORDER_CANDIDATES.find((type) => isSupported(type)) ?? null;
}

/** The longest side the recorder is asked for. 1080p at 30 fps stays well under 25 MB for 30 s. */
export const RECORDER_VIDEO_BITS_PER_SECOND = 3_500_000;
export const RECORDER_AUDIO_BITS_PER_SECOND = 96_000;

/** A press shorter than this is a tap (a photo); longer, a hold (a video). */
export const HOLD_TO_RECORD_MS = 320;
/** A clip shorter than this is an accidental hold, and is dropped. */
export const MIN_CLIP_MS = 600;

// ------------------------------------------------------------------ stills

/**
 * The centred 9:16 window of a frame, in source pixels. A landscape webcam
 * keeps the middle of the picture; a frame already narrower than 9:16 keeps
 * its full width and loses height instead.
 */
export function coverCrop(
  sourceWidth: number,
  sourceHeight: number,
  aspect = 9 / 16,
): { sx: number; sy: number; sw: number; sh: number } {
  const sourceAspect = sourceWidth / sourceHeight;
  if (sourceAspect > aspect) {
    const sw = Math.round(sourceHeight * aspect);
    return { sx: Math.round((sourceWidth - sw) / 2), sy: 0, sw, sh: sourceHeight };
  }
  const sh = Math.round(sourceWidth / aspect);
  return { sx: 0, sy: Math.round((sourceHeight - sh) / 2), sw: sourceWidth, sh };
}

/** The output size of a still: the crop, the long side at most `STORY_IMAGE_MAX_EDGE`. */
export function stillSize(sw: number, sh: number): { width: number; height: number } {
  const longest = Math.max(sw, sh);
  if (longest <= STORY_IMAGE_MAX_EDGE) {
    return { width: sw, height: sh };
  }
  const scale = STORY_IMAGE_MAX_EDGE / longest;
  return { width: Math.max(1, Math.round(sw * scale)), height: Math.max(1, Math.round(sh * scale)) };
}

/**
 * The frame on screen as a JPEG. NOT mirrored, even when the preview was: the
 * platform cameras do the same, and a mirrored selfie would flip every sign in
 * the background and the writing on a shirt.
 */
export async function captureStill(video: HTMLVideoElement): Promise<{
  blob: Blob;
  width: number;
  height: number;
} | null> {
  if (!video.videoWidth || !video.videoHeight) {
    return null;
  }
  const { sx, sy, sw, sh } = coverCrop(video.videoWidth, video.videoHeight);
  const { width, height } = stillSize(sw, sh);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  context.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  return blob ? { blob, width, height } : null;
}
