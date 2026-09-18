// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resolveHlsUrl } from "@/lib/hls-playback";
import { HlsWatchPlayer } from "./hls-watch-player";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * THE VIEWER HALF OF 2026-09-17.
 *
 * Rafael's second tab sat on the holding screen -- "Respira. A stream ta
 * chegando." over "A transmissão travou, reconectando" -- for minutes after
 * the party had ended, while the sidebar card beside it already said
 * "Montando. Toca pra continuar." Nothing recovered on its own and nothing
 * ever would have: the only thing the stall watchdog can conclude from a
 * playlist that stops answering is "still trying", which it does until its
 * budget runs out and it says the stream crashed.
 *
 * The server knew. `GET /api/channels/:id/live` answers `stream: null` with
 * `ended: true` for a null it can vouch for, and `reconnect()` was already
 * calling it on every check and throwing the answer away as "nothing
 * fresher". These tests are that answer being believed, and the way back out
 * when a new session starts.
 */

type ErrorHandler = (event: string, data: Record<string, unknown>) => void;

const loadSource = vi.fn();
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
    startLoad() {}
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
const SRC = resolveHlsUrl(
  `/api/voice/hls-playlist/${CHANNEL}/1789672792562?t=tok`,
);
/** The next party: a different `startedAt`, which is a different session. */
const NEXT_SRC = resolveHlsUrl(
  `/api/voice/hls-playlist/${CHANNEL}/1789673999999?t=tok2`,
);

describe("a watch player whose session is over", () => {
  let container: HTMLDivElement;
  let root: Root;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    loadSource.mockClear();
    fetchChannelLive.mockClear();
    errorHandlers.length = 0;
    liveAnswer.stream = null;
    liveAnswer.ended = true;
    liveAnswer.partyLive = false;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Fake timers with `shouldAdvanceTime`, the same shape the conventional
    // recovery suite uses: the player's 1 s stall tick and its 20 s
    // session-over poll are both driven here, and real `await`s still work.
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
    expect(loadSource).toHaveBeenCalled();
  }

  async function rerender(props: PlayerProps) {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <HlsWatchPlayer layout="cinema" {...props} />
        </TooltipProvider>,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5);
    });
  }

  /** The playlist stops answering: a 404 on our own proxy, session gone. */
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

  /** One or more passes of the player's own timers, flushed into React. */
  async function tick(times = 1, ms = 1_000) {
    for (let i = 0; i < times; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    }
  }

  /** Drain the stall ticks until the watchdog's reconnect check has landed. */
  async function settleReconnect() {
    for (let i = 0; i < 40 && fetchChannelLive.mock.calls.length === 0; i += 1) {
      await tick();
    }
    // The answer arrives a microtask after the request; give the state it
    // sets a flush of its own.
    await tick();
  }

  it("says the session ended instead of reconnecting forever", async () => {
    await mount({ src: SRC, mode: "live" });
    emitPlaylist404();
    // The restarting hold is correct at this instant: from here it looks
    // exactly like an egress being replaced.
    expect(
      container.querySelector('[data-testid="hls-restarting"]'),
    ).not.toBeNull();

    await settleReconnect();

    expect(fetchChannelLive).toHaveBeenCalledWith(CHANNEL);
    expect(
      container.querySelector('[data-testid="hls-session-over"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="hls-restarting"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="hls-reconnecting"]'),
    ).toBeNull();
  });

  it("says the presenter is coming back when the party is still live", async () => {
    liveAnswer.partyLive = true;
    await mount({ src: SRC, mode: "live" });
    emitPlaylist404();
    await settleReconnect();

    expect(
      container.querySelector('[data-testid="hls-awaiting-presenter"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="hls-session-over"]')).toBeNull();
  });

  it("tells its caller, once, so the pane can go back to the party panel", async () => {
    const onSessionOver = vi.fn();
    await mount({ src: SRC, mode: "live", onSessionOver });
    emitPlaylist404();
    await settleReconnect();
    expect(onSessionOver).toHaveBeenCalledWith("over");
  });

  it("keeps what it has when the server cannot vouch for the null", async () => {
    // `ended` absent is "the session table could not be asked". Reading that
    // as the party being over is the failure the field exists to prevent, so
    // the ordinary stall vocabulary has to stay.
    liveAnswer.ended = undefined;
    await mount({ src: SRC, mode: "live" });
    emitPlaylist404();
    await settleReconnect();

    expect(container.querySelector('[data-testid="hls-session-over"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="hls-restarting"]'),
    ).not.toBeNull();
  });

  it("stops asking on the stall ladder's cadence once it knows", async () => {
    await mount({ src: SRC, mode: "live" });
    emitPlaylist404();
    await settleReconnect();
    const asked = fetchChannelLive.mock.calls.length;

    // Ten more seconds of stall ticks. The watchdog is stood down: it must
    // not spend its reconnect budget (and reach "A transmissão caiu") on a
    // party that simply finished. Ten seconds is half the session-over
    // poll's own interval, so nothing else should ask either.
    await tick(10);
    expect(fetchChannelLive.mock.calls.length).toBe(asked);
    expect(container.querySelector('[data-testid="hls-dead"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="hls-session-over"]'),
    ).not.toBeNull();
  });

  it("recovers on its own when a new session arrives as a prop", async () => {
    await mount({ src: SRC, mode: "live" });
    emitPlaylist404();
    await settleReconnect();
    expect(
      container.querySelector('[data-testid="hls-session-over"]'),
    ).not.toBeNull();

    // The server started the next party and pushed `voice-stream`. No
    // reload, nothing pressed.
    await rerender({ src: NEXT_SRC, mode: "live" });
    expect(container.querySelector('[data-testid="hls-session-over"]')).toBeNull();
    expect(loadSource).toHaveBeenCalledWith(NEXT_SRC);
  });

  it("recovers on its own through its own slow poll when no push arrives", async () => {
    await mount({ src: SRC, mode: "live" });
    emitPlaylist404();
    await settleReconnect();
    expect(
      container.querySelector('[data-testid="hls-session-over"]'),
    ).not.toBeNull();

    // The `voice-stream` frame never came (a lost frame, a socket that
    // reconnected in between) -- the case that used to need a reload.
    liveAnswer.stream = { hlsUrl: NEXT_SRC, startedAt: 1789673999999 };
    liveAnswer.ended = undefined;
    await tick(25);
    expect(container.querySelector('[data-testid="hls-session-over"]')).toBeNull();
    expect(loadSource).toHaveBeenCalledWith(NEXT_SRC);
  });
});
