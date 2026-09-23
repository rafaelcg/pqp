import Hls from "hls.js";
import { describe, expect, it } from "vitest";
import {
  applyLlLatencyCeiling,
  hlsLivePlayerConfig,
  llHlsConfig,
  llLatencyCeilingSeconds,
  llMaxLatencySeconds,
  LL_HLS_DEFAULT_PART_TARGET_MS,
  LL_HLS_FRAG_MAX_RETRY_DELAY_MS,
  LL_HLS_FRAG_RETRY_COUNT,
  LL_HLS_FRAG_RETRY_DELAY_MS,
  LL_HLS_FRAG_TIMEOUT_RETRY_COUNT,
  LL_HLS_FRAG_TTFB_MS,
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
    for (const delivery of ["segments", "parts"] as const) {
      const player = new Hls(llHlsConfig(delivery) as never);
      try {
        expect(player.config.lowLatencyMode).toBe(delivery === "parts");
      } finally {
        player.destroy();
      }
    }
  });

  it("takes the governor's live setters after construction (hls-ll-latency.ts)", () => {
    // The governor never rebuilds: it moves the target, the ceiling and the
    // delivery on the running instance. Each of these is a setter hls.js
    // reads live; if a future hls.js renamed one, this is where it shows.
    const player = new Hls(llHlsConfig("parts") as never);
    try {
      player.config.liveMaxLatencyDuration = 14;
      player.targetLatency = 8;
      expect(player.config.liveSyncDuration).toBe(8);
      expect(player.config.liveMaxLatencyDuration).toBe(14);
      player.lowLatencyMode = false;
      expect(player.config.lowLatencyMode).toBe(false);
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

/**
 * The LL fragment retry budget and the manifest-driven latency ceiling, both
 * handed to the real hls.js -- a config key hls.js does not recognise is
 * silently dropped in the merge, which looks exactly like a policy that is
 * working.
 */
describe("the LL path's own load policies survive hls.js's merge", () => {
  it("keeps the part-paced fragment retry budget", () => {
    const player = new Hls(llHlsConfig() as never);
    try {
      const retry = player.config.fragLoadPolicy.default.errorRetry;
      expect(retry?.maxNumRetry).toBe(LL_HLS_FRAG_RETRY_COUNT);
      expect(retry?.retryDelayMs).toBe(LL_HLS_FRAG_RETRY_DELAY_MS);
      expect(retry?.maxRetryDelayMs).toBe(LL_HLS_FRAG_MAX_RETRY_DELAY_MS);
      // The timeout half of the same budget, which hls.js merges separately.
      const policy = player.config.fragLoadPolicy.default;
      expect(policy.maxTimeToFirstByteMs).toBe(LL_HLS_FRAG_TTFB_MS);
      expect(policy.timeoutRetry?.maxNumRetry).toBe(
        LL_HLS_FRAG_TIMEOUT_RETRY_COUNT,
      );
    } finally {
      player.destroy();
    }
  });

  it("raises the latency ceiling to clear the manifest's own PART-HOLD-BACK", () => {
    // `LatencyController.maxLatency` reads `liveMaxLatencyDuration` off the
    // merged config, and `StreamController.synchronizeToLiveEdge` force-seeks
    // once the playhead is that far back. A 3 s hold-back under the 4 s
    // part-derived ceiling leaves one second of slack, and one stumble then
    // seeks, which empties a 6 s buffer, which is the next stumble.
    const player = new Hls(llHlsConfig() as never);
    try {
      applyLlLatencyCeiling(
        player as unknown as { config: { liveMaxLatencyDuration?: number } },
        LL_HLS_DEFAULT_PART_TARGET_MS,
        3,
      );
      expect(player.config.liveMaxLatencyDuration).toBe(
        llLatencyCeilingSeconds(LL_HLS_DEFAULT_PART_TARGET_MS, 3),
      );
      expect(player.config.liveMaxLatencyDuration).toBeGreaterThan(3);
    } finally {
      player.destroy();
    }
  });
});
