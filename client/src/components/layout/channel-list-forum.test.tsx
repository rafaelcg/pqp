import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { Channel, Server } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ChannelList,
  isTextGroupChannelType,
  textSectionAddMenu,
} from "./channel-list";

const server: Server = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Bugados",
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

const geral: Channel = {
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
};

const ajuda: Channel = {
  ...geral,
  id: "33333333-3333-4333-8333-333333333333",
  name: "ajuda",
  type: "forum",
  position: 1,
  topic: "Um problema por post.",
};

const baseProps = {
  server,
  channels: [ajuda, geral],
  selectedChannelId: null,
  canManage: true,
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

describe("a forum in the sidebar", () => {
  it("is a row in the Texto group, after the text channel above it", () => {
    const html = renderList(<ChannelList {...baseProps} />);
    const forumAt = html.indexOf('data-channel-type="forum"');
    const textAt = html.indexOf('data-channel-type="text"');
    expect(forumAt).toBeGreaterThan(-1);
    expect(textAt).toBeGreaterThan(-1);
    // Position order inside the group: geral (0) then ajuda (1).
    expect(textAt).toBeLessThan(forumAt);
  });

  it("wears its own glyph and the beta pill", () => {
    const html = renderList(<ChannelList {...baseProps} />);
    const row = html.slice(html.indexOf('data-channel-type="forum"'));
    expect(row).toMatch(/lucide-(messages-square|message-squares)/);
    expect(row.slice(0, 4000)).toContain(">beta<");
  });

  it("lights with the same pip and bold name as any channel", () => {
    const html = renderList(
      <ChannelList {...baseProps} unread={{ [ajuda.id]: { count: 2, mentions: 0 } }} />,
    );
    const row = html.slice(html.indexOf('data-channel-type="forum"'));
    expect(row.slice(0, 4000)).toContain("font-semibold");
  });

  it("swaps the beta pill for the mention count when there is one", () => {
    const html = renderList(
      <ChannelList {...baseProps} unread={{ [ajuda.id]: { count: 1, mentions: 3 } }} />,
    );
    // The forum row is the last in the Texto group here, so it runs to the
    // next section; a slice is enough to keep the assertion on that one row.
    const row = html.slice(html.indexOf('data-channel-type="forum"')).slice(0, 4000);
    expect(row).toContain(">3<");
    expect(row).not.toContain(">beta<");
  });
});

/** The Texto section's "+" (the first section on the list), as markup. */
function textAddButton(html: string): string {
  const at = html.indexOf("data-channel-section-add");
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<button", at);
  return html.slice(start, html.indexOf(">", at) + 1);
}

describe("the Texto section's +", () => {
  it("is one click to a text channel while forums are off", () => {
    const html = renderList(<ChannelList {...baseProps} />);
    expect(textAddButton(html)).not.toContain('aria-haspopup="menu"');
  });

  it("opens a menu while forums are on for the server", () => {
    const html = renderList(<ChannelList {...baseProps} forumCreateEnabled />);
    expect(textAddButton(html)).toContain('aria-haspopup="menu"');
  });

  it("offers a text channel first and the Fórum with its beta pill", () => {
    const onText = vi.fn();
    const onForum = vi.fn();
    const items = textSectionAddMenu({
      textLabel: "Criar canal de texto",
      forumLabel: "Criar fórum",
      onText,
      onForum,
    });
    expect(items.map((item) => item.id)).toEqual(["create-text", "create-forum"]);
    expect(items[1]!.trailing).toBeTruthy();
    items[0]!.onSelect?.();
    items[1]!.onSelect?.();
    expect(onText).toHaveBeenCalledOnce();
    expect(onForum).toHaveBeenCalledOnce();
  });
});

describe("isTextGroupChannelType", () => {
  it("groups text and forum, nothing else", () => {
    expect(isTextGroupChannelType("text")).toBe(true);
    expect(isTextGroupChannelType("forum")).toBe(true);
    for (const type of ["voice", "watch_party", "category", "thread"]) {
      expect(isTextGroupChannelType(type)).toBe(false);
    }
  });
});
