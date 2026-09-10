import { describe, expect, it } from "vitest";
import { chooseWatchFullscreenPath } from "./watch-fullscreen";
import { detectFullscreenMode } from "./capabilities";

describe("chooseWatchFullscreenPath", () => {
  it("takes the pane on desktop, Android and iPad, where element fullscreen exists", () => {
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
