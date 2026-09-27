// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import Hls from "hls.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resolveHlsUrl } from "@/lib/hls-playback";
import { HlsWatchPlayer } from "./hls-watch-player";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * THE SEAM: A TRANSCODE RESTART THAT KEEPS THE SESSION.
 *
 * When the egress restarts mid-party (it died, its playlist stuck, the
 * presenter's screen track was replaced, a deploy resumed it) the server
 * keeps the session: same `startedAt`, same URLs, and the media playlist
 * freezes for the seam (10-30 s) and then simply continues, the first new
 * segment behind `#EXT-X-DISCONTINUITY` with its PTS restarted and its
 * `PROGRAM-DATE-TIME` jumped forward by the gap. No new `voice-stream` URL
 * arrives, or one with the same URL does.
 *
 * A viewer rides that out with at most a short stall: one hls.js instance,
 * one `loadSource`, one `attachMedia`, one `video.src` on the native engine,
 * and never the session-over screen.
 */

const CHANNEL = "d5559e70-8b1c-4a0b-8ffc-b61c88004c73";
const STARTED_AT = 1789496087461;
const SRC = resolveHlsUrl(`/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}?t=tok`);
/** Same session, restamped token: what a same-session `voice-stream` carries. */
const RESTAMPED_SRC = resolveHlsUrl(
  `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}?t=tok2`,
);

const counts = {
  constructed: 0,
  loadSource: 0,
  attachMedia: 0,
  destroy: 0,
  stopLoad: 0,
  startLoad: 0,
};
const engine = { mse: true };
type Handler = (event: string, data: unknown) => void;
const handlers = new Map<string, Handler[]>();

vi.mock("hls.js", async () => {
  const actual = await vi.importActual<typeof import("hls.js")>("hls.js");
  const RealHls = actual.default;
  class FakeHls {
    static isSupported() {
      return engine.mse;
    }
    static Events = RealHls.Events;
    config: Record<string, unknown>;
    liveSyncPosition: number | null = 100;
    levels: unknown[] = [];
    currentLevel = -1;
    nextLevel = -1;
    latency = 20;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      counts.constructed += 1;
    }
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }
    off() {}
    loadSource() {
      counts.loadSource += 1;
    }
    attachMedia() {
      counts.attachMedia += 1;
    }
    stopLoad() {
      counts.stopLoad += 1;
    }
    startLoad() {
      counts.startLoad += 1;
    }
    recoverMediaError() {}
    destroy() {
      counts.destroy += 1;
    }
  }
  return { ...actual, default: FakeHls };
});

