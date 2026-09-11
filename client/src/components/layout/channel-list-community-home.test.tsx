import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Channel, Server } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChannelList } from "./channel-list";

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
  communityHomeEnabled: true,
  showOnProfile: true,
};

const channels: Channel[] = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    serverId: server.id,
    kind: "server",
    name: "geral",
    type: "text",
    position: 0,
    parentId: null,
    isPrivate: false,
    topic: null,
    imageUrl: null,
    slowmodeSeconds: 0,
    voiceTransport: null,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    serverId: server.id,
    kind: "server",
    name: "mesa",
    type: "voice",
    position: 0,
    parentId: null,
    isPrivate: false,
    topic: null,
    imageUrl: null,
    slowmodeSeconds: 0,
    voiceTransport: null,
  },
];

const baseProps = {
  server,
  channels,
  selectedChannelId: channels[0]!.id,
  canManage: false,
  voiceOccupancy: {},
  activeVoiceChannelId: null as string | null,
  unread: {},
  onSelectChannel: () => {},
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

describe("ChannelList selected row", () => {
  it("marks the open channel as the current page", () => {
    const html = renderList(<ChannelList {...baseProps} />);
    expect(html).toContain("geral");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("marks only Baú as current when the home row is selected", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        communityHomeEnabled
        communityHomeSelected
        onSelectCommunityHome={() => {}}
      />,
    );
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain("data-community-home-row");
    expect(html).toMatch(/data-community-home-row[^>]*aria-current="page"/);
  });
});

describe("ChannelList Community Home row", () => {
  it("flag off: no Home row in the channel list", () => {
    const html = renderList(<ChannelList {...baseProps} />);
    expect(html).not.toContain("data-community-home-row");
  });

  it("flag on: pins Baú above TEXT on a private (non-community) server, without a Community badge", () => {
    expect(server.isCommunity).toBe(false);
    const html = renderList(
      <ChannelList
        {...baseProps}
        communityHomeEnabled
        communityHomeSelected
        onSelectCommunityHome={() => {}}
      />,
    );
    expect(html).toContain("data-community-home-row");
    expect(html).toContain("Baú");
    // The badge is a fact about the server, not about the flag.
    expect(html).not.toContain(">Community<");
  });

  it("canManage: each channel row has a settings cog", () => {
    const html = renderList(<ChannelList {...baseProps} canManage />);
    expect(html.match(/data-channel-settings/g)?.length).toBe(2);
  });

  it("roles-only: the settings cog still shows", () => {
    const html = renderList(<ChannelList {...baseProps} canManageRoles />);
    expect(html.match(/data-channel-settings/g)?.length).toBe(2);
  });

  it("member: no settings cog on the channel rows", () => {
    const html = renderList(<ChannelList {...baseProps} />);
    expect(html).not.toContain("data-channel-settings");
  });

  it("flag on + community server: the Community badge shows", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        server={{ ...server, isCommunity: true }}
        communityHomeEnabled
        onSelectCommunityHome={() => {}}
      />,
    );
    expect(html).toContain(">Community<");
  });

  it("unread count outranks the New chip", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        communityHomeEnabled
        communityHomeShowNew
        communityHomeUnread={3}
        onSelectCommunityHome={() => {}}
      />,
    );
    expect(html).toContain("data-community-home-unread");
    expect(html).toContain(">3<");
    expect(html).not.toContain(">New<");
  });

  it("New chip shows when there is nothing unread", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        communityHomeEnabled
        communityHomeShowNew
        communityHomeUnread={0}
        onSelectCommunityHome={() => {}}
      />,
    );
    expect(html).not.toContain("data-community-home-unread");
    expect(html).toContain(">New<");
  });

  it("icons-only rail still draws the unread number", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        communityHomeEnabled
        communityHomeUnread={2}
        iconsOnly
        onExpand={() => {}}
        onSelectCommunityHome={() => {}}
      />,
    );
    expect(html).toContain("data-community-home-unread");
    expect(html).toContain(">2<");
  });
});
