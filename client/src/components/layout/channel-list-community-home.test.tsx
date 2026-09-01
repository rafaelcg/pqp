import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Channel, Server } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChannelList } from "./channel-list";

const server: Server = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Mesa Staging",
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
  onTogglePrivate: () => {},
  onManageChannelMembers: () => {},
  onManageWebhooks: () => {},
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

describe("ChannelList Community Home row", () => {
  it("flag off: no Home row in the channel list", () => {
    const html = renderList(<ChannelList {...baseProps} />);
    expect(html).not.toContain("data-community-home-row");
  });

  it("flag on: pins Home above TEXT on a private (non-community) server", () => {
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
    expect(html).toContain("Home");
    expect(html).not.toContain("Library of photos");
  });

  it("renders the local discovery badge after the row label", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        communityHomeEnabled
        communityHomeShowNew
        onSelectCommunityHome={() => {}}
      />,
    );
    expect(html).toMatch(/Home<\/span><span[^>]*>NEW<\/span>/);
  });
});