/** The server vouches for the SAME session all through the seam. */
const fetchChannelLive = vi.fn(async (_channelId: string) => ({
  stream: {
    hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}?t=tok`,
    startedAt: STARTED_AT,
  },
  ended: false,
  partyLive: true,
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getAuthToken: vi.fn(async () => "test-token"),
    fetchChannelLive: (channelId: string) => fetchChannelLive(channelId),
  };
});

// The player spreads its reconnect/rebuild over 0.5-4 s so a whole audience
// does not ask at once. Pinned to the floor here: a jitter longer than one
// stall tick lets the NEXT ladder step cancel a pending rebuild, which would
// make "never rebuilt" pass by luck rather than by design.
vi.mock("@/lib/reconnect-jitter", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reconnect-jitter")>(
    "@/lib/reconnect-jitter",
  );
  return { ...actual, drainJitterMs: () => 500 };
});

function fire(event: string, data: unknown) {
  for (const handler of handlers.get(event) ?? []) {
    handler(event, data);
  }
}

/** A conventional `LEVEL_UPDATED` whose newest segment is `endSN`. */
function levelUpdated(endSN: number) {
  return {
    details: {
      startSN: Math.max(0, endSN - 14),
      endSN,
      targetduration: 4,
      fragments: new Array(15).fill({}),
    },
  };
}

/** Everything that would mean the viewer was sent somewhere else. */
const HOLDING_IDS = [
  "hls-restarting",
  "hls-reconnecting",
  "hls-buffering",
  "hls-dead",
  "hls-session-over",
  "hls-awaiting-presenter",
];

describe("a same-session transcode restart (the seam)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let warn: ReturnType<typeof vi.spyOn>;
  /** What the element reports; the tests move it through the seam. */
  const media = { paused: false, readyState: 4 };
  let srcAssignments: string[] = [];
  let srcDescriptor: PropertyDescriptor | undefined;
  let canPlayTypeDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
      counts[key] = 0;
    }
    engine.mse = true;
    handlers.clear();
    fetchChannelLive.mockClear();
    media.paused = false;
    media.readyState = 4;
    srcAssignments = [];
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Every `video.src =` the player performs: on the native engine that
    // assignment IS the reload a seam must not cause.
    srcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
    let current = "";
    Object.defineProperty(HTMLMediaElement.prototype, "src", {
      configurable: true,
      get: () => current,
      set: (value: string) => {
        current = value;
        srcAssignments.push(value);
      },
    });
    canPlayTypeDescriptor = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      "canPlayType",
    );
    Object.defineProperty(HTMLMediaElement.prototype, "canPlayType", {
      configurable: true,
      value: () => "maybe",
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (srcDescriptor) {
      Object.defineProperty(HTMLMediaElement.prototype, "src", srcDescriptor);
    } else {
      delete (HTMLMediaElement.prototype as { src?: string }).src;
    }
    if (canPlayTypeDescriptor) {
      Object.defineProperty(
        HTMLMediaElement.prototype,
        "canPlayType",
        canPlayTypeDescriptor,
      );
    }
    warn.mockRestore();
    vi.useRealTimers();
  });

  function video(): HTMLVideoElement {
    const el = container.querySelector("video");
    expect(el).not.toBeNull();
    return el!;
  }

  async function render(src: string) {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <HlsWatchPlayer src={src} layout="cinema" mode="live" />
        </TooltipProvider>,
      );
    });
  }

  async function mount(src = SRC) {
    await render(src);
    const el = video();
    Object.defineProperty(el, "paused", {
      configurable: true,
      get: () => media.paused,
    });
    Object.defineProperty(el, "readyState", {
      configurable: true,
      get: () => media.readyState,
    });
    for (
      let i = 0;
      i < 200 && counts.loadSource === 0 && srcAssignments.length === 0;
      i += 1
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
    expect(counts.loadSource + srcAssignments.length).toBe(1);
  }

  async function dispatch(type: string) {
    await act(async () => {
      video().dispatchEvent(new Event(type));
    });
  }

  async function emit(event: string, data: unknown) {
    await act(async () => {
      fire(event, data);
    });
  }

  /** One second of wall clock: the player's stall tick, and any jitter. */
  async function second() {
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
  }

  function expectNeverRebuilt() {
    expect(counts.constructed).toBe(1);
    expect(counts.loadSource).toBe(1);
    expect(counts.attachMedia).toBe(1);
    expect(counts.destroy).toBe(0);
  }

  function holdingScreens(): string[] {
    return HOLDING_IDS.filter(
      (id) => container.querySelector(`[data-testid="${id}"]`) !== null,
    );
  }

  it("plays through a discontinuity (new cc, PTS and PDT jump) on the same instance", async () => {
    await mount();
    await dispatch("playing");
    let sn = 100;
    const pdt = Date.now();
    for (let s = 0; s < 40; s += 1) {
      if (s % 4 === 0) {
        sn += 1;
        await emit(Hls.Events.LEVEL_UPDATED, levelUpdated(sn));
        await emit(Hls.Events.FRAG_BUFFERED, {});
      }
      if (s === 12) {
        // The first segment of the new run: discontinuity counter moves, the
        // wall clock jumps by the gap, and hls.js skips the hole it leaves.
        await emit(Hls.Events.FRAG_CHANGED, {
          frag: { cc: 1, sn, start: 48, programDateTime: pdt + 75_000, level: 0 },
        });
        await emit(Hls.Events.ERROR, {
          fatal: false,
          type: "mediaError",
          details: "bufferSeekOverHole",
        });
        await emit(Hls.Events.ERROR, {
          fatal: false,
          type: "mediaError",
          details: "bufferStalledError",
        });
      }
      if (s === 20) {
        // The server may still push the same session: identical URL, and a
        // restamped token. Neither is a new session.
        await render(SRC);
        await render(RESTAMPED_SRC);
      }
      await second();
    }
    expectNeverRebuilt();
    expect(holdingScreens()).toEqual([]);
  });

  it("rides out a 25 s frozen playlist with a thin buffer, and resumes in place", async () => {
    await mount();
    await dispatch("playing");
    // The seam starts right away: the playlist answers, but its newest
    // segment stops moving. hls.js keeps polling it every 2 s.
    await emit(Hls.Events.LEVEL_UPDATED, levelUpdated(100));
    for (let s = 1; s <= 25; s += 1) {
      if (s === 2) {
        // A viewer with only a few seconds buffered starves early, so the
        // stall clock runs out before the playlist's own 20 s rule does.
        media.readyState = 2;
        await dispatch("waiting");
      }
      if (s % 2 === 0) {
        await emit(Hls.Events.LEVEL_UPDATED, levelUpdated(100));
      }
      await second();
    }
    // The seam ends: the same playlist continues behind a discontinuity.
    await emit(Hls.Events.LEVEL_UPDATED, levelUpdated(101));
    await emit(Hls.Events.FRAG_CHANGED, {
      frag: { cc: 1, sn: 101, start: 100, programDateTime: Date.now(), level: 0 },
    });
    await second();
    await emit(Hls.Events.FRAG_BUFFERED, {});
    await second();
    await second();
    // A slow first segment of the new run: playing again four seconds in.
    media.readyState = 4;
    await dispatch("playing");
    let sn = 101;
    for (let s = 0; s < 30; s += 1) {
      if (s % 4 === 3) {
        sn += 1;
        await emit(Hls.Events.LEVEL_UPDATED, levelUpdated(sn));
        await emit(Hls.Events.FRAG_BUFFERED, {});
      }
      await second();
    }
    expectNeverRebuilt();
    expect(holdingScreens()).toEqual([]);
  });

  it("keeps loading a frozen same-session playlist and clears the hold when it moves", async () => {
    await mount();
    await dispatch("playing");
    await emit(Hls.Events.LEVEL_UPDATED, levelUpdated(100));
    // The buffer outlasts the seam: the element never stops playing.
    let held = false;
    for (let s = 1; s <= 30 && !held; s += 1) {
      await emit(Hls.Events.LEVEL_UPDATED, levelUpdated(100));
      await second();
      held = warn.mock.calls.some((args: unknown[]) =>
        String(args[0]).includes("holding for restart"),
      );
    }
    expect(held).toBe(true);
    // The hold on a FROZEN playlist leaves hls.js polling it, so the moment
    // the sequence moves again it is seen; only a GONE playlist stops it.
    expect(counts.stopLoad).toBe(0);
    expect(holdingScreens()).toEqual(["hls-restarting"]);
    await second();
    await second();
    await emit(Hls.Events.LEVEL_UPDATED, levelUpdated(101));
    // No `playing` event is coming (it never stopped), and the restarting
    // copy must not outlive the seam for want of one.
    expect(holdingScreens()).toEqual([]);
    let sn = 101;
    for (let s = 0; s < 30; s += 1) {
      if (s % 4 === 3) {
        sn += 1;
        await emit(Hls.Events.LEVEL_UPDATED, levelUpdated(sn));
        await emit(Hls.Events.FRAG_BUFFERED, {});
      }
      await second();
    }
    expectNeverRebuilt();
    expect(holdingScreens()).toEqual([]);
  });

  it("native HLS (Safari/iOS) never re-assigns video.src through a seam", async () => {
    engine.mse = false;
    await mount();
    expect(counts.constructed).toBe(0);
    expect(srcAssignments).toEqual([SRC]);
    await dispatch("playing");
    // Native shows us no playlist: the seam is only a `waiting` that lasts.
    media.readyState = 2;
    await dispatch("waiting");
    for (let s = 0; s < 35; s += 1) {
      await second();
    }
    media.readyState = 4;
    await dispatch("playing");
    for (let s = 0; s < 20; s += 1) {
      await second();
    }
    expect(srcAssignments).toEqual([SRC]);
    expect(holdingScreens()).toEqual([]);
  });
});
