import { describe, expect, it } from "vitest";
import { chooseWatchFullscreenPath } from "./watch-fullscreen";
import { detectFullscreenMode } from "./capabilities";
import { videoCanEnterFullscreen } from "@/lib/fullscreen";

describe("chooseWatchFullscreenPath", () => {
  it("takes native element fullscreen on desktop, Android and iPad", () => {
    expect(
      chooseWatchFullscreenPath({
        elementFullscreen: true,
        videoNativeFullscreen: true,
      }),
    ).toBe("element");
  });

  it("hands the HLS film to the native player on an iPhone", () => {
    // Watch party is MPEG-TS / HLS, not a MediaStream. The call stage
    // refuses this path because PR #48 showed black on a camera tile; a
    // watch party is a file the OS player can actually render, and a
    // working film-only fullscreen beats a broken in-page expand.
    expect(
      chooseWatchFullscreenPath({
        elementFullscreen: false,
        videoNativeFullscreen: true,
      }),
    ).toBe("video");
  });

  it("expands in the page when nothing else is available (Electron after a silent refusal)", () => {
    expect(
      chooseWatchFullscreenPath({
        elementFullscreen: false,
        videoNativeFullscreen: false,
      }),
    ).toBe("expand");
    expect(
      chooseWatchFullscreenPath({
        elementFullscreen: true,
        videoNativeFullscreen: false,
        elementPreviouslyRefused: true,
      }),
    ).toBe("expand");
  });

  it("does not take the native player on a desktop that already refused element fullscreen unless the method exists", () => {
    // Electron Chromium has no webkitEnterFullscreen. Falling through to
    // `video` there would be a no-op; expand is the working fallback.
    expect(
      chooseWatchFullscreenPath({
        elementFullscreen: false,
        videoNativeFullscreen: false,
        elementPreviouslyRefused: true,
      }),
    ).toBe("expand");
  });
});

describe("iPhone capability probe feeds the video path, not expand", () => {
  it("detectFullscreenMode says expand, and the watch chooser upgrades to video when the native player exists", () => {
    // iPhone: no element fullscreen under either name. The call stage
    // stops at expand; the watch party does not, because the picture is HLS.
    const element = detectFullscreenMode({
      documentFullscreenEnabled: undefined,
      requestFullscreen: undefined,
      webkitRequestFullscreen: undefined,
    });
    expect(element).toBe("expand");
    expect(
      chooseWatchFullscreenPath({
        elementFullscreen: element === "element",
        videoNativeFullscreen: true,
      }),
    ).toBe("video");
  });

  it("an iOS 17.1+ iPhone (hls.js / ManagedMediaSource) still reaches the video path", () => {
    // The regression this fixes: the film plays through hls.js over
    // ManagedMediaSource and WebKit reports `webkitSupportsFullscreen ===
    // false` for it, so the strict `videoSupportsNativeFullscreen` probe used
    // to say `false` and the chooser fell to `expand` — a dead button under
    // Safari's chrome. The looser `videoCanEnterFullscreen` gates on the
    // method alone, so the iPhone reaches the native player.
    const mmsFilm = {
      webkitEnterFullscreen: () => {},
      webkitSupportsFullscreen: false,
    } as unknown as HTMLVideoElement;
    const element = detectFullscreenMode({
      documentFullscreenEnabled: undefined,
      requestFullscreen: undefined,
      webkitRequestFullscreen: undefined,
    });
    expect(element).toBe("expand");
    expect(
      chooseWatchFullscreenPath({
        elementFullscreen: element === "element",
        videoNativeFullscreen: videoCanEnterFullscreen(mmsFilm),
      }),
    ).toBe("video");
  });

  it("an iframe without allowfullscreen still expands rather than hiding the control", () => {
    expect(
      chooseWatchFullscreenPath({
        elementFullscreen:
          detectFullscreenMode({
            documentFullscreenEnabled: false,
            requestFullscreen: () => Promise.resolve(),
          }) === "element",
        videoNativeFullscreen: false,
      }),
    ).toBe("expand");
  });
});
