import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAdaptiveStreamSettings,
  fullscreenPixelDensity,
  isViewerFullscreen,
  nudgeElementMeasure,
  reportStageExpanded,
  subscribeViewerFullscreen,
} from "./viewer-fullscreen";

/**
 * Bug 123: "em tela cheia sai do fullhd para hd" (Windows desktop app).
 *
 * The decision under test is the one livekit-client makes on the viewer's
 * behalf: it measures the share's element in CSS pixels times
 * `getPixelDensity()`, and the SFU turns that height into a layer. Both halves
 * are modelled with the real thing where it is importable (the library's own
 * `getPixelDensity`, called on the settings object this module builds) and with
 * the rule `share-fast-start.ts` documents for the other (LiveKit 1.13.6: the
 * first declared layer at least 0.9 of the requested height).
 */

const LAYERS = [360, 720, 1080];
const SFU_TOLERANCE = 0.9;

/** The layer height the SFU forwards for a requested element height. */
function sfuLayerFor(requestedHeight: number): number {
  return (
    LAYERS.find((height) => height >= requestedHeight * SFU_TOLERANCE) ??
    LAYERS[LAYERS.length - 1]!
  );
}

/** What the library would request for a stage of this CSS size on this display. */
async function requestedHeight(input: {
  cssHeight: number;
  devicePixelRatio: number;
  fullscreen: boolean;
}): Promise<number> {
  const { RemoteVideoTrack } = await import("livekit-client");
  const settings = createAdaptiveStreamSettings(() => input.fullscreen);
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", { devicePixelRatio: input.devicePixelRatio });
  try {
    const density = (
      RemoteVideoTrack.prototype as unknown as {
        getPixelDensity(this: { adaptiveStreamSettings: unknown }): number;
      }
    ).getPixelDensity.call({ adaptiveStreamSettings: settings });
    return input.cssHeight * density;
  } finally {
    vi.unstubAllGlobals();
  }
}

afterEach(() => {
  reportStageExpanded(false);
  vi.unstubAllGlobals();
});

describe("fullscreen asks for the layer the screen can show", () => {
  it("1080p laptop at 150% scaling: fullscreen gets the 1080p layer, not the 720p one", async () => {
    // 1920x1080 at 150% is a 1280x720 CSS viewport.
    const before = await requestedHeight({
      cssHeight: 720,
      devicePixelRatio: 1.5,
      fullscreen: false,
    });
    expect(before).toBe(720);
    // What shipped: the library's default density of 1, so the SFU forwards the
    // 720p copy to a screen that has 1080 lines.
    expect(sfuLayerFor(before)).toBe(720);

    const after = await requestedHeight({
      cssHeight: 720,
      devicePixelRatio: 1.5,
      fullscreen: true,
    });
    expect(after).toBe(1080);
    expect(sfuLayerFor(after)).toBe(1080);
  });

  it("1080p panel at 100% and 125% already reached 1080 and still does", async () => {
    for (const [cssHeight, devicePixelRatio] of [
      [1080, 1],
      [864, 1.25],
    ] as const) {
      const asked = await requestedHeight({
        cssHeight,
        devicePixelRatio,
        fullscreen: true,
      });
      expect(sfuLayerFor(asked)).toBe(1080);
    }
  });

  it("1440p panel at 200%: the top layer, where the default asked for 720 lines", async () => {
    const asked = await requestedHeight({
      cssHeight: 720,
      devicePixelRatio: 2,
      fullscreen: true,
    });
    expect(asked).toBe(1440);
    expect(sfuLayerFor(asked)).toBe(1080);
  });

  it("a windowed tile is still measured the way it always was", async () => {
    // The bandwidth rule that keeps a 100 viewer watch party affordable: a
    // 620-line tile on a 150% laptop asks for 620 lines, not 930.
    const asked = await requestedHeight({
      cssHeight: 620,
      devicePixelRatio: 1.5,
      fullscreen: false,
    });
    expect(asked).toBe(620);
    expect(sfuLayerFor(asked)).toBe(720);
  });
});

