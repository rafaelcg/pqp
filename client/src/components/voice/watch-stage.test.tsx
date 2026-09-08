import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WatchStage, watchAudienceCount } from "./watch-stage";

/**
 * The seatless watch stage: a picture, a count, and one way into the call.
 * Rendered without a browser, like `call-controls-watch-party.test.tsx`, so
 * what is pinned is what a person is offered, not what hls.js does with it.
 */
describe("WatchStage", () => {
  const hlsUrl = "https://api.example.test/api/voice/hls-playlist/c1/1?t=tok";

  it("offers the join button and says how many are watching", () => {
    const html = renderToStaticMarkup(
      <WatchStage
        hlsUrl={hlsUrl}
        delaySeconds={10}
        audienceCount={12}
        ended={false}
        onJoin={() => {}}
      />,
    );
    expect(html).toContain('data-testid="watch-stage-join"');
    expect(html).toContain("Join the call");
    expect(html).toContain("12 people watching");
    expect(html).toContain('data-testid="watch-stage-live"');
    expect(html).toContain("~10s delay");
    expect(html).toContain("<video");
  });

  it("uses the singular for one watcher", () => {
    const html = renderToStaticMarkup(
      <WatchStage
        hlsUrl={hlsUrl}
        audienceCount={1}
        ended={false}
        onJoin={() => {}}
      />,
    );
    expect(html).toContain("1 person watching");
  });

  it("says the stream ended instead of showing a dead player", () => {
    const html = renderToStaticMarkup(
      <WatchStage hlsUrl={null} audienceCount={0} ended onJoin={() => {}} />,
    );
    expect(html).toContain("The stream ended");
    expect(html).not.toContain("<video");
    expect(html).not.toContain('data-testid="watch-stage-live"');
    // The way in stays.
    expect(html).toContain('data-testid="watch-stage-join"');
  });
});

describe("watchAudienceCount", () => {
  const stream = {
    hlsUrl: "/api/voice/hls-playlist/c1/1?t=tok",
    startedAt: 1,
    presenterPeerId: "host",
  };
  const seat = (peerId: string, sharingScreen = false) => ({
    peerId,
    sharingScreen,
  });

  it("is the room minus the presenter plus the seatless watchers", () => {
    expect(
      watchAudienceCount(
        { stream, watching: 3 },
        [seat("host", true), seat("a"), seat("b")],
      ),
    ).toBe(5);
  });

  it("is zero with nothing known or nothing live", () => {
    expect(watchAudienceCount(undefined, [seat("a")])).toBe(0);
    expect(watchAudienceCount({ stream: null, watching: 9 }, [seat("a")])).toBe(0);
  });
});
