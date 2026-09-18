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

  it("draws the audience view as the picture once a playlist exists", () => {
    playerProps.length = 0;
    const html = render({ state: "live", liveStream: LIVE });
    expect(html).toContain("mock-hls-watch-player");
    expect(playerProps[0]?.forceMuted).toBe(true);
    expect(html).not.toContain("watch-party-waiting");
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

describe("WatchPartyStage: the host's own capture", () => {
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
    container.querySelector<HTMLButtonElement>("[data-watch-party-self-monitor]");
  const video = () =>
    container.querySelector<HTMLVideoElement>(
      '[data-testid="watch-party-presenter-preview"]',
    );

  it("fills the stage with the capture while there is no audience view, no toggle", () => {
    renderStage(null);
    expect(video()).not.toBeNull();
    expect(toggle()).toBeNull();
  });

  it("is a picture-in-picture, off by default, once the audience view is up", () => {
    renderStage(LIVE);
    expect(video()).toBeNull();
    expect(toggle()).not.toBeNull();
  });

  it("switching the PiP on mounts the video and persists the choice", () => {
    renderStage(LIVE);
    act(() => {
      toggle()?.click();
    });
    expect(video()).not.toBeNull();
    expect(window.localStorage.getItem("pqp:watch-party-self-monitor")).toBe("1");
    act(() => {
      toggle()?.click();
    });
    expect(video()).toBeNull();
    expect(window.localStorage.getItem("pqp:watch-party-self-monitor")).toBe("0");
  });
});
