import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Channel, Server } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DmList } from "./dm-list";
import { ChannelList } from "./channel-list";
import {
  CHANNEL_SIDEBAR_DEFAULT_WIDTH,
  CHANNEL_SIDEBAR_MIN_WIDTH,
} from "@/lib/channel-sidebar-width";

/**
 * The column's draggable edge, as the markup a browser gets.
 *
 * ONE OF THESE IS A SCAR. The handle is absolutely positioned, so the column
 * had to stop being `position: static`. Turning it `relative` also switched on
 * the `left-[72px]` the drawer layout sets and `static` was ignoring, and as a
 * relative OFFSET that slid the whole column 72px right, parking its footer on
 * top of the composer's formatting button. Three e2e shards caught it. The
 * `md:left-auto` assertion below is the thing that would have caught it here.
 */

const server: Server = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "QG",
  ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  createdAt: "2026-07-01T00:00:00.000Z",
  messageRetentionDays: null,
  ssoEmailDomain: null,
  iconUrl: null,
  bannerUrl: null,
  role: "member",
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

function render(node: ReactElement) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>{node}</TooltipProvider>
    </MemoryRouter>,
  );
}

const asideClass = (html: string) =>
  /<aside[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";

describe("the channel column's draggable edge", () => {
  it("is a separator that reports where it sits and how far it goes", () => {
    const html = render(<ChannelList {...baseProps} />);
    expect(html).toContain('data-sidebar-resize=""');
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain(`aria-valuenow="${CHANNEL_SIDEBAR_DEFAULT_WIDTH}"`);
    expect(html).toContain(`aria-valuemin="${CHANNEL_SIDEBAR_MIN_WIDTH}"`);
    // Focusable, because a separator only a mouse can move is half a control.
    expect(html).toMatch(/data-sidebar-resize=""[^>]*tabindex="0"/);
  });

  it("never draws on the drawer, where there is no edge to grab", () => {
    const html = render(<ChannelList {...baseProps} />);
    expect(html).toMatch(/data-sidebar-resize=""[^>]*hidden w-1\.5[^>]*md:block/);
  });

  it("puts the width on a variable only the md class reads", () => {
    // An inline `width` would also win below `md`, where this is a drawer
    // pinned to `min(100%-72px,16rem)`.
    const html = render(<ChannelList {...baseProps} />);
    expect(html).toContain(
      `--channel-sidebar-width:${CHANNEL_SIDEBAR_DEFAULT_WIDTH}px`,
    );
    expect(asideClass(html)).toContain("md:w-[var(--channel-sidebar-width)]");
  });

  it("cancels the drawer's left offset when it becomes a positioned column", () => {
    // THE REGRESSION. `md:relative` gives the handle a containing block, and
    // it also switches on `left-[72px]`, which `static` ignored. Without
    // `md:left-auto` the whole column paints 72px right of where it sits in
    // flow, over the chat.
    const cls = asideClass(render(<ChannelList {...baseProps} />));
    expect(cls).toContain("left-[72px]");
    expect(cls).toContain("md:relative");
    expect(cls).toContain("md:left-auto");
  });

  it("gives the DM list the same edge and the same guard", () => {
    // Same column, and a different width on each would jump when you switch.
    const html = render(
      <DmList
        conversations={[]}
        selectedChannelId={null}
        unread={{}}
        isLoading={false}
        blockedUserIds={new Set<string>()}
        pinnedChannelIds={new Set<string>()}
        onSelectConversation={() => {}}
        onStartConversation={() => {}}
        onHideConversation={() => {}}
        onTogglePin={() => {}}
        onBlockUser={() => {}}
        onUnblockUser={() => {}}
      />,
    );
    expect(html).toContain('data-sidebar-resize=""');
    const cls = asideClass(html);
    expect(cls).toContain("md:relative");
    expect(cls).toContain("md:left-auto");
    expect(cls).toContain("md:w-[var(--channel-sidebar-width)]");
  });
});
