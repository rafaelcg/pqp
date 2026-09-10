import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    voiceEnabled: false,
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

  it("tells somebody without the permission what it is called, instead of nothing", () => {
    const html = render({ party: null, hasStream: false, canStart: false });
    expect(html).toContain("watch-party-no-permission");
    expect(html).toContain("Start watch party");
    expect(html).not.toContain("data-watch-party-create");
  });

  it("stays out of the way in a call and under a picture", () => {
    expect(
      render({ party: null, hasStream: false, canStart: false, inCall: true }),
    ).not.toContain("watch-party-no-permission");
    expect(
      render({ party: null, hasStream: true, canStart: false }),
    ).not.toContain("watch-party-no-permission");
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

describe("renaming from the live identity row", () => {
  const chrome = (role: WatchParty["viewerRole"]) =>
    render({
      slot: "chrome",
      hasStream: true,
      inCall: true,
      party: { ...PARTY, viewerRole: role },
    });

  it("lets the host, a co-host and a manager tap the name", () => {
    for (const role of ["host", "cohost", "manager"] as const) {
      const html = chrome(role);
      expect([role, html.includes("data-watch-party-rename=")]).toEqual([
        role,
        true,
      ]);
      expect(html, role).toContain("Cinemoon");
    }
  });

  it("leaves a viewer with the name as a label, no pencil", () => {
    const html = chrome("viewer");
    expect(html).toContain("data-watch-party-name-label");
    expect(html).toContain("Cinemoon");
    expect(html).not.toContain("data-watch-party-rename=");
  });
});

describe("a host can tell they are not live", () => {
  const draft: Partial<Parameters<typeof WatchPartyPanel>[0]> = {
    party: { ...PARTY, state: "draft", viewerRole: "host" },
  };

  // Node has a `navigator` with no `mediaDevices`, which is exactly what an
  // iPhone looks like to `supportsScreenShare`. These tests are about a
  // computer, so give it the API; the phone case has its own test below.
  beforeEach(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getDisplayMedia: () => Promise.reject(new Error("test")) },
      configurable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: undefined,
      configurable: true,
    });
  });

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
    expect(html).toContain("Only you can see this");
    // One warning: the pill that used to sit on the preview is gone.
    expect(html).not.toContain("watch-party-preview-state");
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

describe("a host on a phone", () => {
  const draft: Partial<Parameters<typeof WatchPartyPanel>[0]> = {
    party: { ...PARTY, state: "draft", viewerRole: "host" },
  };

  it("is told to open a computer, and is not offered a picker or Go live", () => {
    // `getDisplayMedia` does not exist on iOS Safari at all. A button that
    // opens nothing and a Go live that can never enable are worse than a
    // sentence; the name, the options, the link and Discard still work.
    const html = render(draft);
    expect(html).toContain("watch-party-phone-host");
    expect(html).not.toContain("Pick what to share");
    expect(html).not.toContain("data-watch-party-go-live");
    expect(html).toContain("data-watch-party-discard");
    expect(html).toContain("data-watch-party-share");
    expect(html).toContain("data-watch-party-options-toggle");
  });
});

/**
 * WHO IS OFFERED A SEAT, which is a different question from who may speak.
 *
 * A watch party has no voice by default, and the audience is seatless by
 * construction: watching is a socket, a seat is a LiveKit participant with
 * forwarded streams. The rule is `mayTakeWatchPartySeat` in `@pqp/shared`,
 * asked here and again by `join-voice-room` on the server, so a control drawn
 * here is one the server will honour and a control withheld is a join it
 * would turn away.
 *
 * The case a blanket removal got wrong is the last one: a host who
 * deliberately turns Voz on and is then offered nobody a way in has a setting
 * that does nothing.
 */
describe("the way into the room", () => {
  const joinControl = "data-watch-party-join-call";
  /* The bar lives in the `chrome` slot: `surface` draws the stage. */
  const inBar = (over: Partial<Parameters<typeof WatchPartyPanel>[0]> = {}) =>
    render({ slot: "chrome", ...over });

  it("offers a viewer nothing while the party has no voice", () => {
    expect(inBar()).not.toContain(joinControl);
  });

  it("offers it to the people running the show only once the party has voice", () => {
    // A WATCH PARTY IS NOT A LOBBY. With voice off the host is seated by
    // going live or sharing, and a co-host by Assumir; a seat button for
    // them here would make the room read as a call. With voice on, the floor
    // is a thing and the door stays.
    for (const viewerRole of ["host", "cohost"] as const) {
      expect(inBar({ party: { ...PARTY, viewerRole } })).not.toContain(joinControl);
      expect(
        inBar({
          party: {
            ...PARTY,
            viewerRole,
            options: { ...PARTY.options, voiceEnabled: true },
          },
        }),
      ).toContain(joinControl);
    }
  });

  it("offers it to anybody who may start a party in this channel", () => {
    // They run parties here and the server lets them in for the same reason,
    // so withholding the control would draw a room they can reach and no way
    // to reach it.
    expect(inBar({ canStart: true })).toContain(joinControl);
  });

  it("offers it to somebody the host invited up to speak", () => {
    const me = "55555555-5555-4555-8555-555555555555";
    expect(
      inBar({
        currentUserId: me,
        party: {
          ...PARTY,
          stage: {
            ...PARTY.stage,
            invited: [{ userId: me, displayName: "Bob", avatarUrl: null }],
          },
        },
      }),
    ).toContain(joinControl);
  });

  it("offers it to everybody once the host turns voice on", () => {
    // The film night. Six friends watching something together genuinely want
    // to talk over it, and one click on Voz is what that costs them.
    expect(
      inBar({
        party: { ...PARTY, options: { ...PARTY.options, voiceEnabled: true } },
      }),
    ).toContain(joinControl);
  });
});

