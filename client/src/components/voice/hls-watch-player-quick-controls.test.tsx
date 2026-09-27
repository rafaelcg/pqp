import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HlsWatchPlayer } from "./hls-watch-player";

/**
 * THE QUICK CLUSTER (2026-09-27): mute, and the camera layout picker beside
 * it, reachable with no hover and no tap-to-reveal, in the SAME stage a
 * viewer already has open without fullscreen. See the block's own comment in
 * `hls-watch-player.tsx` for the 108-viewer party that asked "how do I
 * mute?" three times.
 *
 * A static render, same technique as `hls-watch-player-camera.test.tsx`: no
 * effect runs, so `chrome.hidden` never actually flips here — what this
 * suite pins is that the two controls exist in the markup of the ordinary
 * (non-fullscreen) stage, not only inside the bar that fades.
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

describe("the quick mute control", () => {
  it("is in the ordinary, non-fullscreen stage", () => {
    // No `fullscreen` prop at all: this is the plain in-channel stage.
    expect(markup()).toContain('data-testid="watch-quick-mute"');
  });

  it("is also there in fullscreen", () => {
    const drawn = markup({
      fullscreen: { active: true, toggle: () => {} },
    });
    expect(drawn).toContain('data-testid="watch-quick-mute"');
  });

  it("is a real, named, keyboard-reachable button", () => {
    const drawn = markup();
    expect(drawn).toMatch(
      /<button[^>]*data-testid="watch-quick-mute"[^>]*aria-label="[^"]+"/,
    );
  });

  it("is absent for the host's own silent monitor", () => {
    // `forceMuted`: the presenter is already hearing the film out of their
    // own tab, so a mute button here would silence a viewer's player on the
    // same machine (see the prop's own doc comment).
    expect(markup({ forceMuted: true })).not.toContain("watch-quick-mute");
  });

  it("is absent outside cinema layout", () => {
    // `tile` (a share in the call grid) and `monitor` (the host's audience
    // view) draw their own chrome; `mini` already has its own
    // always-visible mute button (`hls-mini-mute`).
    expect(markup({ layout: "tile" })).not.toContain("watch-quick-mute");
    expect(markup({ layout: "monitor" })).not.toContain("watch-quick-mute");
    expect(markup({ layout: "mini" })).not.toContain("watch-quick-mute");
  });
});

describe("the quick camera layout control", () => {
  it("sits beside the quick mute button once a camera is on the stream", () => {
    const drawn = markup({ cameraSrc: CAMERA });
    expect(drawn).toContain('data-testid="watch-quick-mute"');
    expect(drawn).toContain('data-testid="watch-quick-camera-layout"');
  });

  it("is absent with no camera on the stream", () => {
    expect(markup()).not.toContain("watch-quick-camera-layout");
  });
});
