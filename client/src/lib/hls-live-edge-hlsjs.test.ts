import Hls from "hls.js";
import { describe, expect, it } from "vitest";
import {
  applyLlLatencyCeiling,
  hlsLivePlayerConfig,
  llHlsConfig,
  llMaxLatencySeconds,
  LL_HLS_DEFAULT_PART_TARGET_MS,
} from "./hls-live-edge";

/**
 * THE ONE TEST THAT HANDS OUR CONFIG TO THE REAL hls.js.
 *
 * `hls-live-edge.test.ts` asserts the shape of the object; every player test
 * mocks `hls.js` with a fake whose constructor validates nothing; and
 * `hls-watch-player-ll-mode.test.tsx` renders statically, so `attach()` never
 * runs. Three suites, all green, and not one of them ever called
 * `new Hls(config)` -- so `liveMaxLatencyDuration` set without
 * `liveSyncDuration` (a pair `mergeConfig` rejects by THROWING) shipped, and
 * every LL viewer in production got an exception instead of a player:
 * `attach()` was invoked as `void attach()`, the rejection was unhandled and
 * silent, `loadSource` was never reached, and a two-minute HAR of a viewer
 * holding a correct `mode: "ll"` frame contains zero playlist requests.
 *
 * hls.js's config validation is the contract. Assert against hls.js.
 */

describe("our hls.js configs are configs hls.js accepts", () => {
  it("constructs an LL player from the constructor config", () => {
    const player = new Hls(llHlsConfig() as never);
    try {
      expect(player.config.lowLatencyMode).toBe(true);
    } finally {
      player.destroy();
    }
  });

  it("constructs a conventional player too", () => {
    const player = new Hls(hlsLivePlayerConfig() as never);
    try {
      expect(player.config.liveSyncDurationCount).toBeGreaterThan(0);
    } finally {
      player.destroy();
    }
  });

  it("leaves the manifest's own PART-HOLD-BACK in charge on the LL path", () => {
    // `LatencyController.targetLatency` only overrides the manifest when the
    // CONSTRUCTOR's own config set one of these two. Neither is ours, which
    // is the whole of `docs/plans/LL_HLS.md` §4 in one assertion.
    const player = new Hls(llHlsConfig() as never);
    try {
      expect(player.userConfig.liveSyncDuration).toBeUndefined();
      expect(player.userConfig.liveSyncDurationCount).toBeUndefined();
    } finally {
      player.destroy();
    }
  });

  it("takes the latency ceiling after construction, where hls.js reads it", () => {
    const player = new Hls(llHlsConfig() as never);
    try {
      applyLlLatencyCeiling(
        player as unknown as { config: { liveMaxLatencyDuration?: number } },
        LL_HLS_DEFAULT_PART_TARGET_MS,
      );
      // `LatencyController.maxLatency` reads `config`, not `userConfig`.
      expect(player.config.liveMaxLatencyDuration).toBe(
        llMaxLatencySeconds(LL_HLS_DEFAULT_PART_TARGET_MS),
      );
      expect(player.userConfig.liveMaxLatencyDuration).toBeUndefined();
    } finally {
      player.destroy();
    }
  });

  it("refuses the shape that shipped: the ceiling in the constructor config", () => {
    // Pins WHY the line above cannot simply move back into `llHlsConfig()`.
    expect(
      () =>
        new Hls({
          ...llHlsConfig(),
          liveMaxLatencyDuration: llMaxLatencySeconds(
            LL_HLS_DEFAULT_PART_TARGET_MS,
          ),
        } as never),
    ).toThrow(/liveMaxLatencyDuration/);
  });
});
