import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
 * thing this suite's `node` environment can do with a 1,400-line player.
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

  it("mounts nothing in fullscreen", () => {
    // Unmounted rather than hidden: a camera nobody can see must not go on
    // decoding 360p for a whole film.
    expect(
      markup({
        cameraSrc: CAMERA,
        fullscreen: { active: true, toggle: () => {} },
      }),
    ).not.toContain("watch-camera-pip");
  });

  it("mounts nothing inside a grid tile", () => {
    // A webcam inside a share tile is a picture in a picture in a picture.
    expect(markup({ cameraSrc: CAMERA, layout: "tile" })).not.toContain(
      "watch-camera-pip",
    );
  });

  it("draws no swap control before the camera has a frame", () => {
    // A control over a picture that is not there yet is a control that does
    // nothing, on the first thing a viewer's eye lands on.
    const drawn = markup({ cameraSrc: CAMERA });
    expect(drawn).toContain("watch-camera-pip");
    expect(drawn).not.toContain("watch-camera-pip-swap");
  });

  it("keeps the film's own element on the stage", () => {
    // The camera is a second element beside the film, never a replacement for
    // it: the stage `<video>` is what the control bar, the stall watchdog and
    // fullscreen all act on.
    expect(markup({ cameraSrc: CAMERA })).toContain("object-contain");
  });
});
