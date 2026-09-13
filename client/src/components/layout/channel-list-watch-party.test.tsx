import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Channel, Server, VoiceParticipant, WatchParty } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChannelList } from "./channel-list";

// The flag is read on every render, so one mock serves both halves of the
// suite: flip the return value and the same channel changes shape.
const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/watch-party-channels", () => ({
  isWatchPartyChannelsEnabled: () => flag.on,
}));

const server: Server = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Mesa da Tues",
  ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  createdAt: "2026-07-01T00:00:00.000Z",
  messageRetentionDays: null,
  ssoEmailDomain: null,
  iconUrl: null,
  bannerUrl: null,
  role: "owner",
  isCommunity: false,
  communityHomeEnabled: false,
  showOnProfile: true,
};

const cinema: Channel = {
  id: "55555555-5555-4555-8555-555555555555",
  serverId: server.id,
  kind: "server",
  name: "cinema",
  type: "watch_party",
  position: 0,
  parentId: null,
  isPrivate: false,
  topic: "Sexta é noite de filme",
  imageUrl: null,
  slowmodeSeconds: 0,
  voiceTransport: null,
};

/** An ordinary voice room, so the filter can be shown to be targeted. */
const lobby: Channel = {
  ...cinema,
  id: "66666666-6666-4666-8666-666666666666",
  name: "lobby",
  type: "voice",
  position: 1,
  topic: null,
};

function person(
  peerId: string,
  displayName: string,
  sharingScreen = false,
): VoiceParticipant {
  return {
    peerId,
    userId: `${peerId}-user`,
    displayName,
    avatarUrl: null,
    sharingScreen,
    muted: false,
    deafened: false,
    serverMuted: false,
  };
}

const presenter = person("peer-andre", "Andre", true);
const viewers = [person("peer-rafa", "Rafa"), person("peer-bia", "Bia")];

const liveParty: WatchParty = {
  id: "77777777-7777-4777-8777-777777777777",
  channelId: cinema.id,
  serverId: server.id,
  name: "Sessão da tarde",
  description: null,
  state: "live",
  startsAt: null,
  wentLiveAt: "2026-09-08T12:00:00.000Z",
  endedAt: null,
  hostUserId: "88888888-8888-4888-8888-888888888888",
  hostDisplayName: "Andre",
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
  viewerRole: "host",
  reminding: false,
  stage: { invited: [], hands: [], handRaised: false },
};

const baseProps = {
  server,
  channels: [cinema, lobby],
  selectedChannelId: null,
  canManage: false,
  speakingPeerIds: [],
  activeVoiceChannelId: null,
  unread: {},
  onSelectChannel: () => {},
  onJoinVoice: () => {},
  onCreateChannel: () => {},
  onRenameChannel: () => {},
  onDeleteChannel: () => {},
  onOpenChannelSettings: () => {},
  onMoveChannel: () => {},
  onInvite: () => {},
  onOpenMembers: () => {},
  onOpenServerSettings: () => {},
};

function renderList(node: ReactElement) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>{node}</TooltipProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  flag.on = true;
});

/**
 * A WATCH PARTY IS NOT A CHANNEL IN THE LIST.
 *
 * The first version gave watch parties a section of their own under Voice,
 * and the result was one event with two representations: the block at the top
 * AND a row further down with its own occupant list, which is exactly the
 * voice-channel treatment the block existed to escape. The channel still
 * exists (it is the party's room, its chat and the key the egress hangs on);
 * it is simply never listed.
 */
describe("watch party channels are not listed (flag on)", () => {
  it("keeps the channel out of the list even while it is live", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        voiceOccupancy={{ [cinema.id]: [presenter, ...viewers] }}
      />,
    );
    expect(html).not.toContain('data-channel-type="watch_party"');
    expect(html).not.toContain(">Watch party<");
    expect(html).not.toContain("data-watch-party-live");
    // And its occupants do not nest under a row that is not there.
    expect(html).not.toContain(">Rafa<");
  });

  it("shows no section, no row and no empty state when nothing is running", () => {
    const html = renderList(<ChannelList {...baseProps} />);
    expect(html).not.toContain(">Watch party<");
    expect(html).not.toContain("Sexta é noite de filme");
    expect(html).not.toContain("data-channel-join");
  });

  it("shows nothing at all to somebody who may not start one", () => {
    const html = renderList(
      <ChannelList {...baseProps} onWatchLiveParty={() => {}} />,
    );
    expect(html).not.toContain("live-party-create");
    expect(html).not.toContain("live-party-block");
  });

  it("offers one create control to somebody who may, and it is an action", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        onWatchLiveParty={() => {}}
        canStartWatchParty
        onCreateWatchParty={() => {}}
      />,
    );
    expect(html).toContain("live-party-create");
    expect(html).toContain("New watch party");
    // An action, not a channel type: no section heading came back with it.
    expect(html).not.toContain(">Watch party<");
  });

  it("still leaves ordinary voice channels alone", () => {
    const html = renderList(<ChannelList {...baseProps} />);
    expect(html).toContain('data-channel-type="voice"');
  });
});

