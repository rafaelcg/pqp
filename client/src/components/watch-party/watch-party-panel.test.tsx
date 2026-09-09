import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WatchParty } from "@pqp/shared";
import { WatchPartyPanel } from "./watch-party-panel";

/**
 * The copy a live party shows when there is no picture yet.
 *
 * TWO STATES SHARED ONE SENTENCE and they should not have. A host who presses
 * Ir ao vivo and then cancels the picker, or whose share fails, leaves a room
 * looking at "nothing on screen"; so does a host who IS sharing while the
 * transcode spins up. The first needs the host to act and must not promise
 * the room anything; the second is genuinely seconds away. The first is the
 * one that happens in production, which is why it gets the plain sentence and
 * the second gets the reassurance.
 */

const PARTY: WatchParty = {
  id: "11111111-1111-4111-8111-111111111111",
  channelId: "22222222-2222-4222-8222-222222222222",
  serverId: "33333333-3333-4333-8333-333333333333",
  name: "Cinemoon",
  description: null,
  state: "live",
  startsAt: null,
  wentLiveAt: "2026-09-08T12:00:00.000Z",
  endedAt: null,
  hostUserId: "44444444-4444-4444-8444-444444444444",
  hostDisplayName: "Alice",
  hostAvatarUrl: null,
  hostDisconnectedAt: null,
  cohosts: [],
  options: {
    stageMode: "hosts_only",
    raiseHand: true,
    slowModeSeconds: 0,
    reactionsEnabled: true,
  },
  viewerRole: "viewer",
  reminding: false,
  stage: { invited: [], hands: [], handRaised: false },
};

function render(over: Partial<Parameters<typeof WatchPartyPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <WatchPartyPanel
      party={PARTY}
      channelId={PARTY.channelId}
      channelName="cinemoon"
      canStart={false}
      inCall={false}
      hasStream={false}
      isPresenting={false}
      audienceCount={0}
      onCreate={() => {}}
      onGoLive={async () => {}}
      onEnd={async () => {}}
      onDiscard={async () => {}}
      onOptionsChange={async () => {}}
      onRename={async () => {}}
      onClaimHost={async () => {}}
      onJoinCall={() => {}}
      slot="surface"
      {...over}
    />,
  );
}

describe("a live party with nothing on screen", () => {
  it("tells a viewer plainly, with no promise nothing is keeping", () => {
    const html = render({ someoneIsSharing: false });
    expect(html).toContain('data-watch-party-waiting="idle"');
    expect(html).toContain("has not put anything on screen yet");
    // The old copy promised the room the picture was coming ("fica aí que já
    // aparece") even when nobody was sharing and nothing was on its way.
    expect(html).not.toContain("few seconds");
  });

  it("tells the host what to do about it", () => {
    const html = render({
      someoneIsSharing: false,
      canStart: true,
      party: { ...PARTY, viewerRole: "host" },
    });
    expect(html).toContain("Share a window or a tab");
  });

  it("reassures instead, once somebody is actually sharing", () => {
    const html = render({ someoneIsSharing: true });
    expect(html).toContain('data-watch-party-waiting="preparing"');
    expect(html).toContain("takes a few seconds to reach you");
    expect(html).not.toContain("has not put anything on screen yet");
  });

  it("says nothing at all when the picture is up", () => {
    const html = render({ hasStream: true });
    expect(html).not.toContain("watch-party-waiting");
  });
});

describe("the surface never contradicts itself", () => {
  it("does not offer to create a party while the channel is live", () => {
    // The bug Rafael photographed: the empty state and the live stage mounted
    // together, because one asked about the party row and the other about the
    // stream. `watchPartySurface` is now the single answer.
    const html = render({ party: null, hasStream: true, canStart: true });
    expect(html).not.toContain("watch-party-empty");
  });

  it("offers to create one only when nothing is live", () => {
    const html = render({ party: null, hasStream: false, canStart: true });
    expect(html).toContain("watch-party-empty");
  });
});

describe("the host's transmission readout", () => {
  const STREAM = {
    hlsUrl: "/api/voice/hls-playlist/x/1",
    startedAt: 1_757_000_000_000,
    presenterPeerId: "p1",
    delaySeconds: 8,
    topHeight: 720,
  };

  it("is not shown to a viewer, whose business it is not", () => {
    const html = render({
      slot: "chrome",
      hasStream: true,
      inCall: true,
      liveStream: STREAM,
    });
    expect(html).not.toContain("watch-party-transmission");
  });

  it("is shown to the host and to a co-host", () => {
    for (const role of ["host", "cohost"] as const) {
      const html = render({
        slot: "chrome",
        hasStream: true,
        inCall: true,
        liveStream: STREAM,
        party: { ...PARTY, viewerRole: role },
      });
      expect([role, html.includes("watch-party-transmission")]).toEqual([
        role,
        true,
      ]);
    }
  });

  it("is not shown to a manager, who is not transmitting anything", () => {
    const html = render({
      slot: "chrome",
      hasStream: true,
      inCall: true,
      liveStream: STREAM,
      party: { ...PARTY, viewerRole: "manager" },
    });
    expect(html).not.toContain("watch-party-transmission");
  });

  it("starts collapsed, and the one line is what the room is getting", () => {
    const html = render({
      slot: "chrome",
      hasStream: true,
      inCall: true,
      liveStream: STREAM,
      audienceCount: 12,
      party: { ...PARTY, viewerRole: "host" },
    });
    expect(html).toContain("720p to 12 watching");
    // Collapsed means the detail list is not rendered at all, not merely
    // hidden: assert on the labels only the expanded panel draws, or the test
    // passes with the panel open.
    expect(html).not.toContain("You are sending");
    expect(html).not.toContain("On air");
    expect(html).toContain('aria-expanded="false"');
  });

  it("says it is preparing while the ladder has not reported a rung", () => {
    const html = render({
      slot: "chrome",
      hasStream: true,
      inCall: true,
      isPresenting: true,
      liveStream: { ...STREAM, topHeight: undefined },
      party: { ...PARTY, viewerRole: "host" },
    });
    expect(html).toContain("Preparing the broadcast");
  });
});


