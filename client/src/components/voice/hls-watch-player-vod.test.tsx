import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HlsWatchPlayer } from "./hls-watch-player";

/**
 * `mode: "vod"` is the replay half of the fix for "a finished watch party's
 * replay played like a dead live stream" (root cause: the live stall
 * watchdog reads a VOD manifest's frozen `EXT-X-MEDIA-SEQUENCE` as a dead
 * egress -- see the `mode` prop's doc comment on `HlsWatchPlayer` and
 * `lib/watch-holding-screen.ts`). A static render never runs an effect, so
 * this cannot exercise hls.js or the stall watchdog itself (that is
 * `hls-stall.test.ts` and `watch-holding-screen.test.ts`'s job) -- what it
 * CAN prove, before any effect has had a chance to run, is the wiring: the
 * live-only chrome is gone and the replay-only chrome (a seek bar, the
 * default "just buffering" state) is there.
 */

const SRC = "https://api.test/api/voice/hls-replay/c/1700000000000?t=x";

function markup(mode?: "live" | "vod"): string {
  return renderToStaticMarkup(
    <HlsWatchPlayer src={SRC} layout="cinema" mode={mode} />,
  );
}

describe("HlsWatchPlayer mode: vod", () => {
  it("carries no permanent 'AO VIVO' badge", () => {
    const vod = markup("vod");
    expect(vod).not.toContain('data-testid="hls-delay-badge"');
    expect(vod).not.toContain('data-testid="watch-stage-live"');
    expect(vod).not.toContain('data-testid="watch-stage-jump-live"');
  });

  it("mounts a seek bar instead of the live transport row", () => {
    const vod = markup("vod");
    expect(vod).toContain('data-testid="hls-vod-seek"');
  });

  it("a live player never mounts the seek bar", () => {
    const live = markup("live");
    expect(live).not.toContain('data-testid="hls-vod-seek"');
  });

  it("shows plain buffering chrome before the first frame, never the live 'starting soon' holding screen", () => {
    const vod = markup("vod");
    expect(vod).toContain('data-testid="hls-vod-loading"');
    expect(vod).not.toContain('data-testid="hls-buffering"');
    expect(vod).not.toContain('data-testid="hls-reconnecting"');
  });

  it("a live player shows the bubbles holding screen before the first frame", () => {
    const live = markup("live");
    expect(live).toContain('data-testid="hls-buffering"');
  });
});
