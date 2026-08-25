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
 * WHY CAPTURE SIZE IS STILL NOT ON THIS LADDER. The screen is always captured
 * at 1080p30 (`SCREEN_CAPTURE_OPTIONS` in `use-voice.ts`) whatever is chosen
 * here, and that is deliberate. Capture size is a floor you cannot climb back
 * up: a screen grabbed at 640x360 has lost the pixels that made the text
 * legible, permanently, even in the moments when the link has room to spare.
 * The *encoder* is where the size is chosen, which is what `screenScaleFactor`
 * below is for, and it is revisable in both directions at any moment.
 *
 * THE BITRATE CEILING WAS ONCE THE WHOLE ANSWER, AND IT WAS NOT ENOUGH. This
 * file used to argue that a tight ceiling plus
 * `degradationPreference: "maintain-framerate"` would make the encoder scale
 * 1080p down on its own. Measured at the receiver in a real voice channel, it
 * does not: once the encoder has ramped up to the capture size it stays there
 * and spends the smaller allowance on a worse-looking 1920x1080, so picking
 * 360p bought a blocky full-size picture rather than a clean small one. The
 * ladder therefore names a size as well as a rate, and the size is pinned with
 * `scaleResolutionDownBy`.
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
 * The number of picture lines each label promises the far end.
 *
 * A label is a promise about what the viewer receives, so these are the heights
 * `scaleResolutionDownBy` is solved for. Height rather than width because that
 * is what "360p" has always meant, and because it is the dimension that stays
 * meaningful across a 16:9 monitor, an ultrawide and a shared portrait window.
 */
const SCREEN_HEIGHTS: Record<Exclude<VideoQuality, "auto">, number> = {
  "1080p": 1080,
  "720p": 720,
  "480p": 480,
  "360p": 360,
};

/**
 * What the screen is asked for, and therefore the best guess at what a capture
 * that has not reported its size yet will turn out to be.
 *
 * Kept next to the ladder rather than imported from `use-voice.ts` to avoid a
 * cycle; the two must agree, and `video-quality.test.ts` says so out loud.
 */
export const SCREEN_CAPTURE_HEIGHT = 1080;

/**
 * How much to divide the captured picture by so it arrives at the size the menu
 * names.
 *
 * WHY A DIVISOR AND NOT A SIZE. `RTCRtpEncodingParameters` only offers
 * `scaleResolutionDownBy`, which is a ratio applied to whatever the track is
 * currently producing. That is why this takes the capture's own height: a
 * hard-coded 3 is 360p on a 1080p monitor and 480p on a 1440p one, and the same
 * label has to mean the same picture on both. On this codebase the capture is
 * clamped to 1080 lines, but a smaller shared window is entirely normal and a
 * future clamp is one edit away, so the height is read rather than assumed.
 *
 * NEVER BELOW 1. A divisor under one is an upscale: it spends bitrate inventing
 * pixels that carry no detail. Somebody sharing a 720-line window and choosing
 * 1080p gets their window, unchanged, which is the honest reading of the label.
 *
 * AUTO PINS NOTHING, deliberately. It is the one rung that names no size, so it
 * leaves the encoder free to climb and fall with the link, which is the whole
 * meaning of the word and the behaviour every default should have.
 */
