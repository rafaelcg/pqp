// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HlsWatchPlayer } from "./hls-watch-player";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * THE ATTACH, DRIVEN, FOR AN `ll` STREAM.
 *
 * `hls-watch-player-ll-mode.test.tsx` renders statically on purpose, so no
 * effect runs and hls.js is never constructed; `hls-live-edge.test.ts` only
 * ever inspects a plain object. Between the two, the LL player shipped a
 * constructor config hls.js REFUSES (`liveMaxLatencyDuration` with no
 * `liveSyncDuration`), `new Hls(...)` threw inside an async `attach()`
 * invoked as `void attach()`, and every LL viewer in production sat on the
 * stall overlay having issued not one playlist request. A two-minute HAR
 * from 2026-09-15 holds the correct frame, the correct edge URL, and zero
 * requests to the edge host.
 *
 * So this suite mounts the real player with the real production frame and
 * asserts the one thing all three of those suites could not: that
 * `loadSource` is reached. The fake `Hls` below deliberately runs the REAL
 * hls.js constructor over the config first -- a fake that validates nothing
 * is exactly how the bug got through.
 */

const loadSource = vi.fn();
const attachMedia = vi.fn();
/** Makes the fake hls.js refuse an LL constructor config, the way the real one did. */
const refuseLowLatency = { on: false };

vi.mock("hls.js", async () => {
  const actual = await vi.importActual<typeof import("hls.js")>("hls.js");
  const RealHls = actual.default;
  class ValidatingFakeHls {
    static isSupported() {
      return true;
    }
    static Events = RealHls.Events;
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      if (refuseLowLatency.on && config.lowLatencyMode === true) {
        throw new Error('Illegal hls.js config: "liveMaxLatencyDuration"');
      }
      // The real merge, including the validation that threw. Destroyed
      // immediately: nothing here should touch media.
      const probe = new RealHls(config as never);
      this.config = probe.config as unknown as Record<string, unknown>;
      probe.destroy();
    }
    on() {}
    off() {}
    loadSource(url: string) {
      loadSource(url);
    }
    attachMedia(el: unknown) {
      attachMedia(el);
    }
    destroy() {}
    get latency() {
      return 0;
    }
    get liveSyncPosition() {
      return null;
    }
    get levels() {
      return [];
    }
  }
  return { ...actual, default: ValidatingFakeHls };
});

/**
 * The exact `channel-live` payload a viewer held on 2026-09-15, minus the
 * token bodies. `?mode=ll` and the edge host are part of the shape: a URL
 * with a query string already on it is one of the things a caller could get
 * wrong on this path.
 */
const PRODUCTION_LL_SRC =
  "https://hls.pqp.gg/api/voice/hls-playlist/d5559e70-8b1c-4a0b-8ffc-b61c88004c73/1789496087461?mode=ll&t=tok&pp=pass";

describe("HlsWatchPlayer attaches an ll stream", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    refuseLowLatency.on = false;
    loadSource.mockClear();
    attachMedia.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  type PlayerProps = Parameters<typeof HlsWatchPlayer>[0];

  async function mount(props: PlayerProps) {
    await act(async () => {
      root.render(<HlsWatchPlayer layout="cinema" {...props} />);
    });
    // `attach()` awaits `import("hls.js")`, so the attach finishes a few
    // ticks after render -- and how many is a function of how loaded the
    // machine is, not of this test. Wait for the outcome, bounded.
    for (let i = 0; i < 200 && loadSource.mock.calls.length === 0; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
  }

  it("calls loadSource with the URL from the frame", async () => {
    await mount({
      src: PRODUCTION_LL_SRC,
      mode: "ll",
      partTargetMs: 500,
      delaySeconds: 3,
    });
    expect(loadSource).toHaveBeenCalledWith(PRODUCTION_LL_SRC);
    expect(attachMedia).toHaveBeenCalled();
  });

  it("falls back to the conventional engine when hls.js refuses the LL config", async () => {
    // Not by building a second instance inside the catch -- that would run
    // conventional live-sync under LL stall thresholds. The session is pinned
    // and the whole effect re-runs, so every mode-dependent thing agrees.
    refuseLowLatency.on = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await mount({
        src: PRODUCTION_LL_SRC,
        mode: "ll",
        partTargetMs: 500,
      });
      expect(errors).toHaveBeenCalledWith(
        "[hls] config error",
        expect.any(Error),
      );
      // The viewer still gets a player, on the same URL.
      expect(loadSource).toHaveBeenCalledWith(PRODUCTION_LL_SRC);
    } finally {
      errors.mockRestore();
    }
  });

  it("still attaches a conventional stream", async () => {
    await mount({
      src: "https://hls.pqp.gg/api/voice/hls-playlist/c/1?t=tok",
      mode: "live",
    });
    expect(loadSource).toHaveBeenCalled();
  });
});
