// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { VoiceState } from "@/hooks/use-voice";
import { WatchStage, WatchChannelStage, watchAudienceCount } from "./watch-stage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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
     * what is left is the count, which is not derivable from looking. The
     * delay figure that used to sit beside it is gone entirely (2026-09-13):
     * it was a constant read off the wire config rather than the stream's
     * actual distance from live, which read as broken more often than it
     * read as informative.
     */
    const html = render({ delaySeconds: 8, onJoin: () => {} });
    expect(html).not.toContain("without joining");
    expect(html).toContain("3 people watching");
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

  it("stacks cinema chrome above the chat overlay", () => {
    // Overlay is z-index 40 on the pane. Chrome at z-20 was covered, and
    // Playwright waited 120s to click Leave fullscreen.
    const html = render({
      fullscreen: {
        active: true,
        toggle: () => {},
        chatOverlay: true,
        toggleChatOverlay: () => {},
      },
    });
    expect(html).toContain("data-watch-chrome");
    expect(html).toMatch(/data-watch-chrome=""[^>]*\bz-50\b/);
    expect(html).toContain('data-testid="watch-stage-fullscreen"');
  });
});

/**
 * THE STAGE NEVER OFFERS A CALL ON A WATCH PARTY, IN ANY OF ITS THREE
 * STATES (2026-09-13, Rafael's "the audience never joins a call" decision).
 * `WatchStage.onJoin` is a plain optional prop — the component itself has no
 * idea whether the channel is a watch party or whether Voz is on, which is
 * exactly what `WatchStage draws only the controls it was given` above
 * already pins for the prop's absence. What that leaves to check is the one
 * caller that decides the prop at all: `App.tsx`'s mount of
 * `WatchChannelStage` must pass no `onJoin` for a watch party channel
 * unconditionally, not "unless voice is on" — voice off, voice on, and the
 * host's own view all go through the same `isWatchParty ? undefined : ...`,
 * because the party bar owns the one way in, in every state.
 */
