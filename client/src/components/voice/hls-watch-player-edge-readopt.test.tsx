// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HlsWatchPlayer } from "./hls-watch-player";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * THE PRODUCTION STALL OF 2026-09-19, channel d5559e70.
 *
 * A host's console showed the HLS player stuck polling ONE dead session's
 * playlist for MINUTES: it requested
 * `https://hls.pqp.gg/api/voice/hls-playlist/<ch>/<old startedAt>/720p30?t=...`
 * and got 502, then 503, then 404, on a loop, ending in an hls.js
 * "recover-media-error" stall -- while the DB proved that `startedAt` had
 * ended minutes earlier and TWO newer sessions had started since. The client
 * never moved to the new live session.
 *
 * ROOT CAUSE. Production serves playlists from the edge host `hls.pqp.gg`
 * (`LIVE_HLS_PLAYLIST_BASE_URL`), but `isOwnHlsPlaylistProxyUrl` matched only
 * the API origin (`getApiBaseUrl()`), so an `hls.pqp.gg` URL returned false.
 * The conventional restart fast path (`isPlaylistGoneError` -> hold ->
 * `reconnect()` -> adopt) is gated on that check, so the 404 fell to the
 * FATAL ladder, which rebuilds in place and NEVER calls `fetchChannelLive`.
 * The player hammered the dead `startedAt` until the watchdog gave up.
 *
 * These tests drive an EDGE-HOST src while `getApiBaseUrl()` is empty (the
 * test env), which is exactly the host mismatch production had, and assert
 * the player discovers and adopts the new session.
 */

type ErrorHandler = (event: string, data: Record<string, unknown>) => void;

const loadSource = vi.fn();
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
    attachMedia() {}
    stopLoad() {}
    startLoad(position?: number) {
      startLoad(position);
    }
    recoverMediaError() {}
    destroy() {}
  }
  return { ...actual, default: FakeHls };
});

/** What the API says about the channel this player is watching. */
const liveAnswer: {
  stream: { hlsUrl: string; startedAt: number } | null;
  ended?: boolean;
  partyLive?: boolean;
} = { stream: null, ended: true, partyLive: false };
const fetchChannelLive = vi.fn(async (_channelId: string) => liveAnswer);

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getAuthToken: vi.fn(async () => "test-token"),
    fetchChannelLive: (channelId: string) => fetchChannelLive(channelId),
  };
});

const CHANNEL = "d5559e70-8b1c-4a0b-8ffc-b61c88004c73";
/** The dead session, served from the edge host, with its `startedAt` baked in. */
const DEAD_SRC = `https://hls.pqp.gg/api/voice/hls-playlist/${CHANNEL}/1789827233443?t=tok`;
/** The live session the client must move to: a DIFFERENT `startedAt`. */
const LIVE_STARTED_AT = 1789827705465;
const LIVE_SRC = `https://hls.pqp.gg/api/voice/hls-playlist/${CHANNEL}/${LIVE_STARTED_AT}?t=tok2`;