describe("the chrome survives a collapsed video", () => {
  it("draws the host's controls in the chrome slot, not the surface one", () => {
    // The bug this pins: the bar carrying Encerrar used to live inside the
    // stage pane, so hiding the video took the only way to end the party with
    // it. The chrome is rendered above the split and cannot be collapsed.
    const chrome = render({
      slot: "chrome",
      hasStream: true,
      inCall: true,
      party: { ...PARTY, viewerRole: "host" },
    });
    expect(chrome).toContain("watch-party-bar");
    expect(chrome).toContain("watch-party-end");

    const surface = render({
      slot: "surface",
      hasStream: true,
      inCall: true,
      party: { ...PARTY, viewerRole: "host" },
    });
    expect(surface).not.toContain("watch-party-bar");
  });

  it("still fills the pane from the surface slot when nothing is on screen", () => {
    const surface = render({ slot: "surface", hasStream: false });
    expect(surface).toContain("watch-party-waiting");
  });
});

describe("the pane owns the surface's height", () => {
  /**
   * WHAT BROKE. Every pane-filling surface here sized itself `h-[68svh]`, a
   * fraction of the WINDOW, and `shrink-0`. The split pane sizes itself from
   * its own measurement and, when the chat is put away, hands the stage slot
   * the whole pane. The two numbers disagreed, and the pane's is the one that
   * is true: at 1440x900 the pane gave the slot 803px while the setup surface
   * insisted on 612, leaving the go-live bar stranded in mid-screen over a
   * 191px band of empty pane. `WatchChannelStage` and `CallStage` both take a
   * `fill` prop for exactly this; this component never got one.
   *
   * These assert the class rather than a rendered height because
   * `renderToStaticMarkup` lays nothing out. The geometry is asserted for
   * real, in a browser, in `client/e2e/watch-party.spec.ts` ("the setup
   * surface fills the pane when the chat is put away"), including the reload
   * path, where the collapse is restored from storage before anything has
   * measured itself.
   */
  const filling: [string, Partial<Parameters<typeof WatchPartyPanel>[0]>][] = [
    ["setup", { party: { ...PARTY, state: "draft", viewerRole: "host" } }],
    [
      "scheduled",
      { party: { ...PARTY, state: "scheduled", viewerRole: "host" } },
    ],
    ["waiting", { hasStream: false }],
    ["empty", { party: null, canStart: true }],
  ];

  for (const [name, over] of filling) {
    it(`${name} takes the pane's height when the pane owns it`, () => {
      const owned = render({ ...over, fill: true });
      expect(owned, name).toContain("h-full min-h-0 flex-1");
      // The window fraction is what the pane is REPLACING, so it has to be
      // gone rather than merely overridden by a later class.
      expect(owned, name).not.toContain("68svh");
    });

    it(`${name} keeps its own rule when nobody has taken the pane`, () => {
      // Nothing about a first render changes on the day this ships: with two
      // panes drawn the stage still sizes itself and the transcript keeps the
      // rest, exactly as before.
      const own = render({ ...over, fill: false });
      expect(own, name).toContain("shrink-0");
      expect(own, name).not.toContain("h-full min-h-0 flex-1");
    });
  }
});

describe("a host can tell they are not live", () => {
  const draft: Partial<Parameters<typeof WatchPartyPanel>[0]> = {
    party: { ...PARTY, state: "draft", viewerRole: "host" },
  };

  it("says it in a sentence, not in a 10px watermark", () => {
    /**
     * On 12 Sep 2026 a host on production announced "im live" to a room while
     * the server reported `sharingScreen: 0` and no transcode running. He had
     * picked a window and was looking at his own preview. The only thing
     * saying otherwise was a 10px uppercase grey badge in the corner of that
     * preview, which is the visual language of a watermark.
     */
    const html = render(draft);
    expect(html).toContain("watch-party-not-live");
    expect(html).toContain("Not live yet");
    // And the badge on the preview is a status light now, not a caption.
    expect(html).toContain("watch-party-preview-state");
  });

  it("keeps Go live in the row pinned to the bottom of the surface", () => {
    // The other half of the same report: the host's screenshot only showed Ir
    // ao vivo after scrolling, under a co-host list long enough to push it
    // away. The bar is `shrink-0` under a `min-h-0 flex-1` row, so the
    // settings column scrolls and this never moves.
    const html = render(draft);
    const bar = html.slice(html.indexOf("watch-party-not-live"));
    expect(bar).toContain("data-watch-party-go-live");
    expect(bar).toContain("data-watch-party-discard");
  });
});
