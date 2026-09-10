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

describe("WatchStage draws only the controls it was given", () => {
  const hlsUrl = "https://api.example.test/api/voice/hls-playlist/c1/1?t=tok";

  const render = (props: Partial<Parameters<typeof WatchStage>[0]> = {}) =>
    renderToStaticMarkup(
      <WatchStage hlsUrl={hlsUrl} audienceCount={3} ended={false} {...props} />,
    );

  it("offers no join at all when somebody else already offers it", () => {
    /**
     * THE ARITHMETIC THIS EXISTS FOR. With a picture playing, a viewer was
     * offered the call three times on one screen: the channel header, the
     * party bar and this. Three components that did not know about each
     * other, two of them in the app's primary fill. Watching costs a socket;
     * a seat costs a LiveKit participant and forwarded streams, against a
     * measured envelope of about 600 interactive users versus an effectively
     * unbounded HLS audience. So `onJoin` is optional and a watch party room
     * passes nothing, because the party bar owns it there.
     */
    expect(render()).not.toContain('data-testid="watch-stage-join"');
    // A plain voice channel with a share going out has no party bar, and
    // there this is still the only way in.
    expect(render({ onJoin: () => {} })).toContain(
      'data-testid="watch-stage-join"',
    );
  });

  it("keeps the join quiet when it does draw one", () => {
    // `bg-success` made joining a call the loudest thing on a screen whose
    // entire point is that you do not have to.
    const html = render({ onJoin: () => {} });
    expect(html).not.toContain("bg-success");
  });

  it("says nothing about what the person is NOT doing", () => {
    /**
     * The row was headed "Watching without joining the call". Rafael: "how's
     * that even a thing in watch party lol". It described the implementation,
     * a voice room with an HLS audience attached, and framed the thing
     * everybody came for as an abstention. A playing film is evidence enough;
     * what is left is the count and the delay, neither of which is derivable
     * from looking.
     */
    const html = render({ delaySeconds: 8, onJoin: () => {} });
    expect(html).not.toContain("without joining");
    expect(html).toContain("3 people watching");
    expect(html).toContain("~8s delay");
  });

  it("offers a way to stop only when the caller knows where to go", () => {
    // Stopping means leaving the room, and only the caller can pick the
    // channel to land on. A button that goes nowhere is worse than none.
    expect(render()).not.toContain('data-testid="watch-stage-leave"');
    expect(render({ onLeaveParty: () => {} })).toContain(
      'data-testid="watch-stage-leave"',
    );
  });

  it("offers fullscreen only where a pane can take the screen", () => {
    expect(render()).not.toContain('data-testid="watch-stage-fullscreen"');
    const html = render({ fullscreen: { active: false, toggle: () => {} } });
    expect(html).toContain('data-testid="watch-stage-fullscreen"');
    expect(html).toContain('aria-pressed="false"');
  });

  it("offers a chat overlay only while the film is fullscreen", () => {
    expect(
      render({ fullscreen: { active: false, toggle: () => {} } }),
    ).not.toContain('data-testid="watch-stage-chat-overlay"');
    const html = render({
      fullscreen: {
        active: true,
        toggle: () => {},
        chatOverlay: false,
        toggleChatOverlay: () => {},
      },
    });
    expect(html).toContain('data-testid="watch-stage-chat-overlay"');
    expect(html).toContain('aria-pressed="false"');
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
