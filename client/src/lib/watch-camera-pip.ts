/**
 * The presenter's camera, floating over their film.
 *
 * WHAT IT IS. A watch party's audience is seatless — nobody outside the room
 * holds a LiveKit seat — so a camera published into the room reaches the
 * seated participants and nobody on the playlist. The server therefore runs a
 * second, video-only egress (480p, or 360p) beside the ladder and states its playlist
 * as `LiveHlsStream.cameraHlsUrl`. This module is the viewer's half of that:
 * where the picture-in-picture sits, whether it is showing at all, and which
 * of the two pictures is on the stage. See `docs/WATCH_PARTY.md`, "The
 * presenter's camera, floating over the film".
 *
 * WHY IT IS A SEPARATE MODULE. Everything here is pure and everything here is
 * a rule a person will notice immediately if it is wrong: a webcam covering
 * the subtitles, a corner that forgets itself between films, a PiP that stays
 * up in fullscreen. `hls-watch-player.tsx` is a 1,500-line component whose
 * tests cannot reach past the first render, so a rule that lives inside it is
 * a rule nothing checks.
 *
 * THE STAGE AND THE CORNER ARE BOXES, NOT PLAYERS. A layout change moves
 * which `<video>` gets which class, and nothing else: neither hls.js instance is
 * re-attached, so nobody rebuffers to look at a webcam, and the control bar
 * stays where it is because it belongs to the stage rather than to a picture.
 */

export const CAMERA_PIP_CORNERS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;

export type CameraPipCorner = (typeof CAMERA_PIP_CORNERS)[number];

/**
 * HOW THE VIEWER WANTS THE TWO PICTURES (2026-09-25), Rafael's four:
 *
 *  - `pip`: the default. The film on the stage, the webcam small in a corner.
 *  - `side`: the two next to each other; stacked, film on top, on a stage
 *    narrower than a phone held sideways (`CAMERA_SIDE_*_CLASS`).
 *  - `stream`: "hide webcam". The film alone. The camera's player is
 *    UNMOUNTED, so its playlist stops downloading and nothing decodes it,
 *    unless it is also carrying the presenter's voice ("separada"), which a
 *    hidden webcam must not silence: then it stays, drawn as the voice-only
 *    corner.
 *  - `camera`: "hide stream". The webcam on the stage, alone. The film's
 *    player keeps playing underneath, covered, because it is the one carrying
 *    the audio (the party's sound is mixed into it), and detaching it would
 *    be exactly the rebuffer this module exists to avoid: switching back has
 *    to be instant. Covered, not `display: none`, so no browser treats it as
 *    an offscreen video it may pause.
 */
export const CAMERA_LAYOUTS = ["pip", "side", "stream", "camera"] as const;

export type CameraLayout = (typeof CAMERA_LAYOUTS)[number];

export interface CameraPipPref {
  corner: CameraPipCorner;
  /** Which of the four. Remembered like the corner: a whole-party choice. */
  layout: CameraLayout;
}

/**
 * Bottom right, film on the stage.
 *
 * Bottom right because that is where every video call in the world puts the
 * small picture, and because the top of this player is where the audience
 * count, the leave button and the live badge already live. The corner is
 * movable precisely because "bottom right" is wrong for the one film whose
 * subtitles are burnt in down there.
 */
export const DEFAULT_CAMERA_PIP: CameraPipPref = {
  corner: "bottom-right",
  layout: "pip",
};

const STORAGE_KEY = "pqp:watch-camera-pip";

/**
 * A stored preference, defensively. An entry written before the layouts
 * existed carried `onStage` (the old swap, camera big and film small); it is
 * read as the default rather than as "hide stream", because opening a party
 * to no film at all is not what that person asked for.
 */
export function parseCameraPipPref(raw: unknown): CameraPipPref {
  if (!raw || typeof raw !== "object") {
    return DEFAULT_CAMERA_PIP;
  }
  const value = raw as Partial<Record<keyof CameraPipPref, unknown>>;
  return {
    corner: CAMERA_PIP_CORNERS.includes(value.corner as CameraPipCorner)
      ? (value.corner as CameraPipCorner)
      : DEFAULT_CAMERA_PIP.corner,
    layout: CAMERA_LAYOUTS.includes(value.layout as CameraLayout)
      ? (value.layout as CameraLayout)
      : DEFAULT_CAMERA_PIP.layout,
  };
}

/**
 * Per browser, and never a reason for the player not to render.
 *
 * Every read and write is wrapped: `localStorage` throws outright in a
 * thumbnail capture and in a browser set to block site data, and a watch party
 * that fails to draw because a corner preference could not be read would be a
 * spectacular way to lose a film.
 */