describe("a watch player on the edge host whose session died", () => {
  let container: HTMLDivElement;
  let root: Root;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    loadSource.mockClear();
    startLoad.mockClear();
    fetchChannelLive.mockClear();
    errorHandlers.length = 0;
    // The next party is already live: a different session at a fresh URL.
    liveAnswer.stream = { hlsUrl: LIVE_SRC, startedAt: LIVE_STARTED_AT };
    liveAnswer.ended = undefined;
    liveAnswer.partyLive = true;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers({ shouldAdvanceTime: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    warn.mockRestore();
    vi.useRealTimers();
  });

  type PlayerProps = Parameters<typeof HlsWatchPlayer>[0];

  async function mount(props: PlayerProps) {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <HlsWatchPlayer layout="cinema" {...props} />
        </TooltipProvider>,
      );
    });
    for (let i = 0; i < 200 && loadSource.mock.calls.length === 0; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
    expect(loadSource).toHaveBeenCalledWith(DEAD_SRC);
    loadSource.mockClear();
  }

  function emitError(data: Record<string, unknown>) {
    const handler = errorHandlers[errorHandlers.length - 1]!;
    act(() => {
      handler("hlsError", data);
    });
  }

  /** A level (media playlist) load error, the shape the edge host produced. */
  function levelLoadError(code: number, fatal = false) {
    return {
      fatal,
      type: "networkError",
      details: "levelLoadError",
      response: { code },
    };
  }

  /** Drain stall ticks until the reconnect check has fetched channel-live. */
  async function settleReconnect() {
    for (let i = 0; i < 60 && fetchChannelLive.mock.calls.length === 0; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }
    // The answer arrives a microtask after the request; flush the adopt.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
  }

  it("adopts the new startedAt instead of looping on the dead one (404)", async () => {
    await mount({ src: DEAD_SRC, mode: "live" });
    // The dead session's master answered 404, on the edge host.
    emitError({
      fatal: true,
      type: "networkError",
      details: "manifestLoadError",
      response: { code: 404 },
    });
    await settleReconnect();

    expect(fetchChannelLive).toHaveBeenCalledWith(CHANNEL);
    // It moved onto the live session's URL, not the dead one.
    expect(loadSource).toHaveBeenCalledWith(LIVE_SRC);
  });

  it("reproduces the exact 502 -> 503 -> 404 sequence and moves to the live session", async () => {
    await mount({ src: DEAD_SRC, mode: "live" });
    // The exact sequence from the host's console, on the edge host: two
    // server errors, then the object gone. The precise 404 fast path never
    // fired (host mismatch); the safety net does, off the run of failures.
    emitError(levelLoadError(502));
    emitError(levelLoadError(503));
    emitError(levelLoadError(404, true));
    await settleReconnect();

    expect(fetchChannelLive).toHaveBeenCalledWith(CHANNEL);
    expect(loadSource).toHaveBeenCalledWith(LIVE_SRC);
    // And it never spun forever declaring the stream dead: no dead screen.
    expect(container.querySelector('[data-testid="hls-dead"]')).toBeNull();
  });

  it("shows the ended state, without an infinite re-fetch, when nothing replaces it", async () => {
    // The party is genuinely over: no stream, and the server vouches for it.
    liveAnswer.stream = null;
    liveAnswer.ended = true;
    liveAnswer.partyLive = false;
    await mount({ src: DEAD_SRC, mode: "live" });
    emitError(levelLoadError(502));
    emitError(levelLoadError(503, true));
    await settleReconnect();

    expect(fetchChannelLive).toHaveBeenCalledWith(CHANNEL);
    expect(
      container.querySelector('[data-testid="hls-session-over"]'),
    ).not.toBeNull();

    // Let any reconnect still in flight when "over" landed settle out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    // Now it must STAND DOWN: no more stall-cadence fetching once it knows.
    // Ten seconds is under the 20 s session-over poll, so nothing may ask.
    const asked = fetchChannelLive.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchChannelLive.mock.calls.length).toBe(asked);
    expect(container.querySelector('[data-testid="hls-dead"]')).toBeNull();
  });

  it("does not re-adopt on a healthy stream: no failure, no discovery", async () => {
    await mount({ src: DEAD_SRC, mode: "live" });
    // Not a single playlist error is emitted. Fifteen seconds of normal
    // ticks must never ask the server for a fresher session or re-attach.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchChannelLive).not.toHaveBeenCalled();
    expect(loadSource).not.toHaveBeenCalled();
  });

  /**
   * THE 2026-09-23 SHAPE: the failures were the API's (a database blip past
   * the playlist proxy's grace answering 503), not the stream's. The hold
   * stops the loader and asks what is live, and the server vouches for the
   * SAME session. That answer used to change nothing: the loader stayed
   * stopped, the hold only clears on an advancing playlist a stopped loader
   * never fetches, and the viewer reached "A transmissão caiu" however soon
   * the database came back.
   */
  it("resumes the SAME session in place when the server vouches for it after a hold", async () => {
    const DEAD_STARTED_AT = 1789827233443;
    liveAnswer.stream = {
      // Same `startedAt`, fresher token: the restamp every live answer carries.
      hlsUrl: `https://hls.pqp.gg/api/voice/hls-playlist/${CHANNEL}/${DEAD_STARTED_AT}?t=fresh`,
      startedAt: DEAD_STARTED_AT,
    };
    await mount({ src: DEAD_SRC, mode: "live" });
    emitError(levelLoadError(503));
    emitError(levelLoadError(503));
    await settleReconnect();

    expect(fetchChannelLive).toHaveBeenCalledWith(CHANNEL);
    // Loading again, in place: no re-attach, no new source.
    expect(startLoad).toHaveBeenCalled();
    expect(loadSource).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="hls-dead"]')).toBeNull();
  });

  it("bounds the re-fetch: one transient blip does not trigger discovery", async () => {
    await mount({ src: DEAD_SRC, mode: "live" });
    // A single, non-fatal server error is a blip, not a gone session. It
    // must not, on its own, spend a fetch asking the server what is live.
    emitError(levelLoadError(503));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(fetchChannelLive).not.toHaveBeenCalled();
  });
});
