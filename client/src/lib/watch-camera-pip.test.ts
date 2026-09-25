import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAMERA_LAYOUTS,
  CAMERA_PIP_CORNERS,
  CAMERA_PIP_STAGE_CLASS,
  CAMERA_SIDE_CAMERA_CLASS,
  CAMERA_SIDE_FILM_CLASS,
  CAMERA_STAGE_CLASS,
  cameraLayoutOffered,
  cameraPipBoxes,
  cameraPipCornerClass,
  cameraPipFrameClass,
  cameraPipMounted,
  DEFAULT_CAMERA_PIP,
  effectiveCameraLayout,
  nextCameraPipCorner,
  parseCameraPipPref,
  readCameraPipPref,
  writeCameraPipPref,
  type CameraLayout,
  type CameraPipPref,
} from "./watch-camera-pip";

/**
 * The rules a viewer notices immediately when they are wrong: a webcam over
 * the subtitles, a layout that forgets itself between films, a hidden webcam
 * that keeps downloading, a rectangle where a broken camera should be nothing
 * at all. `hls-watch-player.tsx` cannot be driven past its first render in
 * this suite, so these live here or nothing checks them.
 */

const pref = (over: Partial<CameraPipPref> = {}): CameraPipPref => ({
  ...DEFAULT_CAMERA_PIP,
  ...over,
});

const boxesFor = (layout: CameraLayout, hasFrame = true) =>
  cameraPipBoxes({ mounted: true, hasFrame, pref: pref({ layout }), layout });

describe("the default", () => {
  it("is the film big and the webcam small in the bottom corner", () => {
    // Rafael's 'default', and what an empty or unreadable storage gives.
    expect(DEFAULT_CAMERA_PIP).toEqual({ corner: "bottom-right", layout: "pip" });
  });

  it("offers exactly Rafael's four", () => {
    expect([...CAMERA_LAYOUTS]).toEqual(["pip", "side", "stream", "camera"]);
  });
});

describe("whether the picker is offered at all", () => {
  const live = {
    cameraSrc: "https://api.test/api/voice/hls-playlist/c/1/cam360p30",
    cameraHasVideo: true,
    cinema: true,
  };

  it("is offered while the presenter's camera is on the stream", () => {
    expect(cameraLayoutOffered(live)).toBe(true);
  });

  it("is not offered with no camera: the stage looks exactly as it did", () => {
    expect(cameraLayoutOffered({ ...live, cameraSrc: null })).toBe(false);
    expect(cameraLayoutOffered({ ...live, cameraSrc: undefined })).toBe(false);
  });

  it("is not offered for the voice alone, which has no picture to lay out", () => {
    expect(cameraLayoutOffered({ ...live, cameraHasVideo: false })).toBe(false);
    expect(
      effectiveCameraLayout({ pref: pref({ layout: "camera" }), cameraHasVideo: false }),
    ).toBe("pip");
  });

  it("is not offered in a grid tile or the docked mini player", () => {
    expect(cameraLayoutOffered({ ...live, cinema: false })).toBe(false);
  });
});

describe("whether the camera player exists at all", () => {
  const live = {
    cameraSrc: "https://api.test/api/voice/hls-playlist/c/1/cam360p30",
    cinema: true,
    layout: "pip" as CameraLayout,
    hasVoiceAudio: false,
  };

  it("is on when the server is running a camera transcode", () => {
    for (const layout of ["pip", "side", "camera"] as const) {
      expect(cameraPipMounted({ ...live, layout })).toBe(true);
    }
  });

  it("is off when there is no camera playlist", () => {
    // The ordinary film night: no webcam on, or the box refused it for
    // budget, or `LIVE_HLS_CAMERA=false`.
    expect(cameraPipMounted({ ...live, cameraSrc: null })).toBe(false);
    expect(cameraPipMounted({ ...live, cameraSrc: undefined })).toBe(false);
  });

  it("is UNMOUNTED for 'hide camera', so the webcam stops downloading", () => {
    expect(cameraPipMounted({ ...live, layout: "stream" })).toBe(false);
    expect(
      cameraPipBoxes({ mounted: false, hasFrame: true, pref: pref(), layout: "stream" })
        .camera,
    ).toBeNull();
  });

  it("stays for 'hide camera' when it carries the presenter's voice", () => {
    // "Separada": the camera's playlist is the only place the voice is. A
    // hidden webcam must not silence the presenter.
    expect(cameraPipMounted({ ...live, layout: "stream", hasVoiceAudio: true })).toBe(true);
    const boxes = boxesFor("stream");
    expect(boxes.cameraVoiceOnly).toBe(true);
    expect(boxes.film).toBe(CAMERA_PIP_STAGE_CLASS);
    expect(boxes.corner).toBeNull();
  });

  it("is off in a grid tile and in the docked mini player", () => {
    expect(cameraPipMounted({ ...live, cinema: false })).toBe(false);
  });
});