export function readCameraPipPref(): CameraPipPref {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? parseCameraPipPref(JSON.parse(raw)) : DEFAULT_CAMERA_PIP;
  } catch {
    return DEFAULT_CAMERA_PIP;
  }
}

export function writeCameraPipPref(next: CameraPipPref): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A per-viewer convenience, not state anything depends on.
  }
}

/** The next corner, clockwise. Four presses is where you started. */
export function nextCameraPipCorner(corner: CameraPipCorner): CameraPipCorner {
  const index = CAMERA_PIP_CORNERS.indexOf(corner);
  return CAMERA_PIP_CORNERS[(index + 1) % CAMERA_PIP_CORNERS.length]!;
}

/**
 * Whether the viewer is offered the layout picker at all: only for a camera
 * that is a picture. No camera playlist is today's stage exactly, and the
 * audio-only "separada" shape (`cameraHasVideo` false) has nothing to lay out.
 */
export function cameraLayoutOffered(input: {
  cameraSrc: string | null | undefined;
  cameraHasVideo: boolean;
  cinema: boolean;
}): boolean {
  return Boolean(input.cameraSrc) && input.cameraHasVideo && input.cinema;
}

/** The layout in force: the viewer's, when there is a picture to lay out. */
export function effectiveCameraLayout(input: {
  pref: CameraPipPref;
  cameraHasVideo: boolean;
}): CameraLayout {
  return input.cameraHasVideo ? input.pref.layout : "pip";
}

/**
 * Whether the camera player exists on this stage at all.
 *
 *  - A `cameraHlsUrl`: the server is running a camera transcode. Absent for a
 *    host with no webcam on, for a box that refused it on budget, and for
 *    `LIVE_HLS_CAMERA=false`.
 *  - Cinema layout only. A webcam inside a grid tile (`tile`) is a picture in
 *    a picture in a picture, and the docked mini player (`mini`) is a 240px
 *    box with room for the film and almost nothing else.
 *  - **Not "hide webcam"**, unless the playlist carries the presenter's voice.
 *    Unmounted rather than hidden, so a camera nobody asked to see costs no
 *    download and no decode.
 *
 * FULLSCREEN NO LONGER UNMOUNTS IT (2026-09-25). It used to, when a corner
 * was the only way to show a camera and fullscreen meant "the film and
 * nothing else". With the picker, the viewer says what fullscreen shows:
 * whatever layout they chose, including "hide webcam" for the film alone.
 */
export function cameraPipMounted(input: {
  cameraSrc: string | null | undefined;
  cinema: boolean;
  layout: CameraLayout;
  hasVoiceAudio: boolean;
}): boolean {
  if (!input.cameraSrc || !input.cinema) {
    return false;
  }
  return input.layout !== "stream" || input.hasVoiceAudio;
}

/** The full-bleed picture. */
export const CAMERA_PIP_STAGE_CLASS = "absolute inset-0 h-full w-full";

/**
 * The camera as the whole stage ("hide stream"): full bleed, opaque, above the
 * film it covers and below the holding screens (`STAGE_LAYER.state`, z-10),
 * so a film that stalls still says so over the face.
 */
export const CAMERA_STAGE_CLASS = "absolute inset-0 z-[5] h-full w-full bg-black";

/**
 * Side by side, halves of the stage. Measured against the PLAYER's width
 * (`@container/watch` on its root), not the window's: the same stage is a
 * full desktop pane, a split beside the chat and a phone, and it is the box
 * that decides whether two 16:9 pictures fit next to each other. Under 36rem
 * (a phone held upright) they stack, film on top.
 */
export const CAMERA_SIDE_FILM_CLASS =
  "absolute inset-x-0 top-0 h-1/2 w-full @xl/watch:inset-y-0 @xl/watch:right-auto @xl/watch:h-full @xl/watch:w-1/2";
export const CAMERA_SIDE_CAMERA_CLASS =
  "absolute inset-x-0 bottom-0 h-1/2 w-full bg-black @xl/watch:inset-y-0 @xl/watch:left-auto @xl/watch:h-full @xl/watch:w-1/2";

/**
 * The corner box.
 *
 * Percentages with a floor and a ceiling: 24 % of a 1440px pane is a 345px
 * webcam, which is about right, and the same 24 % of a phone-width pane is
 * 96px, which is a smudge. `min-w` and `max-w` are what keep it a face at
 * both ends.
 */
const CAMERA_PIP_FRAME_CLASS =
  "absolute aspect-video w-[24%] min-w-[128px] max-w-[280px]";

