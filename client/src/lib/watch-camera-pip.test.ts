import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAMERA_PIP_CORNERS,
  CAMERA_PIP_STAGE_CLASS,
  cameraPipBoxes,
  cameraPipCornerClass,
  cameraPipFrameClass,
  cameraPipMounted,
  DEFAULT_CAMERA_PIP,
  nextCameraPipCorner,
  parseCameraPipPref,
  readCameraPipPref,
  writeCameraPipPref,
  type CameraPipPref,
} from "./watch-camera-pip";

/**
 * The rules a viewer notices immediately when they are wrong: a webcam over
 * the subtitles, a corner that forgets itself between films, a PiP that stays
 * up in fullscreen, a rectangle where a broken camera should be nothing at
 * all. `hls-watch-player.tsx` cannot be driven past its first render in this
 * suite, so these live here or nothing checks them.
 */

const pref = (over: Partial<CameraPipPref> = {}): CameraPipPref => ({
  ...DEFAULT_CAMERA_PIP,
  ...over,
});

describe("whether the camera player exists at all", () => {
  const live = {
    cameraSrc: "https://api.test/api/voice/hls-playlist/c/1/cam360p30",
    fullscreen: false,
    cinema: true,
  };

  it("is on when the server is running a camera transcode", () => {
    expect(cameraPipMounted(live)).toBe(true);
  });

  it("is off when there is no camera playlist", () => {
    // The ordinary film night: no webcam on, or the box refused it for
    // budget, or `LIVE_HLS_CAMERA=false`.
    expect(cameraPipMounted({ ...live, cameraSrc: null })).toBe(false);
    expect(cameraPipMounted({ ...live, cameraSrc: undefined })).toBe(false);
  });

  it("is off in fullscreen, and UNMOUNTED rather than hidden", () => {
    // The product instruction as given. Unmounted matters: a camera nobody
    // can see must not go on decoding 360p for a whole film.
    expect(cameraPipMounted({ ...live, fullscreen: true })).toBe(false);
    expect(
      cameraPipBoxes({ mounted: false, hasFrame: true, pref: pref() }).camera,
    ).toBeNull();
  });

  it("is off in a grid tile", () => {
    // A webcam inside a share tile is a picture in a picture in a picture,
    // and the tile chrome has nowhere to put the controls.
    expect(cameraPipMounted({ ...live, cinema: false })).toBe(false);
  });
});

describe("which picture gets which box", () => {
  it("gives the film the stage and nothing else when there is no camera", () => {
    expect(cameraPipBoxes({ mounted: false, hasFrame: false, pref: pref() })).toEqual({
      film: CAMERA_PIP_STAGE_CLASS,
      camera: null,
      corner: null,
    });
  });

  it("draws nothing at all until a frame arrives", () => {
    // MOUNTED AND HAS-A-FRAME ARE DIFFERENT QUESTIONS. Collapsing them is a
    // deadlock: an element that is not rendered never decodes a frame. So it
    // is mounted and `invisible`, and there is no control over it, because a
    // camera that never produces a frame must cost the film nothing — not
    // even a rectangle, which is exactly what reads as "this is broken".
    const boxes = cameraPipBoxes({ mounted: true, hasFrame: false, pref: pref() });
    expect(boxes.film).toBe(CAMERA_PIP_STAGE_CLASS);
    expect(boxes.camera).toContain("invisible");
    expect(boxes.corner).toBeNull();
  });

  it("floats the camera in the corner once it is playing", () => {
    const boxes = cameraPipBoxes({ mounted: true, hasFrame: true, pref: pref() });
    expect(boxes.film).toBe(CAMERA_PIP_STAGE_CLASS);
    expect(boxes.camera).toBe(cameraPipCornerClass("bottom-right"));
    expect(boxes.corner).toBe(cameraPipFrameClass("bottom-right"));
  });

  it("swaps the BOXES, so neither player is re-attached", () => {
    // The whole of the swap. Re-attaching to look at a webcam would rebuffer
    // the film, which is the thing the audience actually came for.
    const swapped = cameraPipBoxes({
      mounted: true,
      hasFrame: true,
      pref: pref({ onStage: true }),
    });
    expect(swapped.camera).toBe(CAMERA_PIP_STAGE_CLASS);
    expect(swapped.film).toBe(cameraPipCornerClass("bottom-right"));
  });

  it("keeps the film on the stage while a swapped camera has no frame", () => {
    // Somebody who left it swapped last time must not open a party to a black
    // rectangle where the film should be.
    expect(
      cameraPipBoxes({
        mounted: true,
        hasFrame: false,
        pref: pref({ onStage: true }),
      }).film,
    ).toBe(CAMERA_PIP_STAGE_CLASS);
  });

  it("puts the click target in the corner with no look of its own", () => {
    // It sits over whichever picture is in the corner, so it must not carry
    // the background or the border: a control that is sometimes opaque hides
    // the thing it is controlling.
    const frame = cameraPipFrameClass("top-left");
    expect(frame).not.toContain("bg-black");
    expect(frame).not.toContain("border");
    expect(cameraPipCornerClass("top-left")).toContain(frame);
  });

  it("never puts the corner under the control bar", () => {
    // The pictures are z-20 and the chrome is z-50; the click target is
    // between them. A viewer who cannot reach the volume because a webcam is
    // over it has lost more than they gained.
    expect(cameraPipCornerClass("bottom-right")).toContain("z-20");
  });
});

describe("the corner the viewer picked", () => {
  it("cycles through all four and comes back", () => {
    let corner = DEFAULT_CAMERA_PIP.corner;
    const seen = new Set([corner]);
    for (let press = 0; press < CAMERA_PIP_CORNERS.length - 1; press += 1) {
      corner = nextCameraPipCorner(corner);
      seen.add(corner);
    }
    expect(seen.size).toBe(CAMERA_PIP_CORNERS.length);
    expect(nextCameraPipCorner(corner)).toBe(DEFAULT_CAMERA_PIP.corner);
  });

  it("gives every corner a distinct position", () => {
    const positions = CAMERA_PIP_CORNERS.map(cameraPipFrameClass);
    expect(new Set(positions).size).toBe(CAMERA_PIP_CORNERS.length);
  });
});

describe("remembering it", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips a choice", () => {
    writeCameraPipPref({ corner: "top-left", onStage: true });
    expect(readCameraPipPref()).toEqual({ corner: "top-left", onStage: true });
  });

  it("falls back to the default rather than trusting what it read", () => {
    expect(parseCameraPipPref(null)).toEqual(DEFAULT_CAMERA_PIP);
    expect(parseCameraPipPref("bottom-left")).toEqual(DEFAULT_CAMERA_PIP);
    expect(parseCameraPipPref({ corner: "middle" })).toEqual(DEFAULT_CAMERA_PIP);
    expect(parseCameraPipPref({ corner: "top-right", onStage: "yes" })).toEqual({
      corner: "top-right",
      onStage: false,
    });
  });

  it("survives storage that throws outright", () => {
    // A private window, a thumbnail capture, a browser set to block site
    // data. A watch party that fails to draw because a corner preference
    // could not be read would be a spectacular way to lose a film.
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(readCameraPipPref()).toEqual(DEFAULT_CAMERA_PIP);
    expect(() => writeCameraPipPref({ corner: "top-left", onStage: true })).not.toThrow();
  });

  it("survives a stored value that is not JSON", () => {
    store.set("pqp:watch-camera-pip", "{not json");
    expect(readCameraPipPref()).toEqual(DEFAULT_CAMERA_PIP);
  });
});
