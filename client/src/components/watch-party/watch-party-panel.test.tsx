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