describe("createAdaptiveStreamSettings", () => {
  it("leaves the library's own density until the stage is fullscreen", () => {
    let fullscreen = false;
    const settings = createAdaptiveStreamSettings(() => fullscreen);
    expect(settings.pixelDensity).toBeUndefined();
    fullscreen = true;
    expect(settings.pixelDensity).toBe("screen");
    fullscreen = false;
    expect(settings.pixelDensity).toBeUndefined();
  });

  it("is one live object: the library keeps the reference, so it has to follow", () => {
    const settings = createAdaptiveStreamSettings();
    expect(settings.pixelDensity).toBeUndefined();
    reportStageExpanded(true);
    expect(settings.pixelDensity).toBe("screen");
  });

  it("names the density only for fullscreen", () => {
    expect(fullscreenPixelDensity(true)).toBe("screen");
    expect(fullscreenPixelDensity(false)).toBeUndefined();
  });
});

describe("isViewerFullscreen", () => {
  it("is true for a fullscreen element under either spelling", () => {
    expect(isViewerFullscreen({ fullscreenElement: {} as Element })).toBe(true);
    expect(isViewerFullscreen({ webkitFullscreenElement: {} as Element })).toBe(
      true,
    );
    expect(isViewerFullscreen({ fullscreenElement: null })).toBe(false);
    expect(isViewerFullscreen({})).toBe(false);
  });

  it("is true while the stage fills the page, with no fullscreen element", () => {
    expect(isViewerFullscreen({ fullscreenElement: null })).toBe(false);
    reportStageExpanded(true);
    expect(isViewerFullscreen({ fullscreenElement: null })).toBe(true);
    reportStageExpanded(false);
    expect(isViewerFullscreen({ fullscreenElement: null })).toBe(false);
  });
});

describe("subscribeViewerFullscreen", () => {
  function fakeDocument() {
    const handlers = new Map<string, Set<() => void>>();
    return {
      addEventListener: (type: string, fn: () => void) => {
        handlers.set(type, (handlers.get(type) ?? new Set()).add(fn));
      },
      removeEventListener: (type: string, fn: () => void) => {
        handlers.get(type)?.delete(fn);
      },
      fire: (type: string) => handlers.get(type)?.forEach((fn) => fn()),
      count: () =>
        [...handlers.values()].reduce((total, set) => total + set.size, 0),
    };
  }

  it("fires on both fullscreen events and on the stage filling the page", () => {
    const doc = fakeDocument();
    const listener = vi.fn();
    const stop = subscribeViewerFullscreen(
      listener,
      doc as unknown as Document,
    );
    doc.fire("fullscreenchange");
    doc.fire("webkitfullscreenchange");
    reportStageExpanded(true);
    expect(listener).toHaveBeenCalledTimes(3);
    // Reporting the value it already has is not a change.
    reportStageExpanded(true);
    expect(listener).toHaveBeenCalledTimes(3);
    stop();
  });

  it("lets go of everything when stopped", () => {
    const doc = fakeDocument();
    const listener = vi.fn();
    const stop = subscribeViewerFullscreen(
      listener,
      doc as unknown as Document,
    );
    stop();
    expect(doc.count()).toBe(0);
    reportStageExpanded(true);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("nudgeElementMeasure", () => {
  it("calls the hook the library puts on an observed element", () => {
    const handleResize = vi.fn();
    nudgeElementMeasure({ handleResize });
    expect(handleResize).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for an element the library never observed, and survives a throwing hook", () => {
    expect(() => nudgeElementMeasure({})).not.toThrow();
    expect(() =>
      nudgeElementMeasure({
        handleResize: () => {
          throw new Error("torn down");
        },
      }),
    ).not.toThrow();
  });
});