/**
 * THE ECHO REGRESSION. Setup used to call
 * `getDisplayMedia({ video: true, audio: true })` directly, which on Windows
 * Electron becomes WASAPI loopback of the call and puts every voice back into
 * the room. Ordinary shares already go through `screenCaptureOptions`; this
 * scan fails the moment setup bypasses that builder again. Crude, and exactly
 * the check a reviewer did by hand when the bypass was found.
 */
describe("watch party setup capture cannot re-broadcast the call", () => {
  it("routes the setup picker through screenCaptureOptions", () => {
    const source = readFileSync(
      new URL("./watch-party-panel.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("screenCaptureOptions(");
    expect(source).toContain("preferBrowserTab: true");
    // The bare shape that caused the echo. A video-only fallback elsewhere is
    // fine; `{ audio: true }` next to getDisplayMedia is not.
    expect(source).not.toMatch(
      /getDisplayMedia\(\s*\{\s*video:\s*true,\s*audio:\s*true/,
    );
  });

  it("hands go-live a stream without claiming system-audio opt-in", () => {
    const source = readFileSync(
      new URL("../../App.tsx", import.meta.url),
      "utf8",
    );
    const goLive = source.slice(
      source.indexOf("async function handleWatchPartyGoLive"),
      source.indexOf("async function handleWatchPartyEnd"),
    );
    expect(goLive).toContain(
      "startScreenShareGated(false, { preferBrowserTab: true, stream })",
    );
    expect(goLive).toContain("startMuted: true");
    expect(goLive).not.toContain("getAudioTracks().length > 0");

  });
});

/**
 * THE GATHERING SCREEN. A scheduled party is a place to arrive at before there
 * is a picture: a countdown, a bell, the link, and for the host the way to
 * start early. A member gets everything but the button.
 */
describe("a scheduled party gathers people", () => {
  const scheduled = (viewerRole: WatchParty["viewerRole"]) => ({
    party: {
      ...PARTY,
      state: "scheduled" as const,
      viewerRole,
      startsAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    },
    onToggleReminder: async () => {},
  });

  it("offers a viewer the bell and the link, and no way to start it", () => {
    const html = render(scheduled("viewer"));
    expect(html).toContain("watch-party-scheduled-when");
    expect(html).toContain("data-watch-party-remind");
    expect(html).toContain("data-watch-party-share");
    expect(html).not.toContain("data-watch-party-go-live");
  });

  it("offers the host the same, plus Go live now", () => {
    const html = render(scheduled("host"));
    expect(html).toContain("data-watch-party-remind");
    expect(html).toContain("data-watch-party-go-live");
  });

  it("reads the bell from the party", () => {
    const on = render({
      ...scheduled("viewer"),
      party: { ...scheduled("viewer").party, reminding: true },
    });
    expect(on).toContain('aria-pressed="true"');
  });
});

/**
 * THE MIC PILL IS THE MUTE BUTTON. The thing that says whether you are heard
 * is the thing you press to stop being heard; a label three panes away from
 * the control it describes is how a host asked "is my mic on?" in the first
 * place.
 */
describe("the mic pill on the live bar", () => {
  const live = (micState: "off" | "muted" | "room" | "everyone") =>
    render({
      slot: "chrome",
      party: { ...PARTY, state: "live", viewerRole: "host" },
      micState,
      onToggleMute: () => {},
    });

  it("is a button while seated, and says everyone hears you when they do", () => {
    const html = live("everyone");
    expect(html).toMatch(/<button[^>]*data-watch-party-mic="everyone"/);
    expect(html).toContain("Everyone can hear you");
  });

  it("is only a label when not in the call", () => {
    const html = live("off");
    expect(html).toMatch(/<span[^>]*data-watch-party-mic="off"/);
    expect(html).not.toMatch(/<button[^>]*data-watch-party-mic/);
  });
});

/** The share lives on the bar, in the party's words, for the people running it. */
describe("the share controls on the live bar", () => {
  const live = (isPresenting: boolean, viewerRole: WatchParty["viewerRole"] = "host") =>
    render({
      slot: "chrome",
      party: { ...PARTY, state: "live", viewerRole },
      isPresenting,
      onShareScreen: async () => {},
      onStopShare: async () => {},
      onReplaceShare: async () => {},
    });

  it("offers Compartilhar tela while nothing of theirs is going out", () => {
    const html = live(false);
    expect(html).toContain("data-watch-party-bar-share");
    expect(html).not.toContain("data-watch-party-bar-stop-share");
  });

  it("offers Trocar and Parar while they present", () => {
    const html = live(true);
    expect(html).toContain("data-watch-party-bar-replace-share");
    expect(html).toContain("data-watch-party-bar-stop-share");
    expect(html).not.toContain("data-watch-party-bar-share");
  });

  it("offers none of it to a viewer", () => {
    const html = live(false, "viewer");
    expect(html).not.toContain("data-watch-party-bar-share");
  });
});

/** The seat's exit is on the bar, for the seated guest, never for the host. */
describe("Sair do palco", () => {
  const seated = (viewerRole: WatchParty["viewerRole"]) =>
    render({
      slot: "chrome",
      party: { ...PARTY, state: "live", viewerRole },
      inCall: true,
      onLeaveSeat: () => {},
    });
  it("is offered to a seated guest and not to the host", () => {
    expect(seated("viewer")).toContain("data-watch-party-leave-stage");
    expect(seated("host")).not.toContain("data-watch-party-leave-stage");
  });
});
