// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HlsWatchPlayer } from "./hls-watch-player";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * Conventional egress-restart dead window (2026-09-15): a playlist/master
 * 404 must stopLoad and show the restarting hold, not walk the fatal /
 * start-load ladder into a 1–2 s last-segment loop. Pure suites in
 * `hls-stall.test.ts` / `hls-live-edge.test.ts` pin the decision; this one
 * drives the real player's ERROR handler the way #640's attach suite does,
 * so a wiring miss (classifier never called, stopLoad never reached, LL
 * accidentally taking the path) fails here.
 *
 * #650: LL must NOT use this hold — that broader recovery was reverted.
 */

type ErrorHandler = (event: string, data: Record<string, unknown>) => void;

const loadSource = vi.fn();
const attachMedia = vi.fn();
const stopLoad = vi.fn();
const startLoad = vi.fn();
const errorHandlers: ErrorHandler[] = [];

vi.mock("hls.js", async () => {
  const actual = await vi.importActual<typeof import("hls.js")>("hls.js");
  const RealHls = actual.default;
  class FakeHls {
    static isSupported() {
      return true;
    }
    static Events = RealHls.Events;
    config: Record<string, unknown> = {};
    liveSyncPosition: number | null = null;
    levels: unknown[] = [];
    currentLevel = -1;
    latency = 0;
    constructor(config: Record<string, unknown>) {
      this.config = config;
    }
    on(event: string, handler: ErrorHandler) {
      if (event === RealHls.Events.ERROR) {
        errorHandlers.push(handler);
      }
    }
    off() {}
    loadSource(url: string) {
      loadSource(url);
    }
    attachMedia(el: unknown) {
      attachMedia(el);
    }
    stopLoad() {
      stopLoad();
    }
    startLoad(position?: number) {
      startLoad(position);
    }
    recoverMediaError() {}
    destroy() {}
  }
  return { ...actual, default: FakeHls };
});

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getAuthToken: vi.fn(async () => "test-token"),
    fetchChannelLive: vi.fn(async () => ({ stream: null })),
  };
});

const CONVENTIONAL_SRC =
  "https://hls.pqp.gg/api/voice/hls-playlist/d5559e70-8b1c-4a0b-8ffc-b61c88004c73/1789496087461?t=tok";
const LL_SRC = `${CONVENTIONAL_SRC}&mode=ll`;

describe("HlsWatchPlayer conventional restart hold", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    loadSource.mockClear();
    attachMedia.mockClear();
    stopLoad.mockClear();
    startLoad.mockClear();
    errorHandlers.length = 0;
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
    for (let i = 0; i < 200 && loadSource.mock.calls.length === 0; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
    expect(loadSource).toHaveBeenCalled();
    expect(errorHandlers.length).toBeGreaterThan(0);
  }

  function emitPlaylist404() {
    const handler = errorHandlers[errorHandlers.length - 1]!;
    act(() => {
      handler("hlsError", {
        fatal: true,
        details: "manifestLoadError",
        response: { code: 404 },
      });
    });
  }

  it("stopLoads and shows restarting on a conventional playlist 404", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await mount({ src: CONVENTIONAL_SRC, mode: "live" });
      emitPlaylist404();
      expect(stopLoad).toHaveBeenCalled();
      // Holding screen reads stallReason synchronously from the ERROR path.
      expect(container.querySelector('[data-testid="hls-restarting"]')).not.toBeNull();
      // Must not have started the fatal ladder's startLoad from this error.
      expect(startLoad).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not take the conventional hold on an LL playlist 404", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await mount({ src: LL_SRC, mode: "ll", partTargetMs: 500 });
      emitPlaylist404();
      // LL keeps the ordinary fatal path (#650). The ERROR handler must not
      // call stopLoad for playlist-gone on LL.
      expect(stopLoad).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="hls-restarting"]')).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});
