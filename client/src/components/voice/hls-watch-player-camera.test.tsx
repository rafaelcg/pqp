import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HlsWatchPlayer } from "./hls-watch-player";

/**
 * THE WIRING, which is the half a pure module cannot prove.
 *
 * `lib/watch-camera-pip.ts` decides which picture gets which box and its own
 * suite pins every rule. What nothing else reaches is whether the player
 * actually mounts a second element for the camera at all: a `cameraSrc` prop
 * that is threaded through four components and then never rendered would pass
 * every other test in this repo and ship a feature that does nothing.
 *
 * A static render, so no effect runs and no hls.js is loaded. That is enough
 * for the question being asked — is the element there — and it is the only
 * thing this suite's `node` environment can do with a 1,500-line player.
 */

const CAMERA = "https://api.test/api/voice/hls-playlist/c/1/cam360p30?t=x";

function markup(
  props: Partial<Parameters<typeof HlsWatchPlayer>[0]> = {},
): string {
  return renderToStaticMarkup(
    <HlsWatchPlayer
      src="https://api.test/api/voice/hls-playlist/c/1?t=x"
      layout="cinema"
      {...props}
    />,
  );
}

describe("the presenter's camera reaches the stage", () => {
  it("mounts a second element when the server states a camera playlist", () => {
    expect(markup({ cameraSrc: CAMERA })).toContain("watch-camera-pip");
  });

  it("mounts nothing at all for a party with no camera", () => {
    // The ordinary film night, and every deployment with
    // `LIVE_HLS_CAMERA=false`. No element, no decode, no rectangle.
    expect(markup()).not.toContain("watch-camera-pip");
    expect(markup({ cameraSrc: null })).not.toContain("watch-camera-pip");
  });

  it("keeps the viewer's layout in fullscreen", () => {
    // Fullscreen used to unmount the camera ("the film and nothing else").
    // With the picker the viewer says what fullscreen shows, "hide camera"
    // included, so the camera and the picker both stay.
    const drawn = markup({
      cameraSrc: CAMERA,
      fullscreen: { active: true, toggle: () => {} },
    });
    expect(drawn).toContain("watch-camera-pip");
    expect(drawn).toContain("watch-camera-layout");
  });

  it("mounts nothing inside a grid tile or the docked mini player", () => {
    // A webcam inside a share tile is a picture in a picture in a picture,
    // and the mini player is a 240px box with room for the film and almost
    // nothing else.
    expect(markup({ cameraSrc: CAMERA, layout: "tile" })).not.toContain(
      "watch-camera-pip",
    );
    expect(markup({ cameraSrc: CAMERA, layout: "mini" })).not.toContain(
      "watch-camera-pip",
    );
  });

  it("draws no corner control before the camera has a frame", () => {
    // A control over a picture that is not there yet is a control that does
    // nothing, on the first thing a viewer's eye lands on.
    const drawn = markup({ cameraSrc: CAMERA });
    expect(drawn).toContain("watch-camera-pip");
    expect(drawn).not.toContain("watch-camera-pip-corner");
  });

  it("keeps the film's own element on the stage", () => {
    // The camera is a second element beside the film, never a replacement for
    // it: the stage `<video>` is what the control bar, the stall watchdog and
    // fullscreen all act on.
    expect(markup({ cameraSrc: CAMERA })).toContain("object-contain");
  });
});

describe("the layout picker (2026-09-25)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stored(layout: string) {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => JSON.stringify({ corner: "bottom-right", layout }),
        setItem: () => {},
      },
    });
  }

  it("is in the player's chrome while the presenter's camera is on", () => {
    const drawn = markup({ cameraSrc: CAMERA });
    expect(drawn).toContain('data-testid="watch-camera-layout"');
    // The default with nothing stored.
    expect(drawn).toContain('data-camera-layout="pip"');
    // A real, named button: keyboard reachable, a label a screen reader says.
    expect(drawn).toMatch(/<button[^>]*aria-label="[^"]+"[^>]*data-testid="watch-camera-layout"|<button[^>]*data-testid="watch-camera-layout"[^>]*aria-label="[^"]+"/);
  });

  it("is absent with no camera: the stage looks exactly as it did", () => {
    expect(markup()).not.toContain("watch-camera-layout");
  });

  it("is absent for the presenter's voice alone, which has no picture", () => {
    expect(markup({ cameraSrc: CAMERA, cameraHasVideo: false })).not.toContain(
      "watch-camera-layout",
    );
  });

  it("is absent in the docked mini player", () => {
    expect(markup({ cameraSrc: CAMERA, layout: "mini" })).not.toContain(
      "watch-camera-layout",
    );
  });

  it("'hide camera' unmounts the webcam's player, and keeps the picker to bring it back", () => {
    stored("stream");
    const drawn = markup({ cameraSrc: CAMERA });
    expect(drawn).not.toContain('data-testid="watch-camera-pip"');
    expect(drawn).toContain('data-camera-layout="stream"');
  });

  it("'hide camera' keeps a camera that carries the presenter's voice, drawn as the voice", () => {
    stored("stream");
    const drawn = markup({ cameraSrc: CAMERA, cameraHasVoiceAudio: true });
    expect(drawn).toContain('data-testid="watch-camera-pip"');
    // Drawn as the voice-only corner: no picture, the voice slider still there.
    expect(drawn).not.toContain("data-has-video");
    expect(drawn).toContain("watch-camera-pip-voice-volume");
  });

  it("every other layout mounts the camera and keeps the film's own element", () => {
    for (const layout of ["pip", "side", "camera"]) {
      stored(layout);
      const drawn = markup({ cameraSrc: CAMERA });
      expect(drawn).toContain('data-testid="watch-camera-pip"');
      expect(drawn).toContain(`data-camera-layout="${layout}"`);
    }
  });
});
