// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WatchParty } from "@pqp/shared";
import { WatchPartyPanel } from "./watch-party-panel";

/**
 * THE RACE FAROL FOUND ON PR #617, THIRD ROUND. `handleWatchPartyGoLive` in
 * `App.tsx` used to re-read `currentWatchParty()?.options.lowLatency` right
 * before sending the go-live request -- a read of whichever party the
 * SIDEBAR currently has selected, not necessarily the party the button that
 * was clicked belongs to. The fix moved the read down to where the value is
 * actually unambiguous: `watch-party-panel.tsx` passes its own `party` prop's
 * `options.lowLatency` straight into `onGoLive` as a parameter, so the value
 * that reaches the server is tied to the party instance this specific click
 * came from, never to whatever else is on screen or selected at the same
 * moment.
 *
 * This mounts TWO independent `WatchPartyPanel` instances for two different
 * parties at once -- the shape "a selection change mid-flight" actually
 * takes: two parties' state genuinely coexisting in the app -- and proves
 * clicking one's "Ir ao vivo" never reads the other's `lowLatency`.
 *
 * `watch-party-panel.test.tsx`'s own `renderToStaticMarkup` suite cannot
 * reach this: it needs a real DOM click, same reasoning as
 * `watch-party-panel-live-quality.test.tsx`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function scheduledParty(over: Partial<WatchParty>): WatchParty {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    channelId: "22222222-2222-4222-8222-222222222222",
    serverId: "33333333-3333-4333-8333-333333333333",
    name: "Cinemoon",
    description: null,
    state: "scheduled",
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    wentLiveAt: null,
    endedAt: null,
    hostUserId: "44444444-4444-4444-8444-444444444444",
    hostDisplayName: "Alice",
    hostAvatarUrl: null,
    hostDisconnectedAt: null,
    cohosts: [],
    options: {
      voiceEnabled: false,
      guests: "off",
      stageMode: "hosts_only",
      raiseHand: true,
      slowModeSeconds: 0,
      reactionsEnabled: true,
      lowLatency: false,
    },
    viewerRole: "host",
    reminding: false,
    stage: { invited: [], hands: [], handRaised: false },
    guests: {
      onAir: [],
      invited: [],
      requests: [],
      requestCount: 0,
      requested: false,
      position: null,
    },
    ...over,
  };
}

let roots: Root[] = [];
let hosts: HTMLElement[] = [];

afterEach(() => {
  for (const root of roots) {
    act(() => root.unmount());
  }
  for (const host of hosts) {
    host.remove();
  }
  roots = [];
  hosts = [];
});

function mountScheduledPanel(party: WatchParty, onGoLive: (...args: unknown[]) => Promise<void>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  hosts.push(host);
  roots.push(root);
  act(() => {
    root.render(
      <WatchPartyPanel
        party={party}
        channelId={party.channelId}
        channelName="cinemoon"
        canStart
        inCall={false}
        hasStream={false}
        isPresenting={false}
        audienceCount={0}
        onCreate={() => {}}
        onGoLive={onGoLive}
        onEnd={async () => {}}
        onDiscard={async () => {}}
        onOptionsChange={async () => {}}
        onRename={async () => {}}
        onClaimHost={async () => {}}
        onJoinCall={() => {}}
        slot="surface"
      />,
    );
  });
  return host;
}

describe("go-live never mixes lowLatency between two parties on screen at once", () => {
  it("sends party A's own lowLatency, unaffected by party B rendered alongside it", () => {
    const partyA = scheduledParty({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      channelId: "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa",
      options: {
        voiceEnabled: false,
        guests: "off",
        stageMode: "hosts_only",
        raiseHand: true,
        slowModeSeconds: 0,
        reactionsEnabled: true,
        lowLatency: true,
      },
    });
    const partyB = scheduledParty({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      channelId: "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb",
      options: {
        voiceEnabled: false,
        guests: "off",
        stageMode: "hosts_only",
        raiseHand: true,
        slowModeSeconds: 0,
        reactionsEnabled: true,
        lowLatency: false,
      },
    });

    const onGoLiveA = vi.fn().mockResolvedValue(undefined);
    const onGoLiveB = vi.fn().mockResolvedValue(undefined);

    // Both parties' panels exist in the app at the same time -- the actual
    // shape of "a different party could be current elsewhere."
    const hostA = mountScheduledPanel(partyA, onGoLiveA);
    mountScheduledPanel(partyB, onGoLiveB);

    const buttonA = hostA.querySelector(
      "[data-watch-party-go-live]",
    ) as HTMLButtonElement | null;
    expect(buttonA).not.toBeNull();

    act(() => {
      buttonA?.click();
    });

    expect(onGoLiveA).toHaveBeenCalledTimes(1);
    // Party A's own value (true), never B's (false).
    expect(onGoLiveA).toHaveBeenCalledWith(null, true);
    expect(onGoLiveB).not.toHaveBeenCalled();
  });

  it("sends false for a party whose own preference is false, with a true-preference party mounted beside it", () => {
    const partyTrue = scheduledParty({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      options: {
        voiceEnabled: false,
        guests: "off",
        stageMode: "hosts_only",
        raiseHand: true,
        slowModeSeconds: 0,
        reactionsEnabled: true,
        lowLatency: true,
      },
    });
    const partyFalse = scheduledParty({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      channelId: "dddddddd-3333-4ddd-8ddd-dddddddddddd",
      options: {
        voiceEnabled: false,
        guests: "off",
        stageMode: "hosts_only",
        raiseHand: true,
        slowModeSeconds: 0,
        reactionsEnabled: true,
        lowLatency: false,
      },
    });

    const onGoLiveTrue = vi.fn().mockResolvedValue(undefined);
    const onGoLiveFalse = vi.fn().mockResolvedValue(undefined);

    mountScheduledPanel(partyTrue, onGoLiveTrue);
    const hostFalse = mountScheduledPanel(partyFalse, onGoLiveFalse);

    const buttonFalse = hostFalse.querySelector(
      "[data-watch-party-go-live]",
    ) as HTMLButtonElement | null;
    expect(buttonFalse).not.toBeNull();

    act(() => {
      buttonFalse?.click();
    });

    expect(onGoLiveFalse).toHaveBeenCalledTimes(1);
    expect(onGoLiveFalse).toHaveBeenCalledWith(null, false);
    expect(onGoLiveTrue).not.toHaveBeenCalled();
  });
});
