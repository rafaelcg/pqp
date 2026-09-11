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

import { LARGE_ROOM_PARTICIPANTS } from "@pqp/shared";

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

/**
 * Host Qualidade on a watch party: 480p / 720p / 1080p, plus Auto.
 * 360p stays on the call-strip menu; 60 fps is not offered here.
 */
export const WATCH_PARTY_HOST_QUALITIES: readonly VideoQuality[] = [
  "auto",
  "1080p",
  "720p",
  "480p",
];

/**
 * A stored 360p is the call-strip floor, not a watch-party offer. Capture
 * then uses 480p so the live-bar menu and getDisplayMedia agree.
 */
export function watchPartyHostQuality(quality: VideoQuality): VideoQuality {
  return quality === "360p" ? "480p" : quality;
}

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
 * CAPTURE SIZE FOLLOWS THE MENU. A 4K panel with no cap is 3840×2160, and a
 * laptop cannot encode that: fps collapses and HLS transcodes the slideshow.
 * Auto and 1080p cap at 1920×1080; 720p at 1280×720. Display capture can climb
 * back when the cap is raised (`applyConstraints`). The encoder still names a
 * size (`screenScaleFactor`); capture must not start larger than the pick.
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
  "1080p": 8_000_000,
  "720p": 3_500_000,
  "480p": 1_500_000,
  "360p": 800_000,
};

/**
 * What `auto` spends on a screen.
 *
 * 3 Mbps, which is above the 2.5 Mbps every share used to get and below the
 * 8 Mbps a deliberate 1080p now asks for. Auto has to be the number that is
 * right for somebody who has never opened this menu and never will, on an
 * uplink nobody has measured, so it buys a visibly better share than today
 * without being the most expensive thing the product can do behind their back.
 * Choosing 1080p is how you say "I have the upload, spend it". A watch-party
 * HLS source uses `max(auto, 1080p)` so the ladder is not starved by this
 * compromise.
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
 * Pixel ceiling `getDisplayMedia` / `applyConstraints` ask for.
 *
 * Height matches `SCREEN_HEIGHTS`. Width is 16:9 of that height (480p uses
 * 854, same as the camera profile). Auto is 1080, not 4K: an unconstrained
 * display capture on a 4K laptop is 3840×2160 and the machine cannot encode it.
 */
const SCREEN_CAPTURE_SIZES: Record<
  Exclude<VideoQuality, "auto">,
  { width: number; height: number }
> = {
  "1080p": { width: 1920, height: 1080 },
  "720p": { width: 1280, height: 720 },
  "480p": { width: 854, height: 480 },
  "360p": { width: 640, height: 360 },
};

export function screenCaptureSizeFor(quality: VideoQuality): {
  width: number;
  height: number;
} {
  return quality === "auto"
    ? SCREEN_CAPTURE_SIZES["1080p"]
    : SCREEN_CAPTURE_SIZES[quality];
}

/**
 * What the picker means as capture constraints.
 *
 * `max` is the contract: 1080p must not be 4K. `resizeMode: crop-and-scale`
 * is what makes Chrome honour that on a display track — without it,
 * getDisplayMedia ignores width/height and hands over the native panel.
 */
export function screenCaptureConstraintsFor(
  quality: VideoQuality,
  maxFrameRate: 30 | 60,
): MediaTrackConstraints & { resizeMode?: string } {
  const { width, height } = screenCaptureSizeFor(quality);
  return {
    width: { max: width },
    height: { max: height },
    frameRate: { ideal: maxFrameRate, max: maxFrameRate },
    resizeMode: "crop-and-scale",
  };
}

/**
 * Re-shape a live screen capture without reopening the picker.
 *
 * Never rejects: a browser that refuses `resizeMode` is retried without it,
 * and a browser that refuses the size keeps the share running.
 */
