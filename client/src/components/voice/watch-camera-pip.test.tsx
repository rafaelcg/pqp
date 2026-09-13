import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WatchCameraPip } from "./watch-camera-pip";

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
