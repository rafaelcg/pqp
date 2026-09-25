// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HlsWatchPlayer } from "./hls-watch-player";
import { TooltipProvider } from "@/components/ui/tooltip";
import { fetchChannelLive } from "@/lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * A REBUILD THE LADDER ASKED FOR, THAT NEVER HAPPENED (rehearsal D,
 * 2026-09-25, 13:48:44 to 13:52:47 UTC). One LL viewer's film froze at
 * t=101.89 for 248 s. The console said "rebuilding the player" every seven
 * seconds and no new hls.js instance was ever made, then "A transmissão
 * caiu" stayed up with nothing retrying it.
 *
 * The rebuild waits out a 0.5 to 4 s jitter (`drainJitterMs`), and
 * `gateRebuild` resets the ladder so the very next 1 s tick is an in-place
 * `start-load`, which cleared the pending timer. A rebuild only survived a
 * jitter shorter than the tick, about one in seven. Each cancelled one still
 * counted toward the three-per-five-minutes bound, so the fourth decision
 * was `"dead"` with no rebuild ever made. This suite pins the wiring: a
 * decided rebuild is carried out whatever the jitter, and the dead screen
 * retries by itself while the server still says the party is live.
 */

/** hls.js instances constructed, in order. */
let constructed = 0;
const configs: Record<string, unknown>[] = [];
const loaded: string[] = [];
const calls: string[] = [];
type Handler = (event: string, data: unknown) => void;
let handlers = new Map<string, Handler[]>();

vi.mock("hls.js", async () => {
  const actual = await vi.importActual<typeof import("hls.js")>("hls.js");
  const RealHls = actual.default;
  class CountingFakeHls {
    static isSupported() {
      return true;
    }
    static Events = RealHls.Events;
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      constructed += 1;
      configs.push(config);
      handlers = new Map();
      this.config = config;
    }
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }
    off() {}
    loadSource(url: string) {
      loaded.push(url);
    }
    attachMedia() {}
    destroy() {}
    startLoad(position?: number) {
      calls.push(`startLoad(${position})`);
    }
    stopLoad() {
      calls.push("stopLoad");
    }
    recoverMediaError() {
      calls.push("recoverMediaError");
    }
    get latency() {
      return 1;
    }
    get liveSyncPosition() {
      return 100;
    }
    get levels() {
      return [];
    }
    currentLevel = -1;
    nextLevel = -1;
  }
  return { ...actual, default: CountingFakeHls };
});

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getAuthToken: vi.fn(async () => "test-token"),
    fetchChannelLive: vi.fn(),
  };
});

const CHANNEL = "d5559e70-8b1c-4a0b-8ffc-b61c88004c73";
const LL_SRC = `https://hls.pqp.gg/api/voice/hls-playlist/${CHANNEL}/1789496087461?mode=ll&t=tok`;
const FRESH_SRC = `https://hls.pqp.gg/api/voice/hls-playlist/${CHANNEL}/1789496087461?mode=ll&t=fresh`;

const liveAnswer = {
  stream: { hlsUrl: FRESH_SRC },
  ended: false,
  partyLive: true,
};

