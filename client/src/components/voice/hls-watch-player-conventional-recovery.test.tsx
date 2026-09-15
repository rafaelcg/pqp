// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import Hls from "hls.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HlsWatchPlayer } from "./hls-watch-player";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * THE CONVENTIONAL PATH, PINNED BY CHARACTERISATION.
 *
 * #646 changed the recovery ladder, the watchdog and the hls.js config for a
 * low-latency watch party, and was reverted (#650) because ten minutes later
 * a CONVENTIONAL party went black and looped, and nothing in the repo could
 * prove #646 had not caused it. (It had not: the LiveKit egress had died --
 * "playlist stuck for 20000 ms", libav decode errors from the presenter's
 * packet loss.) The reviewer was right to ask anyway, and the gap was real:
 * every test that PR added drove an LL stream.
 *
 * So this suite exists to be the thing that answers that question, and it
 * was written against post-revert `main` FIRST: every number below was
 * recorded from the player as it behaved before #646 landed a second time,
 * never hand-written. If a change to the LL path moves any of them, the LL
 * gate leaked and this suite says exactly where.
 *
 * `mode: "live"` throughout -- the product path for every watch party
 * anybody has ever run.
 */

/** Every loader call and seek the player made, in order. */
const calls: string[] = [];
/** What the fake reports as hls.js's own live sync point. */
const engine = { liveSyncPosition: null as number | null };
/** The merged hls.js config of the last constructed instance. */
let lastConfig: Record<string, unknown> = {};
type Handler = (event: string, data: unknown) => void;
const handlers = new Map<string, Handler[]>();

vi.mock("hls.js", async () => {
  const actual = await vi.importActual<typeof import("hls.js")>("hls.js");
  const RealHls = actual.default;
  class RecordingFakeHls {
    static isSupported() {
      return true;
    }
    static Events = RealHls.Events;
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      // The real merge, so what is asserted below is what hls.js would
      // actually run with -- a key hls.js does not recognise is dropped
      // silently, which looks exactly like a policy that works.
      const probe = new RealHls(config as never);
      this.config = probe.config as unknown as Record<string, unknown>;
      lastConfig = this.config;
      probe.destroy();
    }
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }
    off() {}
    loadSource() {
      calls.push("loadSource");
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
      return engine.liveSyncPosition;
    }
    get levels() {
      return [];
    }
    currentLevel = -1;
    nextLevel = -1;
  }
  return { ...actual, default: RecordingFakeHls };
});

/** A conventional watch party's playlist, through our own proxy. */
const LIVE_SRC =
  "https://api.pqp.gg/api/voice/hls-playlist/d5559e70-8b1c-4a0b-8ffc-b61c88004c73/1789496087461?t=tok";

function fire(event: string, data: unknown) {
  for (const handler of handlers.get(event) ?? []) {
    handler(event, data);
  }
}

/** hls.js's shape for a fatal decode stall. */
function fatalMediaError() {
  return {
    fatal: true,
    type: "mediaError",
    details: "bufferStalledError",
    response: undefined,
  };
}

/** A 404 on a segment: the error #646's live-edge jump is about. */
function missingSegmentError() {
  return {
    fatal: true,
    type: "networkError",
    details: "fragLoadError",
    response: { code: 404, text: "Not Found" },
  };
}

/** One `LEVEL_UPDATED` from a conventional playlist at media sequence `sn`. */
function levelUpdated(sn: number) {
  return {
    details: {
      startSN: sn,
      lastPartSn: undefined,
      lastPartIndex: undefined,
      partHoldBack: undefined,
      fragments: new Array(15).fill({}),
    },
  };
}

