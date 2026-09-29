// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HlsWatchPlayer } from "./hls-watch-player";
import {
  resetPartyFastStartForTests,
  setPartyFastStart,
} from "@/lib/party-fast-start";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * `party_fast_start`, on the real player.
 *
 * Two things a newcomer meets in the first seconds. With the flag OFF the
 * holding screen over a stream that has not started says "The stream stalled,
 * reconnecting" (the default answer of `resolveHoldingScreenReason`, which
 * cannot tell a first load from a stall) beside a 1.1 MB film. With it ON the
 * screen says what it is waiting for and the film is held back. The flag is read once per mount, so each case sets it
 * BEFORE mounting, the way the app shell does from the server's config.
 */

const loadSource = vi.fn();

vi.mock("hls.js", async () => {
  const actual = await vi.importActual<typeof import("hls.js")>("hls.js");
  class FakeHls {
    static isSupported() {
      return true;
    }
    static Events = actual.default.Events;
    config: Record<string, unknown> = {};
    constructor() {}
    on() {}
    off() {}
    loadSource(url: string) {
      loadSource(url);
    }
    attachMedia() {}
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
  return { ...actual, default: FakeHls };
});

const SRC = "https://hls.pqp.gg/api/voice/hls-playlist/chan/1789496087461?t=tok";

describe("HlsWatchPlayer with party_fast_start", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    loadSource.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetPartyFastStartForTests();
  });

  async function mount() {
    await act(async () => {
      root.render(<HlsWatchPlayer layout="cinema" src={SRC} mode="live" />);
    });
    for (let i = 0; i < 200 && loadSource.mock.calls.length === 0; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
  }

  it("flag off: today's caption and the film at once", async () => {
    await mount();
    expect(container.textContent).toContain("The stream stalled, reconnecting");
    expect(container.textContent).not.toContain("Connecting to the stream");
    // The bubbles film loads at once, as it always did.
    expect(container.querySelector("video[data-decorative]")).not.toBeNull();
  });

  it("flag on: says what it waits for and holds the film back", async () => {
    setPartyFastStart(true);
    await mount();
    expect(container.textContent).toContain("Connecting to the stream");
    expect(container.textContent).not.toContain("stalled");
    expect(container.querySelector("video[data-decorative]")).toBeNull();
  });

  it("flag on: a slow start counts out loud", async () => {
    setPartyFastStart(true);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await mount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_500);
      });
      expect(container.textContent).toMatch(/Still loading, [56]s so far/);
    } finally {
      vi.useRealTimers();
    }
  });
});
