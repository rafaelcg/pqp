// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Capture the props the audience view hands `HlsWatchPlayer`. A static
 * render of the real player cannot see `mode`/`partTargetMs` (they only
 * reach hls.js inside an effect), and omitting them is exactly the host LL
 * preview bug: LL bytes from `?mode=ll` with conventional player config.
 */
const playerProps: Array<Record<string, unknown>> = [];

vi.mock("@/components/voice/hls-watch-player", () => ({
  HlsWatchPlayer: (props: Record<string, unknown>) => {
    playerProps.push(props);
    return (
      <div
        data-testid="mock-hls-watch-player"
        data-mode={String(props.mode ?? "")}
        data-part-target-ms={String(props.partTargetMs ?? "")}
      />
    );
  },
}));

import { WatchPartyStage } from "./watch-party-stage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const LIVE = {
  hlsUrl: "https://hls.pqp.gg/live/c/1/index.m3u8?t=x",
  startedAt: 1,
  presenterPeerId: "p",
  delaySeconds: 6,
} as unknown as NonNullable<Parameters<typeof WatchPartyStage>[0]["liveStream"]>;

/**
 * One stage, every state (pass 3 of `docs/plans/WATCH_PARTY_UI.md`).
 */
describe("WatchPartyStage states", () => {
  const render = (over: Partial<Parameters<typeof WatchPartyStage>[0]> = {}) =>
    renderToStaticMarkup(<WatchPartyStage state="holding" {...over} />);

  it("keeps the waiting selectors on the holding and preparing states", () => {
    expect(render({ state: "holding" })).toContain(
      'data-watch-party-waiting="idle"',
    );
    expect(render({ state: "preparing" })).toContain(
      'data-watch-party-waiting="preparing"',
    );
    expect(render({ state: "holding" })).toContain('data-watch-party-stage="holding"');
  });

  it("speaks to the host and to the viewer with different lines", () => {
    const host = render({ state: "preparing", hostSide: true });
    const viewer = render({ state: "preparing", hostName: "Rafa" });
    expect(host).not.toEqual(viewer);
    expect(viewer).toContain("Rafa");
  });

  it("says the stream ended, with the footer under it", () => {
    const html = render({ state: "ended", footer: <p>footer here</p> });
    expect(html).toContain('data-watch-party-stage="ended"');
    expect(html).toContain("footer here");
  });

  it("draws the audience view as the picture for a presenter who is not sharing", () => {
    // No capture of our own (a co-host who took over): the audience feed is
    // the only picture there is, so it becomes the primary panel.
    playerProps.length = 0;
    const html = render({ state: "live", hostSide: true, liveStream: LIVE });
    expect(html).toContain("mock-hls-watch-player");
    expect(playerProps[0]?.forceMuted).toBe(true);
    expect(html).not.toContain("watch-party-waiting");
    expect(html).not.toContain("watch-party-presenter-preview");
  });

  it("pins the reconnecting pill over the picture", () => {
    const html = render({ state: "reconnecting", liveStream: LIVE });
    expect(html).toContain("watch-party-stage-reconnecting");
  });
});

describe("WatchPartyStage audience view LL mode", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.localStorage.clear();
    playerProps.length = 0;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderWithStream(
    liveStream: NonNullable<Parameters<typeof WatchPartyStage>[0]["liveStream"]>,
  ) {
    act(() => {
      root.render(<WatchPartyStage state="live" liveStream={liveStream} />);
    });
  }

  it("forwards mode='ll' and partTargetMs into HlsWatchPlayer for an LL stream", () => {
    renderWithStream({
      ...LIVE,
      hlsUrl: "https://hls.pqp.gg/live/c/1/index.m3u8?mode=ll&t=x",
      mode: "ll",
      partTargetMs: 500,
    } as typeof LIVE);
    const last = playerProps[playerProps.length - 1];
    expect(last?.mode).toBe("ll");
    expect(last?.partTargetMs).toBe(500);
  });

  it("forwards mode='live' (conventional) when the stream omits mode", () => {
    renderWithStream(LIVE);
    const last = playerProps[playerProps.length - 1];
    expect(last?.mode).toBe("live");
  });
});

describe("WatchPartyStage: the host's own preview is the primary panel", () => {
  let container: HTMLDivElement;
  let root: Root;
  const stream = {} as unknown as MediaStream;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.localStorage.clear();
    playerProps.length = 0;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderStage(liveStream: typeof LIVE | null) {
    act(() => {
      root.render(
        <WatchPartyStage
          state="live"
          hostSide
          captureStream={stream}
          liveStream={liveStream}
        />,
      );
    });
  }
  const toggle = () =>
    container.querySelector<HTMLButtonElement>(
      "[data-watch-party-audience-monitor]",
    );
  const preview = () =>
    container.querySelector<HTMLVideoElement>(
      '[data-testid="watch-party-presenter-preview"]',
    );
  const audiencePlayer = () =>
    container.querySelector('[data-testid="mock-hls-watch-player"]');

  it("fills the stage with the host's own capture, no audience monitor, when there is no playlist yet", () => {
    renderStage(null);
    expect(preview()).not.toBeNull();
    expect(audiencePlayer()).toBeNull();
    expect(toggle()).toBeNull();
  });

  it("keeps the host's own capture primary and shows the audience feed as a smaller monitor by default", () => {
    renderStage(LIVE);
    // The host's real-time capture is the video element (the primary panel).
    expect(preview()).not.toBeNull();
    // The delayed audience feed is present too, by default, and muted.
    expect(audiencePlayer()).not.toBeNull();
    expect(playerProps[playerProps.length - 1]?.forceMuted).toBe(true);
    // And there is a control to close it (not to reveal it: it is already on).
    expect(toggle()).not.toBeNull();
  });

  it("closing the audience monitor hides it and persists the choice, and reopening restores it", () => {
    renderStage(LIVE);
    act(() => {
      toggle()?.click();
    });
    expect(audiencePlayer()).toBeNull();
    expect(window.localStorage.getItem("pqp:watch-party-audience-monitor")).toBe(
      "0",
    );
    // The host's own preview is still the primary panel while it is hidden.
    expect(preview()).not.toBeNull();
    act(() => {
      toggle()?.click();
    });
    expect(audiencePlayer()).not.toBeNull();
    expect(window.localStorage.getItem("pqp:watch-party-audience-monitor")).toBe(
      "1",
    );
  });

  it("honours a stored 'hidden' preference on first render", () => {
    window.localStorage.setItem("pqp:watch-party-audience-monitor", "0");
    renderStage(LIVE);
    expect(preview()).not.toBeNull();
    expect(audiencePlayer()).toBeNull();
    // The reopen control is still there.
    expect(toggle()).not.toBeNull();
  });
});
