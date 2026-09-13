import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WatchPartyPresenterStage } from "./presenter-stage";

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
});
