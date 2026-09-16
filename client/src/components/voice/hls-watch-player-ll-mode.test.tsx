import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HlsWatchPlayer } from "./hls-watch-player";

/**
 * THE WIRING for task L2.4 (`docs/plans/LL_HLS.md`), the same half a pure
 * module cannot prove that `hls-watch-player-camera.test.tsx` exists for:
 * `mode`/`partTargetMs` are threaded from `LiveHlsStream` through five
 * wrapper components (`watch-stage.tsx`, `cinema-stage.tsx`,
 * `screen-stage.tsx`, `call-stage.tsx`, and the host's "Público" monitor in
 * `watch-party/presenter-stage.tsx`) into this player, and a prop that
 * reaches the component but crashes or changes nothing would pass every
 * pure-function test in `hls-live-edge.test.ts`/`hls-stall.test.ts` while
 * shipping a feature that does nothing.
 *
 * A static render, so no effect runs and no hls.js loads (`attach()` never
 * fires): this proves the props are accepted and the live badge mounts, not
 * the runtime behaviour hls.js drives once attached -- that is what
 * `llHlsConfig`, `behindLiveThresholdSeconds`, `isInPlaceModeDemotion` and
 * `HlsStallWatch.configureForMode`'s own suites pin.
 */

const SRC = "https://api.test/api/voice/hls-playlist/c/1?t=x";

function markup(
  props: Partial<Parameters<typeof HlsWatchPlayer>[0]> = {},
): string {
  return renderToStaticMarkup(
    <HlsWatchPlayer src={SRC} layout="cinema" {...props} />,
  );
}

describe("mode/partTargetMs reach the player", () => {
  it("accepts mode='ll' and partTargetMs without throwing", () => {
    expect(() => markup({ mode: "ll", partTargetMs: 500 })).not.toThrow();
  });

  it("mounts the live badge for both modes", () => {
    expect(markup({ mode: "live" })).toContain("watch-stage-live");
    expect(markup({ mode: "ll", partTargetMs: 500 })).toContain(
      "watch-stage-live",
    );
  });

  it("falls back to the plain label before any latency has been measured -- item 4's graceful fallback", () => {
    // No effect has run in a static render, so `hls.latency` was never read
    // and the LL-specific figure never appears; native/Safari (no hls.js at
    // all) never gets one either, for the same reason at runtime.
    const conventionalMarkup = markup({ mode: "live" });
    const ll = markup({ mode: "ll", partTargetMs: 500 });
    expect(conventionalMarkup).not.toContain("~");
    expect(ll).not.toContain("~");
  });

  it("omitting mode entirely is the same as live -- byte-identical for every existing caller", () => {
    expect(markup()).toBe(markup({ mode: "live" }));
  });
});