export async function applyScreenCaptureQuality(
  track: MediaStreamTrack,
  quality: VideoQuality,
  maxFrameRate: 30 | 60,
): Promise<boolean> {
  if (typeof track.applyConstraints !== "function") {
    return false;
  }
  const constraints = screenCaptureConstraintsFor(quality, maxFrameRate);
  try {
    await track.applyConstraints(
      constraints as MediaTrackConstraints,
    );
    return true;
  } catch (err) {
    const withoutResize: MediaTrackConstraints = {
      width: constraints.width,
      height: constraints.height,
      frameRate: constraints.frameRate,
    };
    try {
      await track.applyConstraints(withoutResize);
      return true;
    } catch {
      console.warn(
        "[pqp] screen capture refused the requested size; keeping the current one",
        err,
      );
      return false;
    }
  }
}

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
 * AUTO ASKS FOR 720p, and it used to ask for nothing. The old argument was that
 * naming no size leaves the encoder free to climb and fall with the link, which
 * is what the word means. Measured at the far end of a two-person mesh call it
 * only falls: a 1080p30 capture with `contentHint: "motion"` and no size pin
 * arrived at roughly 144 lines and 3-5 fps, while our own arithmetic asked for
 * none of that (one peer, so the 5 Mbps mesh budget does not bind; a 3 Mbps
 * ceiling; `maintain-framerate`). An unpinned encoder starting from a
 * full-size, full-motion capture has every reason to give resolution away and
 * nothing telling it where to stop. So auto now starts where the camera's auto
 * already starts, at 720 lines, and `maintain-framerate` still hands resolution
 * back from there if the link genuinely cannot carry it. The *bitrate* stays at
 * `AUTO_SCREEN_BITRATE`: the smaller picture is not a demotion, it is the same
 * allowance spent on fewer, sharper pixels.
 */
