// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
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
    expect(html).not.toContain("hls-mini-chrome");
  });

  it("offers the self monitor, on by default, once a stream exists", () => {
    const html = render({ stream: {} as unknown as MediaStream });
    expect(html).toContain("data-watch-party-self-monitor");
    expect(html).toContain("watch-party-presenter-preview");
    expect(html).toContain("Close");
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
