import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Channel, Server } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChannelList } from "./channel-list";

// A regression guard for the empty-category drop target. The category header
// always accepted a dropped channel, but the empty-category placeholder that
// tells the user "drag a channel here" had no drop handlers, so the one spot
// the copy points at was inert (reported 2026-09-19). The placeholder now
// carries the drop handlers and a stable testid; this asserts it is rendered
// for an empty category and replaced by the channel rows once one lands.

const server: Server = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Mesa",
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
  communityTagline: null,
  communityAbout: null,
  communityLinks: [],
  communitySlug: null,
};

const category: Channel = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  serverId: server.id,
  kind: "server",
  name: "parceiragem",
  type: "category",
  position: 0,
  parentId: null,
  isPrivate: false,
  topic: null,
  imageUrl: null,
  slowmodeSeconds: 0,
  voiceTransport: null,
};

const child: Channel = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  serverId: server.id,
  kind: "server",
  name: "geral",
  type: "text",
  position: 0,
  parentId: category.id,
  isPrivate: false,
  topic: null,
  imageUrl: null,
  slowmodeSeconds: 0,
  voiceTransport: null,
};

const baseProps = {
  server,
  selectedChannelId: null,
  canManage: true,
  voiceOccupancy: {},
  speakingPeerIds: [],
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

function render(node: ReactElement) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>{node}</TooltipProvider>
    </MemoryRouter>,
  );
}

describe("empty category drop target", () => {
  it("renders a drop target inside an empty category", () => {
    const html = render(
      <ChannelList {...baseProps} channels={[category]} />,
    );
    expect(html).toContain('data-testid="empty-category-drop"');
  });

  it("shows channel rows, not the drop placeholder, once the category has one", () => {
    const html = render(
      <ChannelList {...baseProps} channels={[category, child]} />,
    );
    expect(html).not.toContain('data-testid="empty-category-drop"');
    expect(html).toContain("geral");
  });
});
