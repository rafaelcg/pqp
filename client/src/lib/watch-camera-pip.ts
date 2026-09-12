/**
 * The presenter's camera, floating over their film.
 *
 * WHAT IT IS. A watch party's audience is seatless — nobody outside the room
 * holds a LiveKit seat — so a camera published into the room reaches the
 * seated participants and nobody on the playlist. The server therefore runs a
 * second, video-only 360p30 egress beside the ladder and states its playlist
 * as `LiveHlsStream.cameraHlsUrl`. This module is the viewer's half of that:
 * where the picture-in-picture sits, whether it is showing at all, and which
 * of the two pictures is on the stage. See
 * `docs/plans/WATCH_PARTY_CAMERA_PIP.md`.
 *
 * WHY IT IS A SEPARATE MODULE. Everything here is pure and everything here is
 * a rule a person will notice immediately if it is wrong: a webcam covering
 * the subtitles, a corner that forgets itself between films, a PiP that stays
 * up in fullscreen. `hls-watch-player.tsx` is a 1,400-line component whose
 * tests cannot reach past the first render, so a rule that lives inside it is
 * a rule nothing checks.
 *
 * THE STAGE AND THE CORNER ARE BOXES, NOT PLAYERS. Swapping changes which
 * `<video>` gets which class, and nothing else: neither hls.js instance is
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

export interface CameraPipPref {
  corner: CameraPipCorner;
  /**
   * The camera is the big picture and the film is the thumbnail.
   *
   * Remembered like the corner, because somebody who wants to watch the
   * host's face wants it for the whole party, not for one render.
   */
  onStage: boolean;
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
  onStage: false,
};

const STORAGE_KEY = "pqp:watch-camera-pip";

export function parseCameraPipPref(raw: unknown): CameraPipPref {
  if (!raw || typeof raw !== "object") {
    return DEFAULT_CAMERA_PIP;
  }
  const value = raw as Partial<CameraPipPref>;
  return {
    corner: CAMERA_PIP_CORNERS.includes(value.corner as CameraPipCorner)
      ? (value.corner as CameraPipCorner)
      : DEFAULT_CAMERA_PIP.corner,
    onStage: value.onStage === true,
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
 * Whether the camera player exists on this stage at all.
 *
 * THREE CONDITIONS, AND THE LAST TWO ARE THE ONES WORTH ARGUING ABOUT.
 *
 *  - A `cameraHlsUrl`: the server is running a camera transcode. Absent for a
 *    host with no webcam on, for a box that refused it on budget, and for
 *    `LIVE_HLS_CAMERA=false`.
 *  - **Not fullscreen.** The product instruction as given: fullscreen is the
 *    film and nothing else. Unmounted rather than hidden, so a camera nobody
 *    can see never costs a decode.
 *  - Cinema layout only. A webcam inside a grid tile is a picture in a
 *    picture in a picture, and the tile chrome has no room for the controls.
 */
export function cameraPipMounted(input: {
  cameraSrc: string | null | undefined;
  fullscreen: boolean;
  cinema: boolean;
}): boolean {
  return Boolean(input.cameraSrc) && !input.fullscreen && input.cinema;
}

/** The full-bleed picture. */
export const CAMERA_PIP_STAGE_CLASS = "absolute inset-0 h-full w-full";

/**
 * The corner box.
 *
 * Percentages with a floor and a ceiling: 24 % of a 1440px pane is a 345px
 * webcam, which is about right, and the same 24 % of a phone-width pane is
 * 96px, which is a smudge. `min-w` and `max-w` are what keep it a face at
 * both ends. `z-20` puts it over the film and under the chrome (z-50), so the
 * control bar is never behind a webcam.
 */
const CAMERA_PIP_FRAME_CLASS =
  "absolute aspect-video w-[24%] min-w-[128px] max-w-[280px]";

/** The look, which only the picture wants and the click target must not have. */
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
 * Split from the skin because the click target sits in exactly this box and
 * must NOT carry the background, the border or the rounding: overriding
 * `bg-black` with `bg-transparent` further down a class string is not
 * something Tailwind guarantees, and a control that is sometimes opaque is a
 * control that sometimes hides the picture it is controlling.
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
  /** Classes for the camera's `<video>`, or null when it is not mounted. */
  camera: string | null;
  /** Classes for the click target over whichever picture is in the corner. */
  corner: string | null;
}

/**
 * Which picture gets which box.
 *
 * The whole of the swap, in one pure function, so all four states read at
 * once. `corner` is non-null exactly when there is something to click, which
 * is what stops a swap control existing with nothing to swap.
 *
 * `mounted` AND `hasFrame` ARE DIFFERENT QUESTIONS, and collapsing them is a
 * deadlock: a camera that is not rendered never decodes a frame, so gating the
 * element on having one means it never gets one. Mounted is "the player
 * exists and is loading"; a frame is what makes it worth looking at. Between
 * the two it is `invisible` rather than absent — one or two seconds, once.
 *
 * Fullscreen unmounts it outright rather than hiding it, so a hidden webcam
 * never costs a decode for a whole film.
 */
export function cameraPipBoxes(input: {
  mounted: boolean;
  hasFrame: boolean;
  pref: CameraPipPref;
}): CameraPipBoxes {
  if (!input.mounted) {
    return { film: CAMERA_PIP_STAGE_CLASS, camera: null, corner: null };
  }
  const corner = cameraPipCornerClass(input.pref.corner);
  const frame = cameraPipFrameClass(input.pref.corner);
  if (!input.hasFrame) {
    // Loading, and drawing nothing. A camera that never produces a frame must
    // cost the film nothing, not even a rectangle: a rectangle is exactly
    // what a viewer reads as the feature being broken.
    return {
      film: CAMERA_PIP_STAGE_CLASS,
      camera: `${corner} invisible`,
      corner: null,
    };
  }
  return input.pref.onStage
    ? { film: corner, camera: CAMERA_PIP_STAGE_CLASS, corner: frame }
    : { film: CAMERA_PIP_STAGE_CLASS, camera: corner, corner: frame };
}