describe("a rebuild the stall ladder decides", { timeout: 30_000 }, () => {
  let container: HTMLDivElement;
  let root: Root;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    constructed = 0;
    configs.length = 0;
    loaded.length = 0;
    calls.length = 0;
    handlers = new Map();
    // The jitter at its long end: 500 + 0.9 * 3500 = 3650 ms, three ticks.
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    vi.mocked(fetchChannelLive).mockReset();
    vi.mocked(fetchChannelLive).mockResolvedValue(liveAnswer as never);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    warn.mockRestore();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function settle() {
    for (let i = 0; i < 20; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
  }

  async function mount(mode: "ll" | "live" = "ll", src = LL_SRC) {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <HlsWatchPlayer src={src} layout="cinema" mode={mode} partTargetMs={500} />
        </TooltipProvider>,
      );
    });
    for (let i = 0; i < 200 && constructed === 0; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
    await settle();
    expect(constructed).toBe(1);
  }

  async function tick(times = 1) {
    for (let i = 0; i < times; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
    }
  }

  /** The film played, then starved: the rehearsal's shape. */
  async function stallAfterPlaying() {
    const video = container.querySelector("video")!;
    await act(async () => {
      video.dispatchEvent(new Event("playing"));
    });
    await act(async () => {
      video.dispatchEvent(new Event("waiting"));
    });
  }

  function rebuildLogs(): number {
    return warn.mock.calls.filter((args: unknown[]) =>
      String(args[0]).includes("rebuilding the player"),
    ).length;
  }

  function dead(): boolean {
    return container.querySelector('[data-testid="hls-dead"]') !== null;
  }

  it("carries out the rebuild even when its jitter is longer than a tick", async () => {
    await mount();
    await stallAfterPlaying();
    for (let i = 0; i < 60 && constructed === 1; i += 1) {
      await tick(1);
    }
    await settle();
    expect(rebuildLogs()).toBe(1);
    expect(constructed).toBe(2);
  });

  it("does not walk the in-place ladder over a rebuild it is waiting on", async () => {
    await mount();
    await stallAfterPlaying();
    for (let i = 0; i < 60 && rebuildLogs() === 0; i += 1) {
      await tick(1);
    }
    expect(rebuildLogs()).toBe(1);
    calls.length = 0;
    // Inside the 3.65 s jitter: nothing touches the loader it is about to
    // throw away.
    await tick(3);
    expect(calls).toEqual([]);
    expect(constructed).toBe(1);
    await tick(1);
    await settle();
    expect(constructed).toBe(2);
  });

  it("only declares the stream dead after the rebuilds it counted actually ran", async () => {
    await mount();
    for (let round = 0; round < 6 && !dead(); round += 1) {
      await stallAfterPlaying();
      const before = constructed;
      for (let i = 0; i < 60 && constructed === before && !dead(); i += 1) {
        await tick(1);
      }
      await settle();
    }
    expect(dead()).toBe(true);
    // Three real rebuilds (the bound), not three log lines and none made.
    expect(constructed).toBe(4);
    expect(rebuildLogs()).toBe(3);
  });

  it("does not spend the rebuild budget on a rebuild cancelled because the film recovered", async () => {
    await mount();
    const video = container.querySelector("video")!;
    for (let round = 0; round < 4; round += 1) {
      await stallAfterPlaying();
      const logged = rebuildLogs();
      for (let i = 0; i < 60 && rebuildLogs() === logged; i += 1) {
        await tick(1);
      }
      // The picture moves again inside the jitter: no rebuild needed.
      await act(async () => {
        video.dispatchEvent(new Event("playing"));
      });
      await tick(5);
    }
    expect(rebuildLogs()).toBe(4);
    expect(constructed).toBe(1);
    expect(dead()).toBe(false);
  });

  async function driveToDead() {
    await mount();
    for (let round = 0; round < 6 && !dead(); round += 1) {
      await stallAfterPlaying();
      const before = constructed;
      for (let i = 0; i < 60 && constructed === before && !dead(); i += 1) {
        await tick(1);
      }
      await settle();
    }
    expect(dead()).toBe(true);
  }

  it("retries from 'A transmissão caiu' by itself while the party is still live, onto a fresh URL", async () => {
    await driveToDead();
    const before = constructed;
    for (let i = 0; i < 40 && constructed === before; i += 1) {
      await tick(1);
      await settle();
    }
    expect(constructed).toBe(before + 1);
    expect(loaded.at(-1)).toBe(FRESH_SRC);
    expect(dead()).toBe(false);
  });

  it("rebuilds on the same URL when the server hands back exactly the one playing", async () => {
    vi.mocked(fetchChannelLive).mockResolvedValue({
      stream: { hlsUrl: LL_SRC },
      ended: false,
      partyLive: true,
    } as never);
    await driveToDead();
    const before = constructed;
    for (let i = 0; i < 40 && constructed === before; i += 1) {
      await tick(1);
      await settle();
    }
    expect(constructed).toBe(before + 1);
    expect(loaded.at(-1)).toBe(LL_SRC);
  });

  it("shows the party is over instead of retrying when the server says so", async () => {
    await driveToDead();
    vi.mocked(fetchChannelLive).mockResolvedValue({
      stream: null,
      ended: true,
      partyLive: false,
    } as never);
    const before = constructed;
    for (
      let i = 0;
      i < 40 && container.querySelector('[data-testid="hls-session-over"]') === null;
      i += 1
    ) {
      await tick(1);
      await settle();
    }
    expect(container.querySelector('[data-testid="hls-session-over"]')).not.toBeNull();
    expect(constructed).toBe(before);
  });

  it("the retry button still works, and on the fresh URL", async () => {
    await driveToDead();
    const before = constructed;
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="hls-dead"] button',
    )!;
    await act(async () => {
      button.click();
    });
    await settle();
    expect(constructed).toBe(before + 1);
    expect(loaded.at(-1)).toBe(FRESH_SRC);
  });

  it("a rebuild starts the new instance at the live edge, not at zero", async () => {
    await mount();
    await stallAfterPlaying();
    for (let i = 0; i < 60 && constructed === 1; i += 1) {
      await tick(1);
    }
    await settle();
    expect(constructed).toBe(2);
    // hls.js's `startPosition` default (-1) is "live edge" on a live
    // playlist; anything else here would be the rebuild choosing a spot.
    // The element reads t=0 for a moment only because a new MediaSource
    // starts its own timeline there, then hls.js seeks to the edge.
    expect(configs[1]!.startPosition ?? -1).toBe(-1);
    expect(calls.filter((c) => c.startsWith("startLoad(0"))).toEqual([]);
  });
});
