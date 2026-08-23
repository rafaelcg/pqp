/**
 * What the camera is asked for, and what its encoder is allowed to spend.
 *
 * WHY THIS EXISTS. Until now the camera was captured with `{ video: true }`
 * and handed to the peer connection untouched: no size, no frame rate, no
 * content hint, and no `setParameters` anywhere. That is not "let the browser
 * decide well" — an unconstrained `getUserMedia` resolves to **640x480** in
 * Chrome, Firefox and Safari alike, so 480p was the hard ceiling of a pqp
 * video call, and any downward adaptation from there lands at 320x240 or
 * below. The screen-share path has had a considered answer to all of this for
 * a while (`SCREEN_CAPTURE_OPTIONS`, `contentHint`, `tuneScreenSender`); the
 * camera simply never got one.
 *
 * WHY IT IS A SEPARATE MODULE. Everything here is a pure function of a chosen
 * quality, which makes the two dangerous paths testable without a browser:
 * a capture request the hardware refuses, and an encoder that rejects the
 * parameters. Both must end with a working camera at the old defaults rather
 * than with no camera, and that promise is only worth making if it is pinned.
 */

/** The user-facing choices. `auto` is the default and always will be. */
export const VIDEO_QUALITIES = [
  "auto",
  "1080p",
  "720p",
  "480p",
  "360p",
] as const;

export type VideoQuality = (typeof VIDEO_QUALITIES)[number];

export const DEFAULT_VIDEO_QUALITY: VideoQuality = "auto";

/** The two things a quality actually controls, and nothing else. */
export interface CameraProfile {
  width: number;
  height: number;
  frameRate: number;
  /** Ceiling for the sender, in bits per second. Never a target. */
  maxBitrate: number;
}

/**
 * Bitrates sized for one peer on a domestic uplink, deliberately conservative.
 *
 * These are ceilings handed to `setParameters`, so a still picture costs
 * almost nothing and only a moving one approaches the number. They exist to
 * stop the camera and a simultaneous screen share from bidding against each
 * other for the same bandwidth estimate on the same connection, which is the
 * situation the old code left entirely ungoverned.
 */
const PROFILES: Record<Exclude<VideoQuality, "auto">, CameraProfile> = {
  "1080p": { width: 1920, height: 1080, frameRate: 30, maxBitrate: 2_500_000 },
  "720p": { width: 1280, height: 720, frameRate: 30, maxBitrate: 1_500_000 },
  "480p": { width: 854, height: 480, frameRate: 30, maxBitrate: 700_000 },
  "360p": { width: 640, height: 360, frameRate: 30, maxBitrate: 400_000 },
};

/**
 * What `auto` asks for.
 *
 * Auto is not "no opinion" — that is exactly what produced the 480p ceiling.
 * It is "ask for 720p30 and let the encoder give resolution back when the link
 * cannot carry it", which is what `degradationPreference: "maintain-framerate"`
 * on the sender then does, continuously and in both directions. 720p rather
 * than 1080p because a two-person mesh call uploads a full copy per peer, so
 * 1080p is a choice with a cost rather than a free upgrade.
 */
const AUTO_PROFILE: CameraProfile = PROFILES["720p"];

export function cameraProfileFor(quality: VideoQuality): CameraProfile {
  return quality === "auto" ? AUTO_PROFILE : PROFILES[quality];
}

/**
 * Capture constraints for a quality. **Every field is `ideal`.**
 *
 * This is the most important line in the file and the one most likely to be
 * "tidied" into something worse. `exact` (or a bare `{ width: 1280 }`, which
 * is shorthand for `ideal` today but reads like a demand) turns a webcam that
 * cannot do 720p into an `OverconstrainedError`, and the camera button stops
 * working for that person entirely. `ideal` means "closest you can manage", so
 * a 480p webcam gives 480p and a phone gives 720p, and nobody loses their
 * camera over it.
 */
export function cameraConstraintsFor(
  quality: VideoQuality,
): MediaTrackConstraints {
  const profile = cameraProfileFor(quality);
  return {
    width: { ideal: profile.width },
    height: { ideal: profile.height },
    frameRate: { ideal: profile.frameRate },
  };
}

export function cameraBitrateFor(quality: VideoQuality): number {
  return cameraProfileFor(quality).maxBitrate;
}

/** Storage and query strings hand back `unknown`; this is the only door in. */
export function parseVideoQuality(raw: unknown): VideoQuality {
  return VIDEO_QUALITIES.includes(raw as VideoQuality)
    ? (raw as VideoQuality)
    : DEFAULT_VIDEO_QUALITY;
}

type GetUserMedia = (
  constraints: MediaStreamConstraints,
) => Promise<MediaStream>;

/**
 * Open the camera at a quality, and never let the quality be why it failed.
 *
 * `ideal` constraints are not supposed to be refusable, but "not supposed to"
 * is not a guarantee worth handing a live product: virtual cameras, OBS
 * sources, some Android devices and more than one Linux driver stack are all
 * on record refusing requests they should merely have approximated. So a
 * refusal is retried once with the bare request this code used to make. The
 * user ends up exactly where they were before this feature existed, which is
 * the worst outcome allowed here.
 *
 * A refusal of the *bare* request is a real failure (no camera, permission
 * denied, device in use) and propagates untouched, because the caller already
 * knows how to say those things to a person.
 */
export async function captureCamera(
  getUserMedia: GetUserMedia,
  quality: VideoQuality,
): Promise<MediaStream> {
  try {
    return await getUserMedia({
      video: cameraConstraintsFor(quality),
      audio: false,
    });
  } catch (err) {
    if (isFatalCaptureError(err)) {
      throw err;
    }
    console.warn(
      "[pqp] camera refused the requested size; falling back to defaults",
      err,
    );
    return getUserMedia({ video: true, audio: false });
  }
}

/**
 * Errors where asking again in a smaller voice cannot possibly help.
 *
 * Retrying a denied permission would put a second prompt in front of somebody
 * who just said no, and retrying a missing device wastes a second for nothing.
 * Anything else — including the `OverconstrainedError` this mainly exists for
 * — is worth one bare retry.
 */
function isFatalCaptureError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return (
    err.name === "NotAllowedError" ||
    err.name === "SecurityError" ||
    err.name === "NotFoundError"
  );
}

/**
 * Re-shape a camera that is already open and already on the wire.
 *
 * Used when the quality changes mid-call, where re-capturing would blink the
 * webcam light and drop a second of video for no reason. Resolves to whether
 * it took, and **never rejects**: a driver that refuses to change size leaves
 * the call running at the size it already had, which is a worse picture than
 * asked for and infinitely better than no picture.
 */
export async function applyCameraQuality(
  track: MediaStreamTrack,
  quality: VideoQuality,
): Promise<boolean> {
  try {
    await track.applyConstraints(cameraConstraintsFor(quality));
    return true;
  } catch (err) {
    console.warn(
      "[pqp] camera refused the requested size; keeping the current one",
      err,
    );
    return false;
  }
}