describe("which picture gets which box", () => {
  it("gives the film the stage and nothing else when there is no camera", () => {
    expect(
      cameraPipBoxes({ mounted: false, hasFrame: false, pref: pref(), layout: "pip" }),
    ).toMatchObject({ film: CAMERA_PIP_STAGE_CLASS, camera: null, corner: null });
  });

  it("draws nothing at all until a frame arrives, in every layout", () => {
    // MOUNTED AND HAS-A-FRAME ARE DIFFERENT QUESTIONS. Collapsing them is a
    // deadlock: an element that is not rendered never decodes a frame. So it
    // is mounted and `invisible`, and the film keeps the whole stage: side by
    // side or "hide stream" must never open on a black half or a black stage.
    for (const layout of ["pip", "side", "camera"] as const) {
      const boxes = boxesFor(layout, false);
      expect(boxes.film).toBe(CAMERA_PIP_STAGE_CLASS);
      expect(boxes.camera).toContain("invisible");
      expect(boxes.corner).toBeNull();
    }
  });

  it("default: floats the camera in the corner, cropped to fill it", () => {
    const boxes = boxesFor("pip");
    expect(boxes.film).toBe(CAMERA_PIP_STAGE_CLASS);
    expect(boxes.camera).toBe(cameraPipCornerClass("bottom-right"));
    expect(boxes.corner).toBe(cameraPipFrameClass("bottom-right"));
    expect(boxes.cameraFit).toBe("cover");
  });

  it("side by side: halves of the stage, stacked on a narrow one", () => {
    const boxes = boxesFor("side");
    expect(boxes.film).toBe(CAMERA_SIDE_FILM_CLASS);
    expect(boxes.camera).toBe(CAMERA_SIDE_CAMERA_CLASS);
    expect(boxes.corner).toBeNull();
    expect(boxes.cameraFit).toBe("contain");
    // Stacked by default (top and bottom halves), side by side from the
    // player's own `@xl` width: a phone held upright stacks, a pane does not.
    expect(CAMERA_SIDE_FILM_CLASS).toContain("h-1/2");
    expect(CAMERA_SIDE_FILM_CLASS).toContain("@xl/watch:w-1/2");
    expect(CAMERA_SIDE_CAMERA_CLASS).toContain("bottom-0");
    expect(CAMERA_SIDE_CAMERA_CLASS).toContain("@xl/watch:w-1/2");
  });

  it("hide stream: the camera on the stage, the film still playing under it", () => {
    // The film is never unmounted or re-attached: it carries the party's
    // sound, and switching back has to be instant.
    const boxes = boxesFor("camera");
    expect(boxes.film).toBe(CAMERA_PIP_STAGE_CLASS);
    expect(boxes.camera).toBe(CAMERA_STAGE_CLASS);
    expect(CAMERA_STAGE_CLASS).toContain("bg-black");
    expect(boxes.cameraFit).toBe("contain");
    expect(boxes.corner).toBeNull();
  });

  it("puts the corner control in the corner with no look of its own", () => {
    const frame = cameraPipFrameClass("top-left");
    expect(frame).not.toContain("bg-black");
    expect(frame).not.toContain("border");
    expect(cameraPipCornerClass("top-left")).toContain(frame);
  });

  it("never puts the corner under the control bar", () => {
    // The pictures are z-20 and the chrome is z-50.
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

  it("gives the default when nothing is stored", () => {
    expect(readCameraPipPref()).toEqual(DEFAULT_CAMERA_PIP);
  });

  it("round-trips every layout", () => {
    for (const layout of CAMERA_LAYOUTS) {
      writeCameraPipPref({ corner: "top-left", layout });
      expect(readCameraPipPref()).toEqual({ corner: "top-left", layout });
    }
  });

  it("falls back to the default rather than trusting what it read", () => {
    expect(parseCameraPipPref(null)).toEqual(DEFAULT_CAMERA_PIP);
    expect(parseCameraPipPref("bottom-left")).toEqual(DEFAULT_CAMERA_PIP);
    expect(parseCameraPipPref({ corner: "middle" })).toEqual(DEFAULT_CAMERA_PIP);
    expect(parseCameraPipPref({ corner: "top-right", layout: "grid" })).toEqual({
      corner: "top-right",
      layout: "pip",
    });
  });

  it("reads a pre-layout preference as the default, never as 'hide stream'", () => {
    // The old click-to-swap stored `onStage`. Opening a party to no film at
    // all is not what that person asked for.
    expect(parseCameraPipPref({ corner: "top-left", onStage: true })).toEqual({
      corner: "top-left",
      layout: "pip",
    });
  });

  it("survives storage that throws outright", () => {
    // A private window, a thumbnail capture, a browser set to block site
    // data. A watch party that fails to draw because a preference could not
    // be read would be a spectacular way to lose a film.
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
    expect(() => writeCameraPipPref({ corner: "top-left", layout: "side" })).not.toThrow();
  });

  it("survives a stored value that is not JSON", () => {
    store.set("pqp:watch-camera-pip", "{not json");
    expect(readCameraPipPref()).toEqual(DEFAULT_CAMERA_PIP);
  });
});
