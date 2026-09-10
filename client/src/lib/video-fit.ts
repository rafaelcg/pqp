/**
 * Whether a picture fills its tile and loses its edges, or fits inside it and
 * keeps them.
 *
 * WHY. A tile is a fixed box and a video is whatever shape the camera or the
 * monitor is, so one of the two has to give. `object-cover` crops until the
 * picture covers the box; `object-contain` shrinks until the whole picture is
 * inside it, with bars in whichever direction is left over. Neither is right
 * for everything, which is why this is a preference and not a constant.
 *
 * TWO PREFERENCES, ONE PER KIND OF PICTURE, and today's behaviour is the
 * default of each. A camera is a face, and a face is better cropped than
 * letterboxed: nothing that matters lives in the corners of a webcam frame.
 * A shared screen is the opposite, and the thing being presented is very
 * often exactly what a crop would eat — a toolbar, a terminal's left margin,
 * the row of tabs. The stage has drawn them that way from the start
 * (`CameraTile` covers, `ScreenTileFrame` contains); all this adds is the
 * other half of each, without moving anybody's first render.
 *
 * A single shared switch was the obvious cheaper design and it is wrong: one
 * value has to start somewhere, and either default silently changes how one
 * of the two kinds of tile has always looked.
 *
 * GLOBAL PER KIND, NOT PER TILE. "Show me the whole picture" is a statement
 * about how somebody wants to watch, not about one person in the room, and a
 * grid of eight tiles is eight decisions nobody wants to make. It is also the
 * only version that can be remembered: a per-tile choice would have to be
 * keyed on a peer id, and a peer id does not survive a rejoin, so the memory
 * would evaporate exactly when the call got interesting.
 *
 * IT DOES NOT CHANGE WHAT IS DELIVERED. livekit's `adaptiveStream` measures
 * the `<video>` ELEMENT, and both values leave the element the full size of
 * its tile; only the painting inside it differs. So contain shows a smaller
 * picture in the same box and asks the SFU for no more than cover did.
 * `video-fit.test.ts` pins that the class is the only thing that changes.
 */

export type VideoFit = "cover" | "contain";

/**
 * Which kind of picture. Each is remembered separately.
 *
 * `watch` is the HLS watch stage, and it is deliberately NOT the same value as
 * `screen` even though both are somebody's monitor. The question is the same
 * but the context is not: a `screen` tile sits in a grid beside faces, where
 * a crop eats a toolbar and is almost never wanted, while the watch stage owns
 * a whole pane and somebody watching a 16:9 film on a 16:10 pane may quite
 * reasonably want the bars gone. One shared value would make choosing in one
 * place silently change the other, which is the mistake the two existing kinds
 * were split to avoid.
 *
 * It defaults to `contain` like `screen`, so nothing about a first render
 * changes.
 */
export type VideoFitKind = "camera" | "screen" | "watch";

export type VideoFitPreference = Record<VideoFitKind, VideoFit>;

export const VIDEO_FIT_DEFAULT: VideoFitPreference = {
  camera: "cover",
  screen: "contain",
  watch: "contain",
};

const STORAGE_KEY = "pqp:video-fit";

/** The one Tailwind class the choice comes down to. */
export function videoFitClass(fit: VideoFit): string {
  return fit === "contain" ? "object-contain" : "object-cover";
}

export function toggledVideoFit(fit: VideoFit): VideoFit {
  return fit === "contain" ? "cover" : "contain";
}

function readFit(value: unknown, fallback: VideoFit): VideoFit {
  return value === "cover" || value === "contain" ? value : fallback;
}

/**
 * PURELY LOCAL, for the reason `call-split` is: this is an opinion about a
 * screen, not about a person. The 27-inch monitor and the laptop want
 * different answers and syncing would be wrong on one of them every time.
 */
export function loadVideoFit(): VideoFitPreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return VIDEO_FIT_DEFAULT;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return VIDEO_FIT_DEFAULT;
    }
    const value = parsed as Partial<Record<VideoFitKind, unknown>>;
    return {
      camera: readFit(value.camera, VIDEO_FIT_DEFAULT.camera),
      screen: readFit(value.screen, VIDEO_FIT_DEFAULT.screen),
      watch: readFit(value.watch, VIDEO_FIT_DEFAULT.watch),
    };
  } catch {
    // Denied storage, or half-written JSON. Both defaults are a working
    // stage; a thrown reader is a black rectangle.
    return VIDEO_FIT_DEFAULT;
  }
}

export function saveVideoFit(preference: VideoFitPreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // The toggle still works for this session; only the memory is lost.
  }
}