describe("watch_party rows never full-join voice", () => {
  it("does not offer a join chip or double-click join when the party is not live", () => {
    flag.on = false;
    const html = renderList(
      <ChannelList {...baseProps} channels={[cinema]} />,
    );
    expect(html).toContain('data-channel-type="watch_party"');
    expect(html).not.toContain("data-channel-join");
    expect(html).not.toContain("Double-click to join");
    expect(html).not.toContain(">Join<");
  });
});

describe("ChannelList watch party row (flag off)", () => {
  it("renders the same channel as a plain voice row, listed as before", () => {
    flag.on = false;
    const html = renderList(
      <ChannelList
        {...baseProps}
        voiceOccupancy={{ [cinema.id]: [presenter, ...viewers] }}
      />,
    );
    expect(html).not.toContain("data-watch-party-live");
    expect(html).not.toContain("data-watch-party-viewers");
    expect(html).not.toContain("data-channel-join");
    expect(html).not.toContain(">Watch party<");
    // Occupants still nest under the listed room; the row itself no
    // longer full-joins voice (see the suite above).
    expect(html).toContain(">Andre<");
    expect(html).toContain(">Rafa<");
    expect(html).toContain('data-channel-type="watch_party"');
  });
});

/**
 * The live party card is not a `ChannelRow`, so it does not inherit
 * `ChannelRow`'s context menu (or its purge gate) for free — the owner
 * right-clicking a live show and getting the browser's own menu was exactly
 * that gap. `onPurgeChannel` narrowed to `Pick<Channel, "id" | "name">` is
 * what lets the card hand back a purge target built from `WatchParty` fields
 * alone, with no `Channel` object on hand.
 */
describe("purge from the live party card and the flag-off row", () => {
  it("renders the live party card for a moderator with a purge target wired up, without throwing", () => {
    const onPurgeChannel = vi.fn();
    const html = renderList(
      <ChannelList
        {...baseProps}
        onWatchLiveParty={() => {}}
        liveParties={[liveParty]}
        canManageMessages
        onPurgeChannel={onPurgeChannel}
      />,
    );
    expect(html).toContain("live-party-block");
    expect(html).toContain(`data-channel-id="${cinema.id}"`);
  });

  it("still renders the live party card for a viewer with no purge permission", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        onWatchLiveParty={() => {}}
        liveParties={[liveParty]}
        canManageMessages={false}
      />,
    );
    expect(html).toContain("live-party-block");
  });

  it("extends the flag-off row's purge gate to a watch_party channel, same as a text channel", () => {
    flag.on = false;
    const onPurgeChannel = vi.fn();
    const html = renderList(
      <ChannelList
        {...baseProps}
        channels={[cinema]}
        canManageMessages
        onPurgeChannel={onPurgeChannel}
      />,
    );
    // No assertion on the (portal-rendered, closed-by-default) menu content —
    // this repo's component tests are static-markup smoke tests and Radix's
    // `Trigger asChild` adds no extra DOM node either way. The behavioural
    // coverage for the purge gate itself lives in the plain function tests
    // in `slash-commands.test.ts`; this guards the wiring does not throw for
    // a watch_party channel the way it already does not for a text one.
    expect(html).toContain('data-channel-type="watch_party"');
  });
});

/**
 * THE SIDEBAR CARD NEVER OFFERS A CALL (2026-09-13, Rafael's "the audience
 * never joins a call" decision, item 1). `LivePartyBlock` reads only the
 * party's name, host and audience count — it has no idea whether Voz is on,
 * whether this viewer runs the show, or who else is seated, and that is the
 * fix: there is nothing here to gate, because a seat count and a seat list
 * were never wired into this card in the first place. These three states
 * pin that it stays that way as the party's own shape changes around it.
 */
