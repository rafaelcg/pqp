import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Channel, Server, VoiceParticipant } from "@pqp/shared";
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
    // Still a joinable voice room: the seated people nest under it.
    expect(html).toContain(">Andre<");
    expect(html).toContain(">Rafa<");
    expect(html).toContain('data-channel-type="watch_party"');
  });
});
