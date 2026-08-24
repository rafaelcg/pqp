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
 * The same five choices, applied to the screen sender.
 *
 * WHY THIS EXISTS. The control has been labelled "video quality" since it
 * shipped and has only ever moved the camera. Somebody picked 1080p, shared
 * their screen, and got the same soft picture as before, because the screen
 * sender was governed by one hard-coded constant that no setting could reach.
 * A control that silently governs half of what its name claims is worse than
 * no control: the user has been told the thing is already as good as it goes.
 *
 * WHY THE NUMBERS ARE NOT THE CAMERA'S. "1080p" names a picture, not a
 * bitrate, and the bitrate that picture costs depends entirely on what is in
 * it. A talking head is a static background with a moving oval in the middle
 * and inter-frame prediction eats it alive; 2.5 Mbps is generous. A shared
 * screen is a game, a film, a scrolling page: full-frame motion, hard edges,
 * and text the codec cannot blur without it becoming unreadable. The same
 * 1080p30 costs roughly twice as much. Handing the screen the camera's ladder
 * would keep the label honest and the picture blurry, which is the bug.
 *
 * WHY CAPTURE SIZE IS NOT ON THIS LADDER. The screen is always captured at
 * 1080p30 (`SCREEN_CAPTURE_OPTIONS` in `use-voice.ts`) whatever is chosen
 * here, and that is deliberate. Capture size is a floor you cannot climb back
 * up: a screen grabbed at 640x360 has lost the pixels that made the text
 * legible, permanently, even in the moments when the link has room to spare.
 * The bitrate ceiling is the reversible lever. Under
 * `degradationPreference: "maintain-framerate"` the encoder scales 1080p down
 * on its own when the ceiling is tight and scales it back up the moment it is
 * not, continuously, which is the behaviour a person actually wants from a
 * setting called "quality".
 */
const SCREEN_BITRATES: Record<Exclude<VideoQuality, "auto">, number> = {
  "1080p": 4_000_000,
  "720p": 2_000_000,
  "480p": 1_000_000,
  "360p": 600_000,
};

/**
 * What `auto` spends on a screen.
 *
 * 3 Mbps, which is above the 2.5 Mbps every share used to get and below the
 * 4 Mbps a deliberate 1080p now asks for. Auto has to be the number that is
 * right for somebody who has never opened this menu and never will, on an
 * uplink nobody has measured, so it buys a visibly better share than today
 * without being the most expensive thing the product can do behind their back.
 * Choosing 1080p is how you say "I have the upload, spend it".
 */
const AUTO_SCREEN_BITRATE = 3_000_000;

/**
 * The chosen ceiling for a screen sender, in bits per second.
 *
 * A CEILING, NOT A TARGET, and this is the sentence that keeps getting
 * optimised away. Nothing here makes anybody send 4 Mbps. It is the maximum
 * the encoder is *permitted* to reach; WebRTC's congestion controller has its
 * own estimate of what the link can actually carry and sends the lower of the
 * two, revised several times a second. On a link that cannot do 4 Mbps this
 * number is inert. Lowering it "to be safe" does nothing for the person on a
 * weak uplink (the estimator already had them covered) and takes the sharp
 * picture away from the person on a good one, which is the whole ask.
 */
export function screenBitrateFor(quality: VideoQuality): number {
  return quality === "auto" ? AUTO_SCREEN_BITRATE : SCREEN_BITRATES[quality];
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