describe("a watch party channel gets no onJoin from App, in any state", () => {
  it("is unconditional on the party's own options, not just on the flag", () => {
    // `import.meta.url` is not a `file://` URL under the jsdom environment
    // this file otherwise needs (for `createRoot`), so resolve from the
    // process's own cwd (the `client/` package root vitest runs from)
    // rather than the `new URL(..., import.meta.url)` pattern this repo's
    // node-environment source-scanning tests use.
    const source = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
    const mount = source.slice(
      source.indexOf("<WatchChannelStage"),
      source.indexOf("onLeaveParty={"),
    );
    expect(mount).toMatch(/watchDock\.session\.isWatchParty\s*\?\s*undefined/);
    // Not gated on anything about voice or role: the ternary's condition is
    // the flag alone.
    expect(mount).not.toMatch(/isWatchParty\s*&&\s*voiceEnabled/);
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

/**
 * The mini player.
 *
 * Same component and the same `HlsWatchPlayer` inside it, one prop apart, so
 * the dock never costs a remount. What changes is the chrome: a 240px box has
 * room for the way back, the way out and mute, and for none of the stage's
 * badges, quality menu or join.
 */
describe("WatchStage docked", () => {
  const hlsUrl = "https://api.example.test/api/voice/hls-playlist/c1/1?t=tok";

  const render = (props: Partial<Parameters<typeof WatchStage>[0]> = {}) =>
    renderToStaticMarkup(
      <WatchStage
        hlsUrl={hlsUrl}
        audienceCount={4}
        ended={false}
        onJoin={() => {}}
        onLeaveParty={() => {}}
        {...props}
      />,
    );

  it("offers return, close, mute and the picture itself", () => {
    const html = render({ docked: true, onReturn: () => {}, onDismiss: () => {} });
    expect(html).toContain('data-testid="watch-mini-return"');
    expect(html).toContain('data-testid="watch-mini-close"');
    expect(html).toContain('data-testid="hls-mini-mute"');
    expect(html).toContain('data-testid="watch-mini-picture"');
    expect(html).toContain("<video");
  });

  it("drops the stage chrome a corner box cannot carry", () => {
    const html = render({ docked: true, onReturn: () => {}, onDismiss: () => {} });
    // The expensive offer, the badges and fullscreen all stay on the stage.
    expect(html).not.toContain('data-testid="watch-stage-join"');
    expect(html).not.toContain('data-testid="watch-stage-leave"');
    expect(html).not.toContain('data-testid="watch-stage-live"');
    expect(html).not.toContain('data-testid="watch-stage-fullscreen"');
    expect(html).not.toContain('data-testid="hls-volume"');
  });

  it("shows none of it on the ordinary stage", () => {
    const html = render({
      fullscreen: { active: false, toggle: () => {} },
    });
    expect(html).not.toContain('data-testid="watch-mini-return"');
    expect(html).not.toContain('data-testid="watch-mini-close"');
    expect(html).not.toContain('data-testid="hls-mini-chrome"');
    expect(html).not.toContain('data-testid="watch-mini-picture"');
    // And the stage keeps everything it had.
    expect(html).toContain('data-testid="watch-stage-join"');
    expect(html).toContain('data-testid="watch-stage-live"');
  });
});

/**
 * The double surface Rafael saw in production: a viewer whose watch party
 * stream ended got the idle "Nenhuma watch party rolando aqui" setup surface
 * AND this component's own "A transmissão acabou" card stacked in the same
 * pane, pushing chat and the composer off screen. `WatchPartyPanel`'s surface
 * slot already answers "nothing is on air" for a watch party channel the
 * instant the stream drops (`watchPartySurface`, tested in
 * `watch-party-session.test.ts`), so this mount must stay out of the way on
 * a watch party channel and leave the ended card to a plain voice room's bare
 * share, which has nothing else covering that pane.
 */
describe("WatchChannelStage ended", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function voiceStateWithStream(hasStream: boolean): VoiceState {
    return {
      voiceChannelId: null,
      status: "idle",
      channelLive: {
        c1: {
          stream: hasStream
            ? {
                hlsUrl: "https://api.example.test/api/voice/hls-playlist/c1/1?t=tok",
                startedAt: 0,
                presenterPeerId: "peer-1",
              }
            : null,
          watching: 1,
        },
      },
      occupancy: { c1: [] },
    } as unknown as VoiceState;
  }

  function renderStage(isWatchParty: boolean, voiceState: VoiceState) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <WatchChannelStage
          channelId="c1"
          channelName="cinema"
          voiceState={voiceState}
          isWatchParty={isWatchParty}
          onSetWatchingLive={() => {}}
          onSeedChannelLive={() => {}}
        />,
      );
    });
  }

  it("never shows the ended card on a watch party channel, leaving the panel's own surface alone", () => {
    renderStage(true, voiceStateWithStream(true));
    act(() => {
      root.render(
        <WatchChannelStage
          channelId="c1"
          channelName="cinema"
          voiceState={voiceStateWithStream(false)}
          isWatchParty
          onSetWatchingLive={() => {}}
          onSeedChannelLive={() => {}}
        />,
      );
    });
    expect(container.querySelector('[data-testid="watch-stage-ended"]')).toBeNull();
    expect(container.querySelector('[data-testid="watch-channel-stage"]')).toBeNull();
  });

  it("still shows the ended card on a plain voice room's bare share", () => {
    renderStage(false, voiceStateWithStream(true));
    act(() => {
      root.render(
        <WatchChannelStage
          channelId="c1"
          channelName="cinema"
          voiceState={voiceStateWithStream(false)}
          isWatchParty={false}
          onSetWatchingLive={() => {}}
          onSeedChannelLive={() => {}}
        />,
      );
    });
    expect(container.querySelector('[data-testid="watch-stage-ended"]')).not.toBeNull();
  });
});