describe("the live party card never grows a call affordance", () => {
  const withAudience = (party: WatchParty, count: number) => (
    <ChannelList
      {...baseProps}
      onWatchLiveParty={() => {}}
      liveParties={[party]}
      channelLive={{
        [cinema.id]: {
          stream: {
            hlsUrl: "https://api.example.test/hls",
            startedAt: 0,
            presenterPeerId: presenter.peerId,
          },
          watching: count,
        },
      }}
    />
  );

  it("reads assistindo/watching by count alone while the party has no voice", () => {
    const html = renderList(withAudience(liveParty, 5));
    expect(html).toContain("live-party-block");
    expect(html).toContain("5 watching");
    expect(html).not.toContain("Take the stage");
    expect(html).not.toContain(">Join<");
    expect(html).not.toContain("data-watch-party-join-call");
    expect(html).not.toContain("data-watch-party-raise");
  });

  it("reads the same way once the host turns Voz on", () => {
    // The card does not know voiceEnabled changed, and that is the point: a
    // watch party's card is always "assistindo · N", never a seat count or a
    // seated list, whatever the party's own options say.
    const withVoice: WatchParty = {
      ...liveParty,
      options: { ...liveParty.options, voiceEnabled: true, stageMode: "everyone" },
    };
    const html = renderList(withAudience(withVoice, 5));
    expect(html).toContain("5 watching");
    expect(html).not.toContain("Take the stage");
    expect(html).not.toContain("Pedir");
    expect(html).not.toContain("data-watch-party-join-call");
    expect(html).not.toContain("data-watch-party-raise");
  });

  it("stays the same for the host's own view of it too", () => {
    // viewerRole is a fact about the party the card never reads: the host's
    // controls live in the channel itself (the bar, the options dialog),
    // never in this sidebar card.
    const asHost: WatchParty = { ...liveParty, viewerRole: "host" };
    const html = renderList(withAudience(asHost, 5));
    expect(html).toContain("5 watching");
    expect(html).not.toContain("data-watch-party-end");
    expect(html).not.toContain("data-watch-party-options-toggle");
    expect(html).not.toContain("data-watch-party-join-call");
  });
});

/**
 * "Transmissões anteriores" reachable with no party running.
 *
 * An idle `watch_party` channel has no row in this list (the describe block
 * above this one is the reason why) and therefore no header icon either —
 * that icon lives in the chat pane, which only mounts for a *selected*
 * channel. `watchPartyHistoryChannels` is the sidebar's own way back to a
 * channel's past broadcasts without selecting it, appearing beside whatever
 * `LivePartyBlock` would otherwise draw for the idle state.
 */
describe("watch party history entry point (no party running)", () => {
  const historyChannels = [{ id: cinema.id, name: cinema.name }];

  it("adds nothing when there is no history to show", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        onWatchLiveParty={() => {}}
        canStartWatchParty
        onCreateWatchParty={() => {}}
      />,
    );
    expect(html).not.toContain("live-party-history");
    expect(html).not.toContain("Past broadcasts");
  });

  it("adds nothing when the viewer has no permission, even with history elsewhere", () => {
    const html = renderList(
      <ChannelList {...baseProps} onWatchLiveParty={() => {}} />,
    );
    expect(html).not.toContain("live-party-history");
  });

  it("draws a link beside the create card for somebody who may start one", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        onWatchLiveParty={() => {}}
        canStartWatchParty
        onCreateWatchParty={() => {}}
        watchPartyHistoryChannels={historyChannels}
        onOpenWatchPartyHistory={() => {}}
      />,
    );
    expect(html).toContain("live-party-create");
    expect(html).toContain("live-party-history-links");
    expect(html).toContain("Past broadcasts");
  });

  it("draws the link on its own for a moderator who may not start a party", () => {
    // MANAGE_CHANNELS without START_WATCH_PARTY: no create control, but the
    // channel's history is still theirs to administer.
    const html = renderList(
      <ChannelList
        {...baseProps}
        onWatchLiveParty={() => {}}
        watchPartyHistoryChannels={historyChannels}
        onOpenWatchPartyHistory={() => {}}
      />,
    );
    expect(html).not.toContain("live-party-create");
    expect(html).toContain("live-party-history-only");
    expect(html).toContain("live-party-history-links");
    expect(html).toContain("Past broadcasts");
  });

  it("names each link once there is more than one candidate channel", () => {
    const secondCinema: Channel = {
      ...cinema,
      id: "99999999-9999-4999-8999-999999999999",
      name: "sala 2",
    };
    const html = renderList(
      <ChannelList
        {...baseProps}
        channels={[cinema, secondCinema, lobby]}
        onWatchLiveParty={() => {}}
        canStartWatchParty
        onCreateWatchParty={() => {}}
        watchPartyHistoryChannels={[
          { id: cinema.id, name: cinema.name },
          { id: secondCinema.id, name: secondCinema.name },
        ]}
        onOpenWatchPartyHistory={() => {}}
      />,
    );
    expect(html).toContain(`Past broadcasts · ${cinema.name}`);
    expect(html).toContain(`Past broadcasts · ${secondCinema.name}`);
  });
});
