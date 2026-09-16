// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Capture the props the "Público" monitor hands `HlsWatchPlayer`. A static
 * render of the real player cannot see `mode`/`partTargetMs` (they only
 * reach hls.js inside an effect), and omitting them is exactly the host LL
 * preview bug: LL bytes from `?mode=ll` with conventional player config.
 */
const audienceMonitorProps: Array<Record<string, unknown>> = [];

vi.mock("@/components/voice/hls-watch-player", () => ({
  HlsWatchPlayer: (props: Record<string, unknown>) => {
    audienceMonitorProps.push(props);
    return (
      <div
        data-testid="mock-hls-watch-player"
        data-mode={String(props.mode ?? "")}
        data-part-target-ms={String(props.partTargetMs ?? "")}
      />
    );
  },
}));

import { WatchPartyPresenterStage } from "./presenter-stage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * The presenter's stage (2026-09-13): two monitors and the activity feed
 * where the full-size mirror of the host's tab used to be.
 */
describe("WatchPartyPresenterStage", () => {
  const render = (over: Partial<Parameters<typeof WatchPartyPresenterStage>[0]> = {}) =>
    renderToStaticMarkup(
      <WatchPartyPresenterStage
        stream={null}
        liveStream={null}
        channelId="c1"
        audienceCount={0}
        hands={[]}
        {...over}
      />,
    );

  it("draws the two monitors and an empty activity feed before anything happens", () => {
    const html = render();
    expect(html).toContain("watch-party-presenter-stage");
    expect(html).toContain("Your screen");
    expect(html).toContain("Audience");
    expect(html).toContain("watch-party-activity");
    expect(html).toContain("Nothing yet");
    // No stream yet: no audience-monitor toggle, no player.
    expect(html).not.toContain("data-watch-party-audience-monitor");
  });

  it("offers the audience monitor, off by default, once the broadcast has a playlist", () => {
    const html = render({
      liveStream: { hlsUrl: "/api/x.m3u8", startedAt: 1, presenterPeerId: "p" },
    });
    expect(html).toContain("data-watch-party-audience-monitor");
    expect(html).toContain("See as the audience");
    expect(html).not.toContain("mock-hls-watch-player");
  });

  it("offers the self monitor, on by default, once a stream exists", () => {
    const html = render({ stream: {} as unknown as MediaStream });
    expect(html).toContain("data-watch-party-self-monitor");
    expect(html).toContain("watch-party-presenter-preview");
    expect(html).toContain("Close");
  });
});

/**
 * THE WIRING for the host's LL "Público" preview. Audience paths already
 * thread `mode`/`partTargetMs` (`watch-stage`, `cinema-stage`, `call-stage`);
 * the presenter monitor was the one call site that only passed `src`, so an
 * LL party handed the host LL playlist bytes with conventional hls.js
 * tuning. That is the 2026-09-16 host-preview failure with healthy WebRTC
 * and bursts of canceled `part-*.m4s` / `ll?_HLS_msn=` requests.
 */
describe("WatchPartyPresenterStage audience monitor LL mode", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.localStorage.clear();
    audienceMonitorProps.length = 0;
    // Opt the monitor on: the product defaults it off because it is a
    // second decode on the presenter's machine.
    window.localStorage.setItem("pqp:watch-party-audience-monitor", "1");
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderWithStream(
    liveStream: NonNullable<
      Parameters<typeof WatchPartyPresenterStage>[0]["liveStream"]
    >,
  ) {
    act(() => {
      root.render(
        <WatchPartyPresenterStage
          stream={null}
          liveStream={liveStream}
          channelId="c1"
          audienceCount={0}
          hands={[]}
        />,
      );
    });
  }

  it("forwards mode='ll' and partTargetMs into HlsWatchPlayer for an LL stream", () => {
    renderWithStream({
      hlsUrl: "https://hls.pqp.gg/live/c/1/index.m3u8?mode=ll&t=x",
      startedAt: 1,
      presenterPeerId: "p",
      mode: "ll",
      partTargetMs: 500,
      delaySeconds: 3,
    });

    expect(container.querySelector('[data-testid="mock-hls-watch-player"]')).not.toBeNull();
    expect(audienceMonitorProps).toHaveLength(1);
    expect(audienceMonitorProps[0]).toMatchObject({
      src: "https://hls.pqp.gg/live/c/1/index.m3u8?mode=ll&t=x",
      mode: "ll",
      partTargetMs: 500,
      forceMuted: true,
      layout: "mini",
      delaySeconds: 3,
    });
  });

  it("forwards mode='live' (conventional) when the stream omits mode", () => {
    renderWithStream({
      hlsUrl: "/api/x.m3u8",
      startedAt: 1,
      presenterPeerId: "p",
    });

    expect(audienceMonitorProps).toHaveLength(1);
    expect(audienceMonitorProps[0]).toMatchObject({
      mode: "live",
      // Fallback mirrors LIVE_HLS_REMUX_PART_MS's default; inert for
      // conventional because HlsWatchPlayer only reads it when mode='ll'.
      partTargetMs: 500,
    });
  });
});

/**
 * The self monitor toggle needs a real DOM: whether it persists across a
 * remount and whether the video element actually leaves the tree (not just
 * hidden — nothing should decode while it's off) can't be seen from static
 * markup.
 */
describe("WatchPartyPresenterStage self monitor toggle", () => {
  let container: HTMLDivElement;
  let root: Root;
  const stream = {} as unknown as MediaStream;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.localStorage.clear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderStage() {
    act(() => {
      root.render(
        <WatchPartyPresenterStage
          stream={stream}
          liveStream={null}
          channelId="c1"
          audienceCount={0}
          hands={[]}
        />,
      );
    });
  }

  function toggleButton(): HTMLButtonElement | null {
    return container.querySelector("[data-watch-party-self-monitor]");
  }

  function video(): HTMLVideoElement | null {
    return container.querySelector('[data-testid="watch-party-presenter-preview"]');
  }

  it("is on by default: the video is mounted and the toggle offers Close", () => {
    renderStage();
    expect(video()).not.toBeNull();
    expect(toggleButton()?.textContent).toContain("Close");
  });

  it("unmounts the video (not just hides it) when switched off, and persists the choice", () => {
    renderStage();
    act(() => {
      toggleButton()?.click();
    });
    expect(video()).toBeNull();
    expect(toggleButton()?.textContent).toContain("Show preview");
    expect(window.localStorage.getItem("pqp:watch-party-self-monitor")).toBe("0");

    // A fresh mount (e.g. remount on channel switch) reads the stored choice back.
    act(() => {
      root.unmount();
    });
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    renderStage();
    expect(video()).toBeNull();
    expect(toggleButton()?.textContent).toContain("Show preview");
  });

  it("switching back on remounts the video", () => {
    renderStage();
    act(() => {
      toggleButton()?.click(); // off
    });
    act(() => {
      toggleButton()?.click(); // on again
    });
    expect(video()).not.toBeNull();
    expect(window.localStorage.getItem("pqp:watch-party-self-monitor")).toBe("1");
  });
});