export function screenScaleFactor(
  quality: VideoQuality,
  captureHeight?: number | null,
): number {
  if (quality === "auto") {
    return 1;
  }
  const target = SCREEN_HEIGHTS[quality];
  // A capture reports no size at all in its first moments. Assuming the size we
  // asked for beats assuming "no scaling", which would ship 1080p to somebody
  // who chose 360p until something happened to re-tune the sender.
  const height =
    captureHeight && captureHeight > 0 ? captureHeight : SCREEN_CAPTURE_HEIGHT;
  if (height <= target) {
    return 1;
  }
  // Two decimals: enough for every rung on every common panel, and short of the
  // float noise that would make a re-tune look like a change when it is not.
  return Math.round((height / target) * 100) / 100;
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

/**
 * What one peer's screen sender should actually run at, given what the
 * presenter chose and what that one watcher asked for.
 *
 * THE PROBLEM THIS SOLVES. A viewer cannot raise the quality they receive.
 * `scaleResolutionDownBy` and `maxBitrate` live on an `RTCRtpSender`, and
 * `RTCRtpReceiver` has no counterpart to either, so what the presenter encodes
 * is what arrives. The only route from "this looks soft" to a bigger picture
 * runs through the presenter's machine, which is what the request frame is
 * for. This function is the presenter's answer to it.
 *
 * PER-PEER, AND THAT IS THE WHOLE REASON IT IS SAFE. In a full mesh the
 * presenter holds a separate `RTCRtpSender` for every peer, so granting Ana's
 * request raises **Ana's copy only** and Bruno keeps exactly what he had. The
 * obvious objection to viewer-initiated quality — "in a call with three
 * watchers, one person asking for 1080p spends the sender's uplink on
 * everybody's behalf, and the sender may be on a phone" — is therefore not a
 * thing that can happen here. It would be the right objection to an SFU, or to
 * any design that took a single maximum across the room, which is why neither
 * is what this does.
 *
 * MULTIPLE REQUESTS CANNOT CONFLICT, for the same reason. Two watchers asking
 * for two different sizes each get their own, out of their own sender. There
 * is no maximum to take and no tie to break, so there is no rule here about
 * one, and inventing one would be inventing a problem.
 *
 * THE PRESENTER'S EXPLICIT CHOICE ALWAYS WINS. `auto` is what everybody has
 * who has never opened the menu: it means "no opinion, do something sensible",
 * and a watcher's opinion is a perfectly good thing to fill that with. Any
 * other rung was typed by a person who was deciding how much of their upload
 * to spend, frequently on a phone or a tethered connection, and a stranger in
 * the call does not get to overrule that. So a presenter on 480p stays on
 * 480p, and the asker is told the sender is capped rather than left wondering
 * why nothing happened.
 *
 * THE ROOM'S BUDGET STILL BINDS ON TOP OF THIS. The returned quality is fed to
 * `meshScreenBitrate`, which divides `SCREEN_UPLOAD_BUDGET_BPS` by the peer
 * count. A granted request therefore cannot push the presenter's *total*
 * uplink past the number it was already bounded by, however many people ask
 * and however loudly. What it buys is a bigger picture out of the same
 * allowance for the one peer who asked, which on a link with headroom is
 * exactly the trade the asker wanted.
 *
 * AND NOTHING HERE IS A PROMISE. This is the size the encoder is *aimed* at.
 * `degradationPreference: "maintain-framerate"` still gives resolution back
 * when the link cannot carry it, in both directions, several times a second.
 * Asking for 1080p over a link that cannot do it produces 1080p worth of
 * ambition and 480p worth of picture, which is what it has always produced.
 */
export function effectiveScreenQuality(
  chosen: VideoQuality,
  requested: VideoQuality | null,
): VideoQuality {
  if (requested === null || chosen !== "auto") {
    return chosen;
  }
  return requested;
}

/** Storage and query strings hand back `unknown`; this is the only door in. */
export function parseVideoQuality(raw: unknown): VideoQuality {
  return VIDEO_QUALITIES.includes(raw as VideoQuality)
    ? (raw as VideoQuality)
    : DEFAULT_VIDEO_QUALITY;
}

/**
 * The same door, for a value that arrived from another machine.
 *
 * Differs from `parseVideoQuality` in what it does with something it does not
 * recognise: null, not the default. A stored rung that no longer parses should
 * fall back to `auto` because the person is still there and still owns the
 * setting; a *request* naming a rung this build has never heard of is a peer
 * on a different version, and turning that into "auto" would be acting on a
 * message we did not understand.
 */
export function parseRequestedQuality(raw: unknown): VideoQuality | null {
  return VIDEO_QUALITIES.includes(raw as VideoQuality)
    ? (raw as VideoQuality)
    : null;
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
