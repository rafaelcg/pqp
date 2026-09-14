// @vitest-environment jsdom
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WatchCameraPip } from "./watch-camera-pip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * A fake `hls.js` good enough to drive the attach effect to
 * `Hls.Events.MANIFEST_PARSED`, which is the one thing `attachOnce` needs
 * before it calls `video.play()`. Nothing here decodes anything — the real
 * decode path is exercised by hand, same as `hls-watch-player.tsx`'s own
 * sibling code has no jsdom coverage for it either.
 */
vi.mock("hls.js", () => {
  class FakeHls {
    static isSupported() {
      return true;
    }
    static Events = { ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed" };
    private listeners = new Map<string, Array<() => void>>();
    on(event: string, cb: () => void) {
      const list = this.listeners.get(event) ?? [];
      list.push(cb);
      this.listeners.set(event, list);
    }
    loadSource() {
      // no-op: this fake never actually fetches a manifest.
    }
    attachMedia() {
      // Real hls.js parses the manifest asynchronously; a microtask is
      // enough to keep this off the synchronous mount call stack.
      queueMicrotask(() => {
        for (const cb of this.listeners.get("hlsManifestParsed") ?? []) {
          cb();
        }
      });
    }
    destroy() {
      // no-op
    }
  }
  return { default: FakeHls };
});

/**
 * THE STATIC SHAPE `LIVE_HLS_VOICE_TRACK` ADDS TO THE CORNER BOX.
 *
 * The player's own attach/playback logic (hls.js, the token refresh, the
 * session-adopt rule) needs a real DOM and is exercised by hand and by the
 * sibling `hls-watch-player-camera.test.tsx` suite at the mount-point level.
 * What is pinned here, the same way `peer-audio-menu.test.tsx` pins its own
 * controls, is the CONTRACT a real viewer depends on: the mic badge and the
 * volume slider exist exactly when the two new flags say they should, named,
 * and every camera that predates the flag (the defaults) draws neither.
 */

function render(node: React.ReactElement) {
  return renderToStaticMarkup(node);
}

describe("WatchCameraPip", () => {
  it("draws the ordinary silent camera by default — no mic badge, no slider", () => {
    const html = render(
      <WatchCameraPip src="/cam.m3u8" className="h-full w-full" onFrame={() => {}} />,
    );
    expect(html).toContain('data-testid="watch-camera-pip"');
    expect(html).not.toContain('data-testid="watch-camera-pip-voice-volume"');
    expect(html).not.toContain("aria-label=\"Presenter&#x27;s voice\"");
    expect(html).not.toContain('data-has-voice-audio=""');
    expect(html).toContain('data-has-video=""');
  });

  it("draws the voice volume slider once hasVoiceAudio is true", () => {
    const html = render(
      <WatchCameraPip
        src="/cam.m3u8"
        hasVoiceAudio
        className="h-full w-full"
        onFrame={() => {}}
      />,
    );
    expect(html).toContain('data-testid="watch-camera-pip-voice-volume"');
    expect(html).toContain('type="range"');
    expect(html).toContain('data-has-voice-audio=""');
  });

  it("draws the mic badge instead of a video frame once hasVideo is false", () => {
    const html = render(
      <WatchCameraPip
        src="/voice.m3u8"
        hasVideo={false}
        hasVoiceAudio
        className="h-full w-full"
        onFrame={() => {}}
      />,
    );
    expect(html).not.toContain('data-has-video=""');
    expect(html).toContain("sr-only");
    // The mic badge AND the volume slider both show: no camera, but the
    // voice is the whole point of this rung.
    expect(html).toContain('data-testid="watch-camera-pip-voice-volume"');
  });
});

/**
 * A Farol finding claimed a rejected unmuted autoplay permanently silences
 * the voice track — the code already answers that with `blocked` and a
 * "tap to hear" affordance (see the file doc), but nothing pinned it. This
 * mounts the real component with a faked `hls.js` so the actual attach
 * effect runs, rather than asserting on markup alone.
 */
describe("WatchCameraPip: rejected unmuted autoplay", () => {
  let container: HTMLDivElement;
  let root: Root;
  let playMock: ReturnType<typeof vi.fn>;
  let originalPlay: typeof HTMLMediaElement.prototype.play;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    originalPlay = HTMLMediaElement.prototype.play;
    playMock = vi.fn();
    HTMLMediaElement.prototype.play = playMock as unknown as typeof HTMLMediaElement.prototype.play;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    HTMLMediaElement.prototype.play = originalPlay;
  });

  it("shows tap-to-hear when the browser refuses the automatic unmuted play, and a click recovers it", async () => {
    // The automatic attempt right after the manifest parses is refused —
    // exactly what a tab opened straight into cinema fullscreen with no
    // prior gesture on the document produces.
    playMock.mockRejectedValueOnce(
      new DOMException("blocked", "NotAllowedError"),
    );
    // The click-driven retry: a `play()` called from inside a click handler
    // is not subject to the autoplay policy at all, so it always succeeds
    // where the automatic one could not.
    playMock.mockResolvedValueOnce(undefined);

    act(() => {
      root.render(
        <WatchCameraPip
          src="https://example.com/cam.m3u8"
          hasVoiceAudio
          className="h-full w-full"
          onFrame={() => {}}
        />,
      );
    });

    await vi.waitFor(() => {
      expect(playMock).toHaveBeenCalledTimes(1);
    });

    const button = await vi.waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(
        '[data-testid="watch-camera-pip-tap-to-hear"]',
      );
      expect(found).not.toBeNull();
      return found;
    });

    act(() => {
      button?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    await vi.waitFor(() => {
      expect(playMock).toHaveBeenCalledTimes(2);
      expect(
        container.querySelector('[data-testid="watch-camera-pip-tap-to-hear"]'),
      ).toBeNull();
    });
  });
});