export function screenScaleFactor(
  quality: VideoQuality,
  captureHeight?: number | null,
): number {
  const target =
    quality === "auto" ? SCREEN_HEIGHTS["720p"] : SCREEN_HEIGHTS[quality];
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

// ------------------------------------------------------------- SFU simulcast

/**
 * The room size above which a presenter on the SFU stops offering 1080p unless
 * they asked for it by name.
 *
 * WHY 20. A 100-viewer watch party on 5 Sep 2026 pulled 323 GB of SFU
 * downstream in three and a half hours. The share was one layer at up to
 * 3 Mbps, and every viewer, phones included, received that layer, because
 * there was nothing else to receive. Above a couple of dozen people the room
 * is a broadcast, not a conversation: the presenter is one, the viewers are
 * many, and every bit the presenter's top layer carries is paid for once per
 * viewer. Twenty is where "a few friends" stops being a fair description of
 * the room, and it is well under the point where the bill becomes the story.
 */
export { LARGE_ROOM_PARTICIPANTS };

/** What a large room's top layer is held to, unless 1080p was chosen by name. */
export const LARGE_ROOM_SCREEN_HEIGHT = 720;
export const LARGE_ROOM_SCREEN_BITRATE = 1_500_000;

/** One rung of the presenter's simulcast ladder, as `livekit-client` wants it. */
export interface ScreenLayer {
  width: number;
  height: number;
  /** Ceiling in bits per second. A ceiling, not a target; see above. */
  maxBitrate: number;
  maxFramerate: number;
}

/**
 * The two smaller copies a presenter encodes alongside the top layer.
 *
 * The SFU can only hand a viewer a smaller picture that the presenter
 * actually encodes, so a phone watching a 1080p share used to receive 1080p
 * because that was the only copy on the server. These are the copies it can
 * now choose from. 720p at 1.4 Mbps is a little under what LiveKit's own
 * `ScreenSharePresets.h720fps15` spends, given 30 fps because a share here is
 * usually a film or a game; 360p at 450 kbps is a phone-sized picture that
 * still reads as video rather than as a slideshow.
 */
export const SCREEN_SIMULCAST_RUNGS: readonly ScreenLayer[] = [
  { width: 640, height: 360, maxBitrate: 450_000, maxFramerate: 30 },
  { width: 1280, height: 720, maxBitrate: 1_400_000, maxFramerate: 30 },
];

/**
 * What the presenter's screen goes up as on the SFU: the size and ceiling of
 * the top layer, the smaller layers under it, and whether the room's size is
 * what decided the top.
 */
export interface ScreenSimulcastPlan {
  /** Lines in the top layer, which is also what the capture is asked for. */
  topHeight: number;
  /** The top layer's ceiling in bits per second. */
  topBitrate: number;
  /** Every rung strictly below the top, smallest first. */
  lowerLayers: ScreenLayer[];
  /** True when `LARGE_ROOM_PARTICIPANTS` is what held the top at 720p. */
  capped: boolean;
  /**
   * True when the HLS uplink gate held the source at 720p. Distinct from
   * `capped`: that one reuses the 1.5 Mbps large-room ceiling, and this one
   * must not. A watch-party source at 1.5 Mbps is what every playlist viewer
   * transcodes, and the readout then blames a healthy connection because
   * `sampleSenders` was reporting the uncapped 3–4 Mbps setting.
   */
  heldForHls: boolean;
}

/**
 * Whether the room is large enough to hold the top layer at 720p.
 *
 * An explicit 1080p is the presenter saying "I know, spend it", and the cap
 * steps aside. Auto and every smaller choice are subject to it; a smaller
 * choice is already at or under the cap, so for them it is moot.
 */
export function isLargeRoomCapped(
  quality: VideoQuality,
  participantCount: number,
): boolean {
  return participantCount > LARGE_ROOM_PARTICIPANTS && quality !== "1080p";
}

/**
 * The presenter's ladder for a quality and a room size.
 *
 * THE TOP LAYER IS THE CAPTURE SIZE, and that is why the plan names a height
 * rather than a divisor. `livekit-client` builds the top simulcast layer from
 * the track's own dimensions and scales the smaller layers down from there,
 * and it declares those dimensions to the SFU, which routes a viewer's
 * request ("720 lines, please") against the declaration. Scaling the top
 * layer down behind the library's back with `scaleResolutionDownBy` would
 * leave the declaration saying 1080p over a 720p picture and send the wrong
 * layer to whoever asked. So the session asks the *capture* for the plan's
 * height with `applyConstraints`, and republishes when that height changes,
 * which keeps every layer the SFU knows about a layer that actually exists.
 *
 * The capture-floor argument in `screenScaleFactor` still holds: this never
 * captures below the chosen size, and a display capture constrained to 720
 * lines climbs back to 1080 the moment the constraint is relaxed, because the
 * source is the screen, not a smaller camera mode.
 */
export interface HlsSourceInput {
  /**
   * The tallest rendition the server's ladder encodes, when a live HLS
   * egress is running on THIS channel. Null in every other case, including a
   * large room with no watch party, which is the case whose cap must not
   * move.
   */
  ladderTopHeight: number | null;
  /**
   * The presenter's own measured uplink in bit/s, from the candidate pair
   * (`voice-stats-probe.ts`), or null when it has not been read yet.
   *
   * **Null REFUSES the raise**, and it used to allow it, on the convention
   * `decidePromotion` uses for an SFU it has not probed. That convention is
   * right there and wrong here, and a live party showed why: 1080p went up
   * with a 4 Mbit/s target and about 2.35 Mbit/s actually arriving at the
   * egress, so the audience got a starved top layer at roughly 20 fps on a
   * full-motion source. A promotion that guesses wrong costs the box some
   * headroom; this one costs the whole audience the picture, because **the
   * egress subscribes with no layer preference and therefore always takes the
   * top one** (`SetSubscribed(true)` and nothing else, in livekit/egress's
   * SDK source; `TrackCompositeEgressRequest` has no layer field either). So
   * the cleanly delivered 720p layer sitting right beside it is never used,
   * and a starving 1080p is what every rung transcodes.
   *
   * A cleanly delivered 720p is better television than a starving 1080p, and
   * it costs the presenter less than half the uplink.
   */
  uplinkBps: number | null;
  /**
   * Honest limitation from `describeLimitation`, not raw
   * `qualityLimitationReason`. Chrome reports `bandwidth` while sitting on
   * our own `maxBitrate`; that is "setting", and it must not block a raise
   * or fire the strain banner.
   */
  limitedBy?: "bandwidth" | "setting" | "cpu" | "other" | null;
  /**
   * Capture / declared height already on the wire. When this is above 720,
   * the gate stays at the ladder top unless a drop condition fires, so a
   * 1080 source does not flap on a single noisy BWE reading.
   */
  currentHeight?: number | null;
  /** Applied publish ceiling, in bit/s. Raise is 1.25× this, not 1.25× 4 Mbps. */
  currentCeilingBps?: number | null;
}

/**
 * Headroom over the rung's own ceiling before a measured uplink counts as
 * able to carry it. A link measured at exactly the bitrate has none, and a
 * screen share that saturates the uplink is what makes a call stutter.
 *
 * Against the *current* ceiling, not against 1080's 4 Mbps. A sender
 * held at 720p (~2.25 Mbps) will never report 6 Mbps of
 * `availableOutgoingBitrate` — the estimator only probes a little above
 * what it is sending — so a 6 Mbps bar made the raise unreachable and the
 * source sat at 1.5 Mbps forever. 1.25× the ceiling in force is a probe
 * the BWE can actually clear.
 */
export const HLS_SOURCE_UPLINK_HEADROOM = 1.25;

/**
 * 720 HLS rung (3200 kbps) × headroom, floored at the 720p screen
 * ceiling. Never `LARGE_ROOM_SCREEN_BITRATE` (1.5 Mbps): that number is
 * what a large *WebRTC* room spends per viewer, and using it as the HLS
 * source made every playlist rung an upscale of a starved 720p.
 *
 * Lockstep with the default mid-rung override (`720p60@3200`) in
 * `server/src/voice/hls-ladder.ts`.
 */
export const HLS_720P30_VIDEO_BPS = 3_200_000;

export const HLS_HELD_720_BITRATE = Math.max(
  SCREEN_BITRATES["720p"],
  Math.round(HLS_720P30_VIDEO_BPS * HLS_SOURCE_UPLINK_HEADROOM),
);

/**
 * Whether the presenter should publish at the ladder's top rather than at
 * the large-room cap.
 *
 * WHY THE CAP IS WRONG HERE, and it is worth being precise because the cap
 * itself is right everywhere else. `LARGE_ROOM_PARTICIPANTS` exists because
 * the SFU fans the top layer out once per viewer, so an expensive top layer
 * in a big room is multiplied by the audience. With HLS carrying the
 * audience that multiplication does not happen: the SFU carries the
 * presenter and the speakers, everyone else is on the playlist, and the
 * egress encodes from the published track. A 720p published track cannot
 * produce a 1080p rendition however the ladder is configured, so the cap
 * does not save bandwidth any more, it just makes the ladder's top rung a
 * 720p upscale.
 *
 * It stays off for an ordinary large mesh or SFU call with no HLS stream.
 * That is the whole point of asking for `ladderTopHeight` rather than for a
 * boolean: it is null unless an egress is actually running.
 */
export function hlsSourceTopHeight(
  quality: VideoQuality,
  hls: HlsSourceInput | null,
): number | null {
  if (!hls || hls.ladderTopHeight === null) {
    return null;
  }
  const chosenHeight =
    quality === "auto" ? SCREEN_CAPTURE_HEIGHT : SCREEN_HEIGHTS[quality];
  // Never raise past what the presenter asked for. Someone who picked 480p
  // picked 480p, and a watch party is not a reason to overrule them.
  const wanted = Math.min(hls.ladderTopHeight, chosenHeight);
  if (wanted <= LARGE_ROOM_SCREEN_HEIGHT) {
    return null;
  }
  const atTop =
    typeof hls.currentHeight === "number" &&
    hls.currentHeight > LARGE_ROOM_SCREEN_HEIGHT;

  if (atTop) {
    return shouldDropHlsTop(hls) ? LARGE_ROOM_SCREEN_HEIGHT : wanted;
  }

  // Return 720 rather than null. Null used to mean "do not raise past the
  // large-room cap", which is a no-op in a small room: Auto still publishes
  // 1080, the egress still takes that top layer, and a 1.5 Mbit/s uplink
  // produces the starved picture that drifts off the audio. Holding at 720
  // is the same decision in a two-seat watch party as in a hundred-seat one.
  return canRaiseHlsTop(hls) ? wanted : LARGE_ROOM_SCREEN_HEIGHT;
}

function shouldDropHlsTop(hls: HlsSourceInput): boolean {
  if (hls.limitedBy === "bandwidth" || hls.limitedBy === "cpu") {
    return true;
  }
  // Unmeasured is a refusal, including when we are already at 1080. Overlaying
  // currentHeight must not turn "we have not looked" into "keep 1080".
  if (hls.uplinkBps === null) {
    return true;
  }
  return hls.uplinkBps < HLS_HELD_720_BITRATE;
}

function canRaiseHlsTop(hls: HlsSourceInput): boolean {
  if (hls.uplinkBps === null) {
    return false;
  }
  if (hls.limitedBy === "bandwidth" || hls.limitedBy === "cpu") {
    return false;
  }
  const ceiling = hls.currentCeilingBps ?? HLS_HELD_720_BITRATE;
  return hls.uplinkBps >= ceiling * HLS_SOURCE_UPLINK_HEADROOM;
}

export function screenSimulcastPlan(
  quality: VideoQuality,
  participantCount: number,
  hls: HlsSourceInput | null = null,
): ScreenSimulcastPlan {
  const chosenHeight =
    quality === "auto" ? SCREEN_CAPTURE_HEIGHT : SCREEN_HEIGHTS[quality];
  const hlsTop = hlsSourceTopHeight(quality, hls);
  const holdAt720 = hlsTop === LARGE_ROOM_SCREEN_HEIGHT;
  const largeRoomCapped =
    hlsTop === null && isLargeRoomCapped(quality, participantCount);
  const topHeight =
    holdAt720 || largeRoomCapped
      ? Math.min(chosenHeight, LARGE_ROOM_SCREEN_HEIGHT)
      : chosenHeight;
  const topBitrate = holdAt720
    ? HLS_HELD_720_BITRATE
    : largeRoomCapped
      ? Math.min(screenBitrateFor(quality), LARGE_ROOM_SCREEN_BITRATE)
      : hlsTop !== null
        ? // The share is now the ladder's source, so it gets the rung's own
          // ceiling rather than Auto's compromise 3 Mbit/s.
          Math.max(screenBitrateFor(quality), SCREEN_BITRATES["1080p"])
        : screenBitrateFor(quality);
  return {
    topHeight,
    topBitrate,
    lowerLayers: screenShareSimulcastEnabled(hls)
      ? SCREEN_SIMULCAST_RUNGS.filter((layer) => layer.height < topHeight)
      : [],
    // Only "the room decided" counts. Somebody who chose 720p in a big room
    // is sending what they asked for, and the menu must not tell them the
    // room made them do it. HLS hold is `heldForHls`, not this.
    capped: largeRoomCapped && topHeight < chosenHeight,
    heldForHls: holdAt720 && topHeight < chosenHeight,
  };
}

/**
 * Watch-party HLS ingest is one encoding. Simulcast sublayers starve the
 * only layer egress uses (`SetSubscribed(true)`, no layer preference):
 * libwebrtc feeds BWE bottom-up, so 360p and 720p eat the budget the
 * 1080 top needs, Chrome scales the remainder (427×240 is not a published
 * rung), and every playlist viewer transcodes that hunting source.
 *
 * Ordinary SFU screen share and mesh DM calls keep the ladder.
 */
export function screenShareSimulcastEnabled(
  hls: HlsSourceInput | null,
): boolean {
  return hls === null || hls.ladderTopHeight === null;
}

/**
 * HLS ingest must not drop pixels. After PR 474 Chrome still
 * `maintain-framerate`s the one encoding 1080 → 540 → 360 → 180 while
 * bitrate stays hundreds of kbps; egress transcodes that 180p for
 * everyone. Viewers ABR via the HLS ladder, so fps/bitrate can still
 * drop — pixels must not.
 *
 * Mesh DMs and ordinary SFU shares keep `maintain-framerate`.
 */
export function screenShareDegradationPreference(
  hls: HlsSourceInput | null,
): "maintain-framerate" | "maintain-resolution" {
  return screenShareSimulcastEnabled(hls)
    ? "maintain-framerate"
    : "maintain-resolution";
}

/**
 * Pin the HLS encoding at capture size so GCC cannot invent 180p
 * (`scaleResolutionDownBy` is a divisor; 1 is "the capture as captured").
 * Ordinary SFU shares leave this unset so LiveKit can solve the simulcast
 * ladder.
 */
export function screenShareScaleResolutionDownBy(
  hls: HlsSourceInput | null,
): 1 | undefined {
  return screenShareSimulcastEnabled(hls) ? undefined : 1;
}

/**
 * Same slack as the server's `SOURCE_HEIGHT_SLACK`: a 1078-line window is a
 * 1080p share, not a reason to drop the top rung.
 */
const CAPTURE_HEIGHT_SLACK = 16;

const SCREEN_PLAN_HEIGHTS = [1080, 720, 480, 360] as const;

/**
 * Declare no LiveKit layer taller than the capture actually is.
 *
 * A 480p window cannot invent 1080 pixels. Publishing 1080 layers anyway
 * makes LiveKit report `track.height = 1080`, the HLS ladder starts 1080
 * and 720 rungs that upscale, and the encoder then republishes when it
 * notices — a new sid, a torn-down party. Production 2026-09-10: host
 * sending 853×480, ladder advertised 1080p30/720p30/480p30, then
 * `screen-track-replaced` every couple of minutes.
 */
export function clampScreenPlanToCapture(
  plan: ScreenSimulcastPlan,
  captureHeight: number | null | undefined,
): ScreenSimulcastPlan {
  if (
    captureHeight == null ||
    captureHeight <= 0 ||
    captureHeight + CAPTURE_HEIGHT_SLACK >= plan.topHeight
  ) {
    return plan;
  }
  const topHeight =
    SCREEN_PLAN_HEIGHTS.find(
      (height) => height <= captureHeight + CAPTURE_HEIGHT_SLACK,
    ) ?? 360;
  if (topHeight === plan.topHeight) {
    return plan;
  }
  const topBitrate =
    topHeight >= 1080
      ? SCREEN_BITRATES["1080p"]
      : topHeight >= 720
        ? SCREEN_BITRATES["720p"]
        : topHeight >= 480
          ? SCREEN_BITRATES["480p"]
          : SCREEN_BITRATES["360p"];
  return {
    topHeight,
    topBitrate: Math.min(plan.topBitrate, topBitrate),
    // Keep the plan's own rungs. Rebuilding from SCREEN_SIMULCAST_RUNGS
    // reintroduces the 720 mid-layer a live HLS plan already dropped
    // (`heldForHls` is only the 720 hold, not "HLS is transcoding").
    lowerLayers: plan.lowerLayers.filter((layer) => layer.height < topHeight),
    capped: plan.capped,
    heldForHls: plan.heldForHls,
  };
}

// -------------------------------------------------- SFU simulcast: the camera

/**
 * The smaller copies a camera encodes alongside the picture it captured.
 *
 * WHY THIS EXISTS, AND WHY IT IS THE WHOLE FEATURE. The camera published with
 * `simulcast: false` until now, so there was exactly one copy of a face on the
 * server and every viewer received it whatever size their tile was. In a
 * two-person call that is invisible. In a room of twenty with twenty cameras
 * it is twenty full-size streams into every phone, which is roughly 30 Mbit/s
 * down and twenty simultaneous decodes, and that is the reason the product had
 * a headcount cap instead of a room. `adaptiveStream` has been on the whole
 * time and had nothing to choose from: it can only ask the SFU for a smaller
 * layer that the publisher actually encodes. These are those layers.
 *
 * THE NUMBERS ARE THIS FILE'S OWN. The mid rung is `PROFILES["360p"]`
 * unchanged (640x360, 400 kbps), because "360p" has to mean the same picture
 * whether it was chosen in the menu or picked by a viewer's tile size. The low
 * rung is 320x180, which is not on the menu and does not need to be: it is a
 * thumbnail in a grid of twenty, and the menu's job is to name what you send,
 * not every size the server may forward.
 *
 * FRAME RATE FALLS WITH SIZE ON THE BOTTOM RUNG ONLY. 20 fps at 180 lines
 * rather than 30 because motion is the expensive half of a face and a
 * thumbnail is the one place nobody can see the difference; the mid rung keeps
 * 30 because a 360p tile in a six-person grid is a picture somebody is
 * actually watching. `livekit-client` takes the smaller of the rung's frame
 * rate and the top layer's, so these are ceilings like everything else here.
 *
 * WHAT IT COSTS THE PUBLISHER. Three encodes instead of one, which is real on
 * a phone and roughly 20% of one encode each for the two small ones. Dynacast
 * (`livekit-session.ts`) is what makes that acceptable: the server tells the
 * publisher to stop encoding a layer nobody is asking for, so a call where
 * everybody has a large tile pays for one layer, and the ladder only costs
 * what it is being used for.
 */
export type CameraLayer = ScreenLayer;

export const CAMERA_SIMULCAST_RUNGS: readonly CameraLayer[] = [
  { width: 320, height: 180, maxBitrate: 160_000, maxFramerate: 20 },
  { width: 640, height: 360, maxBitrate: 400_000, maxFramerate: 30 },
];

/**
 * The rungs strictly below a camera's captured height, smallest first.
 *
 * WHAT `livekit-client` 2.21.0 DOES WITH THEM (`computeVideoEncodings`, and
 * `livekit-session-quality.test.ts` says this out loud so a library bump that
 * changes it fails rather than quietly publishes one layer again): the list is
 * handed over as `videoSimulcastLayers`, the library sorts it, takes the
 * lowest as `q` and the second as `h`, and puts the capture itself on top as
 * `f`. It only builds three layers when the capture's LONGER side is at least
 * 960 px, and only two above 480 px, so a 720p camera gets all three, a 480p
 * webcam gets two, and a 320x240 virtual camera gets one. Filtering here as
 * well is belt and braces: a rung at or above the capture would be an upscale,
 * which spends bitrate inventing pixels exactly as `screenScaleFactor` refuses
 * to.
 */
export function cameraSimulcastRungs(
  captureHeight: number,
): readonly CameraLayer[] {
  return CAMERA_SIMULCAST_RUNGS.filter((rung) => rung.height < captureHeight);
}

/**
 * The rungs for a chosen quality, before the camera has reported its size.
 *
 * The capture is asked for `cameraProfileFor(quality).height` and a webcam
 * that cannot manage it hands back something smaller, so this is the plan for
 * the size we asked for. It does not need to be re-derived when the real size
 * arrives: an extra rung that the capture turns out to sit below is dropped by
 * the library's own size rule above, and a rung that is genuinely too large is
 * the only case this filter exists for.
 */
export function cameraSimulcastRungsFor(
  quality: VideoQuality,
): readonly CameraLayer[] {
  return cameraSimulcastRungs(cameraProfileFor(quality).height);
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
  deviceId?: string,
): MediaTrackConstraints {
  const profile = cameraProfileFor(quality);
  const constraints: MediaTrackConstraints = {
    width: { ideal: profile.width },
    height: { ideal: profile.height },
    frameRate: { ideal: profile.frameRate },
  };
  if (deviceId) {
    constraints.deviceId = { exact: deviceId };
  }
  return constraints;
}

export function cameraBitrateFor(quality: VideoQuality): number {
  return cameraProfileFor(quality).maxBitrate;
}

/**
 * The room size above which 1080p is not offered at all, and the second rule
 * that removes it whatever the size: a live HLS egress.
 *
 * WHY 150. `LARGE_ROOM_PARTICIPANTS` (20) only holds Auto to 720p and lets an
 * explicit 1080p through, because in a room of thirty the presenter saying
 * "spend it" is a reasonable thing to honour. Past a hundred and fifty it is
 * not: the SFU fans the top layer out once per viewer, so a 1080p top layer
 * in a room that size is several hundred megabits of downstream that nobody
 * in the audience asked for and most of them, on phones, cannot even show.
 * At that size the room is a broadcast and the honest ceiling is 720p.
 *
 * WHY HLS. When the egress is live it decodes the share once and encodes its
 * own preset; every playlist viewer receives that, not the WebRTC layer. A
 * 1080p share then costs the presenter's uplink and the egress's decode and
 * reaches no viewer at 1080p, so the rung is pure cost. Dropped rather than
 * capped so the menu does not offer a choice that changes nothing.
 *
 * IN-CALL ONLY. The settings dialog keeps the full list: there is no room
 * there to measure, and a stored 1080p is still the right default for the
 * next small call. The call's own menu is where the rule acts, and
 * `coerceVideoQuality` is what it shows for a stored rung that is not on
 * offer right now.
 */
export const HUGE_ROOM_1080P_LIMIT = 150;

/**
 * The rungs the call's menu may offer, given the room and the egress.
 *
 * A live egress used to remove 1080p here, on the reasoning that playlist
 * viewers get the egress's single preset and never the WebRTC layer, so a
 * 1080p share was pure cost. That reasoning died with the single preset: the
 * ladder's top rung is transcoded FROM the published track, so a share held
 * to 720p caps every viewer at 720p no matter what the ladder says. 1080p
 * with a live egress is now the case the whole feature is for, and
 * `screenSimulcastPlan` raises the published top to match it.
 *
 * The size rule stays. Past a hundred and fifty people the room is a
 * broadcast, and whatever the transport, that is not a size at which one
 * presenter's menu should be able to spend the box.
 */
export function availableVideoQualities(input: {
  participantCount: number;
  hlsLive: boolean;
}): readonly VideoQuality[] {
  return input.participantCount > HUGE_ROOM_1080P_LIMIT
    ? VIDEO_QUALITIES.filter((quality) => quality !== "1080p")
    : VIDEO_QUALITIES;
}

/**
 * What a stored choice reads as when the menu cannot offer it: a 1080p that
 * is off the list is Auto, which is the rung that lets the room decide. The
 * stored preference itself is untouched, so the next small call gets it back.
 */
export function coerceVideoQuality(
  quality: VideoQuality,
  available: readonly VideoQuality[],
): VideoQuality {
  return available.includes(quality) ? quality : DEFAULT_VIDEO_QUALITY;
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
  deviceId?: string,
): Promise<MediaStream> {
  try {
    return await getUserMedia({
      video: cameraConstraintsFor(quality, deviceId),
      audio: false,
    });
  } catch (err) {
    // The saved camera is gone. Try any camera at the same quality rather
    // than leaving the button dead over a device id that no longer exists.
    if (
      deviceId &&
      err instanceof Error &&
      err.name === "NotFoundError"
    ) {
      return captureCamera(getUserMedia, quality);
    }
    if (isFatalCaptureError(err)) {
      throw err;
    }
    console.warn(
      "[pqp] camera refused the requested size; falling back to defaults",
      err,
    );
    return getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
      audio: false,
    });
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
