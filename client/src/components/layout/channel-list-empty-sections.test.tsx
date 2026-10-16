import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Channel, Server } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChannelList } from "./channel-list";

// After a Discord import every channel sits in a category, so the "Text" and
// "Voice" headers above the categories had nothing under them. A member cannot
// act on an empty header, so it is hidden for them. A manager keeps it: its
// + buttons are the only way to create a channel.

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
  name: "general-ooc",
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
  name: "discussion",
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

const topLevel: Channel = { ...child, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", name: "lobby", parentId: null };

/** The section header spans: `>Text<` and `>Voice<`, exactly. */
function headers(html: string): string[] {
  return ["Text", "Voice"].filter((label) => html.includes(`>${label}</span>`));
}

describe("empty top-level sections", () => {
  it("are hidden from a member when every channel sits in a category", () => {
    const html = render(
      <ChannelList {...baseProps} canManage={false} channels={[category, child]} />,
    );
    expect(headers(html)).toEqual([]);
    expect(html).toContain("discussion");
  });

  it("stay for a manager, whose + buttons create channels", () => {
    const html = render(
      <ChannelList {...baseProps} canManage channels={[category, child]} />,
    );
    expect(headers(html)).toEqual(["Text", "Voice"]);
  });

  it("show for a member when a channel lives outside a category", () => {
    const html = render(
      <ChannelList {...baseProps} canManage={false} channels={[category, child, topLevel]} />,
    );
    expect(headers(html)).toEqual(["Text"]);
  });

  it("show for a member on a server with no categories at all", () => {
    const html = render(
      <ChannelList {...baseProps} canManage={false} channels={[topLevel]} />,
    );
    expect(headers(html)).toEqual(["Text", "Voice"]);
  });
});