/**
 * The look, which only the picture wants and the click target must not have.
 *
 * `z-20` puts the picture over the film and under the chrome (z-50), so the
 * control bar is never behind a webcam. The corner control is given z-30 by
 * its caller, between the two.
 */
const CAMERA_PIP_SKIN_CLASS =
  "z-20 overflow-hidden rounded-[var(--radius-card)] border border-paper/25 bg-black shadow-lg";

const CORNER_CLASS: Record<CameraPipCorner, string> = {
  // Clear of the chrome's own gradients: the top bar carries the audience
  // count and the actions, the bottom one the whole control bar.
  "top-left": "left-3 top-14",
  "top-right": "right-3 top-14",
  "bottom-left": "bottom-20 left-3",
  "bottom-right": "bottom-20 right-3",
};

/**
 * Where the corner is and how big, with no appearance of its own.
 *
 * Split from the skin because the corner control sits in exactly this box
 * and must NOT carry the background, the border or the rounding: a control
 * that is sometimes opaque is a control that sometimes hides the picture it
 * is controlling.
 */
export function cameraPipFrameClass(corner: CameraPipCorner): string {
  return `${CAMERA_PIP_FRAME_CLASS} ${CORNER_CLASS[corner]}`;
}

export function cameraPipCornerClass(corner: CameraPipCorner): string {
  return `${cameraPipFrameClass(corner)} ${CAMERA_PIP_SKIN_CLASS}`;
}

export interface CameraPipBoxes {
  /** Classes for the film's `<video>`. */
  film: string;
  /** Classes for the camera's box, or null when it is not mounted. */
  camera: string | null;
  /**
   * The box the corner control sits in, or null when there is no corner to
   * move (no frame yet, or a layout with no corner in it).
   */
  corner: string | null;
  /**
   * How the camera fills its box: `cover` in the corner (a face cropped to
   * 16:9 is still a face, and a letterboxed thumbnail is mostly black),
   * `contain` wherever it is one of the two main pictures.
   */
  cameraFit: "cover" | "contain";
  /**
   * The camera is mounted only for the presenter's voice ("hide webcam" in
   * "separada"): draw it as the voice-only corner, not as a picture.
   */
  cameraVoiceOnly: boolean;
}

/**
 * Which picture gets which box.
 *
 * All four layouts in one pure function, so every state reads at once, and
 * every one of them is a CLASS change: neither hls.js instance is ever
 * re-attached by a layout switch, so nobody rebuffers to look at a webcam and
 * the control bar stays where it is because it belongs to the stage.
 *
 * `mounted` AND `hasFrame` ARE DIFFERENT QUESTIONS, and collapsing them is a
 * deadlock: a camera that is not rendered never decodes a frame, so gating the
 * element on having one means it never gets one. Mounted is "the player
 * exists and is loading"; a frame is what makes it worth looking at. Between
 * the two it is `invisible` in the corner and the film keeps the whole stage
 * whatever the layout, so "side by side" or "hide stream" never opens on a
 * black half or a black stage while the camera loads.
 */
export function cameraPipBoxes(input: {
  mounted: boolean;
  hasFrame: boolean;
  pref: CameraPipPref;
  layout: CameraLayout;
}): CameraPipBoxes {
  const none: CameraPipBoxes = {
    film: CAMERA_PIP_STAGE_CLASS,
    camera: null,
    corner: null,
    cameraFit: "cover",
    cameraVoiceOnly: false,
  };
  if (!input.mounted) {
    return none;
  }
  const corner = cameraPipCornerClass(input.pref.corner);
  const frame = cameraPipFrameClass(input.pref.corner);
  if (input.layout === "stream") {
    // Mounted here only for the voice: the corner, drawn as the voice.
    return { ...none, camera: corner, cameraVoiceOnly: true };
  }
  if (!input.hasFrame) {
    // Loading, and drawing nothing. A camera that never produces a frame must
    // cost the film nothing, not even a rectangle: a rectangle is exactly
    // what a viewer reads as the feature being broken.
    return { ...none, camera: `${corner} invisible` };
  }
  switch (input.layout) {
    case "side":
      return {
        ...none,
        film: CAMERA_SIDE_FILM_CLASS,
        camera: CAMERA_SIDE_CAMERA_CLASS,
        cameraFit: "contain",
      };
    case "camera":
      return {
        ...none,
        camera: CAMERA_STAGE_CLASS,
        cameraFit: "contain",
      };
    default:
      return { ...none, camera: corner, corner: frame };
  }
}
