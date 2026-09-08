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
  channels: [cinema],
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

describe("ChannelList watch party row (flag on)", () => {
  it("shows the LIVE pill and the viewer count while someone is on the stage", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        voiceOccupancy={{ [cinema.id]: [presenter, ...viewers] }}
      />,
    );
    expect(html).toContain("data-watch-party-live");
    expect(html).toContain(">LIVE<");
    // Three in the room, one presenting: two watching.
    expect(html).toMatch(/data-watch-party-viewers=""[^>]*>2 watching</);
    expect(html).toContain('data-channel-type="watch_party"');
    expect(html).toContain("lucide-clapperboard");
  });

  it("shows no pill and the topic when nobody is sharing", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        voiceOccupancy={{ [cinema.id]: [person("peer-andre", "Andre"), ...viewers] }}
      />,
    );
    expect(html).not.toContain("data-watch-party-live");
    expect(html).not.toContain("data-watch-party-viewers");
    expect(html).toContain("Sexta é noite de filme");
  });

  it("lists the room under its own Watch party section with a Join button", () => {
    const html = renderList(<ChannelList {...baseProps} />);
    expect(html).toContain(">Watch party<");
    expect(html).toMatch(/data-channel-join=""[^>]*>Join</);
  });
});

describe("ChannelList watch party row (flag off)", () => {
  it("renders the same channel as a plain voice row: no pill, no section", () => {
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