describe("the conventional recovery ladder is what it was before #646", () => {
  let container: HTMLDivElement;
  let root: Root;
  let warn: ReturnType<typeof vi.spyOn>;
  let currentTimeDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    calls.length = 0;
    handlers.clear();
    lastConfig = {};
    engine.liveSyncPosition = 1_500;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Every seek the player performs, in the same list as the loader calls:
    // "restart the loader HERE and move the element THERE" is one decision
    // and the two halves have to be read together.
    currentTimeDescriptor = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      "currentTime",
    );
    let currentTime = 0;
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
        calls.push(`seek(${value})`);
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (currentTimeDescriptor) {
      Object.defineProperty(
        HTMLMediaElement.prototype,
        "currentTime",
        currentTimeDescriptor,
      );
    }
    warn.mockRestore();
    vi.useRealTimers();
  });

  async function mount() {
    await act(async () => {
      root.render(
        <HlsWatchPlayer src={LIVE_SRC} layout="cinema" mode="live" />,
      );
    });
    for (let i = 0; i < 200 && !handlers.has(Hls.Events.ERROR); i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
    expect(handlers.has(Hls.Events.ERROR)).toBe(true);
    calls.length = 0;
  }

  /** One pass of the player's 1 s stall tick. */
  async function tick(times = 1) {
    for (let i = 0; i < times; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
    }
  }

  /**
   * THE CONSTRUCTOR CONFIG. #646 added an LL `fragLoadPolicy` paced to a 500
   * ms part (three tries, 200 ms to 1 s, and a two-second first-byte
   * deadline). A conventional stream must still get hls.js's own stock
   * budget -- six error retries at 1/2/4/8/8 s against a 10 s first byte --
   * because a 4 s segment is worth waiting eight seconds for and a part is
   * not. Every number below was read off post-revert `main`.
   */
  it("builds the same hls.js config it built before #646", async () => {
    await mount();
    expect(lastConfig.lowLatencyMode).toBe(true);
    expect(lastConfig.liveSyncDurationCount).toBe(5);
    expect(lastConfig.liveMaxLatencyDurationCount).toBe(12);
    expect(lastConfig.maxBufferLength).toBe(24);
    expect(lastConfig.maxMaxBufferLength).toBe(40);
    expect(lastConfig.backBufferLength).toBe(12);
    expect(lastConfig.startLevel).toBe(-1);
    expect(lastConfig.nudgeMaxRetry).toBe(8);
    // Never set on the conventional path: `applyLlLatencyCeiling` (and the
    // manifest-derived ceiling #646 put on `LEVEL_UPDATED`) is LL-only.
    expect(lastConfig.liveMaxLatencyDuration).toBeUndefined();
    expect(lastConfig.liveSyncDuration).toBeUndefined();
    // hls.js's stock fragment budget, untouched.
    expect(
      (lastConfig.fragLoadPolicy as { default: unknown }).default,
    ).toEqual({
      maxTimeToFirstByteMs: 10_000,
      maxLoadTimeMs: 120_000,
      timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: { maxNumRetry: 6, retryDelayMs: 1_000, maxRetryDelayMs: 8_000 },
    });
    // And the manifest/playlist budgets, which #646 never claimed to touch.
    expect(
      (lastConfig.manifestLoadPolicy as { default: unknown }).default,
    ).toEqual({
      maxTimeToFirstByteMs: Infinity,
      maxLoadTimeMs: 20_000,
      timeoutRetry: { maxNumRetry: 12, retryDelayMs: 1_000, maxRetryDelayMs: 8_000 },
      errorRetry: { maxNumRetry: 12, retryDelayMs: 1_000, maxRetryDelayMs: 8_000 },
    });
    expect(
      (lastConfig.playlistLoadPolicy as { default: unknown }).default,
    ).toEqual({
      maxTimeToFirstByteMs: 10_000,
      maxLoadTimeMs: 20_000,
      timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: { maxNumRetry: 2, retryDelayMs: 1_000, maxRetryDelayMs: 8_000 },
    });
  });

  /**
   * THE FATAL LADDER, EXACTLY. `recoverMediaError` / `start-load` /
   * `restart-load`, three full cycles before a rebuild, and every
   * `startLoad` at `-1` -- "resume where the playhead was", which inside a
   * conventional 60 s window is right and is what #646 changed for LL only.
   * The seek that follows each step is `liveSyncPosition` (1500) minus one
   * segment (4 s), and it is unchanged too.
   */
  it("walks the fatal ladder with startLoad(-1), not at the live edge", async () => {
    await mount();
    await act(async () => {
      fire(Hls.Events.ERROR, fatalMediaError());
    });
    calls.length = 0;
    await tick(6);
    expect(calls).toEqual([
      "recoverMediaError",
      "seek(1496)",
      "startLoad(-1)",
      "seek(1496)",
      "stopLoad",
      "startLoad(-1)",
      "seek(1496)",
      "recoverMediaError",
      "seek(1496)",
      "startLoad(-1)",
      "seek(1496)",
      "stopLoad",
      "startLoad(-1)",
      "seek(1496)",
    ]);
  });

  /**
   * THE ONE THE REVERT WAS ABOUT. #646 made a fatal 404/410 on a fragment a
   * bounded jump to the live edge instead of an escalation. On a
   * conventional stream that must not happen at all: the error handler does
   * nothing of its own, and the ordinary ladder picks it up on the next
   * tick, at `-1`, exactly as it did before.
   */
  it("does not jump to live on a 404'd segment; it escalates as it always did", async () => {
    await mount();
    await act(async () => {
      fire(Hls.Events.ERROR, missingSegmentError());
    });
    // Nothing at all from the error handler itself.
    expect(calls).toEqual([]);
    await tick(3);
    expect(calls).toEqual([
      "recoverMediaError",
      "seek(1496)",
      "startLoad(-1)",
      "seek(1496)",
      "stopLoad",
      "startLoad(-1)",
      "seek(1496)",
    ]);
  });

  /**
   * A FROZEN PLAYLIST -- the egress dead, the same media sequence answered
   * for as long as anyone polls -- IS NOT A SEEK LOOP, and was not one
   * before #646 either. Twenty seconds of a stuck `EXT-X-MEDIA-SEQUENCE`
   * opens the `sequence-stuck` ladder, which spends its three in-place steps
   * (one seek each, all to the same point, because a frozen playlist's edge
   * does not move) and then stops touching the element entirely: from there
   * it is bounded, backed-off `reconnect` checks for a fresher session.
   * Three seeks in thirty seconds, never a fourth.
   */
  it("does not loop on a frozen playlist: three in-place steps, then reconnect checks", async () => {
    await mount();
    for (let i = 0; i < 30; i += 1) {
      await act(async () => {
        fire(Hls.Events.LEVEL_UPDATED, levelUpdated(4_200));
      });
      await tick(1);
    }
    expect(calls).toEqual([
      "startLoad(-1)",
      "seek(1496)",
      "stopLoad",
      "startLoad(-1)",
      "seek(1496)",
      "stopLoad",
      "startLoad(-1)",
      "seek(1496)",
    ]);
    expect(warn.mock.calls.map((args: unknown[]) => String(args[0]))).toEqual([
      "[hls] stream stalled (sequence-stuck), start-load",
      "[hls] stream stalled (sequence-stuck), restart-load",
      "[hls] stream stalled (sequence-stuck), reload-level",
      "[hls] stream stalled (sequence-stuck), checking for a fresher session",
      "[hls] stream stalled (sequence-stuck), checking for a fresher session",
    ]);
  });
});
