import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Channel, Server } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChannelList, channelRailGroups } from "./channel-list";

/**
 * The channel list with its labels off, which a screen share turns on.
 *
 * The bar it has to clear is navigation: every channel still reachable, still
 * named to a screen reader and to a hover, still showing unread and mentions,
 * and a way back to the wide list that is on screen without hunting. A strip
 * you cannot leave is worse than a strip you cannot read.
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

const CATEGORY = "55555555-5555-4555-8555-555555555555";
const GERAL = "22222222-2222-4222-8222-222222222222";
const MESA = "33333333-3333-4333-8333-333333333333";
const LONGE = "44444444-4444-4444-8444-444444444444";
const NAMES: Record<string, string> = {
  [GERAL]: "geral",
  [MESA]: "mesa",
  [LONGE]: "longe",
  [CATEGORY]: "fundo",
};

function channel(
  id: string,
  type: Channel["type"],
  extra: Partial<Channel> = {},
): Channel {
  return {
    id,
    serverId: server.id,
    kind: "server",
    name: NAMES[id] ?? id,
    type,
    position: extra.position ?? 0,
    parentId: extra.parentId ?? null,
    isPrivate: false,
    topic: null,
    imageUrl: null,
    slowmodeSeconds: 0,
    voiceTransport: null,
    ...extra,
  };
}

const channels: Channel[] = [
  channel(GERAL, "text"),
  channel(MESA, "voice"),
  channel(CATEGORY, "category"),
  channel(LONGE, "text", { parentId: CATEGORY, position: 0 }),
];

const baseProps = {
  server,
  channels,
  selectedChannelId: GERAL,
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

describe("ChannelList iconsOnly", () => {
  it("keeps every channel reachable and named", () => {
    const html = renderList(
      <ChannelList {...baseProps} iconsOnly onExpand={() => {}} />,
    );
    expect(html).toContain("data-channel-rail");
    for (const id of [GERAL, MESA, LONGE]) {
      expect(html).toContain(`data-channel-id="${id}"`);
      expect(html).toContain(`aria-label="${NAMES[id]}"`);
    }
    // The category is a label, and a label is what the strip cannot hold. Its
    // channel is still there; its header is not.
    expect(html).not.toContain(`data-channel-id="${CATEGORY}"`);
  });

  it("always carries the way back to the wide list", () => {
    const html = renderList(
      <ChannelList {...baseProps} iconsOnly onExpand={() => {}} />,
    );
    expect(html).toContain("data-channel-rail-expand");
    expect(html).toContain('aria-label="Expand the channel list"');
  });

  it("refuses to collapse at all when there is no way back", () => {
    // The guard, not a nicety: a strip whose expand button does nothing is a
    // person stuck with a column of glyphs.
    const html = renderList(<ChannelList {...baseProps} iconsOnly />);
    expect(html).not.toContain("data-channel-rail");
    expect(html).toContain(">geral<");
  });

  it("still says which channel you are in", () => {
    const html = renderList(
      <ChannelList {...baseProps} iconsOnly onExpand={() => {}} activeVoiceChannelId={MESA} />,
    );
    const geral = html.indexOf(`data-channel-id="${GERAL}"`);
    expect(html.slice(geral, geral + 400)).toContain('aria-current="page"');
  });

  it("keeps unread and mentions visible without the name to hang them on", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        iconsOnly
        onExpand={() => {}}
        selectedChannelId={MESA}
        unread={{ [GERAL]: { count: 4, mentions: 2 } }}
      />,
    );
    expect(html).toContain("(unread)");
    expect(html).toContain('aria-label="2 unread mentions"');
    expect(html).toContain(">2<");
  });

  it("counts the people in a voice room, which the row used to spell out", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        iconsOnly
        onExpand={() => {}}
        voiceOccupancy={{
          [MESA]: [
            {
              peerId: "p1",
              userId: "u1",
              displayName: "Ana",
              avatarUrl: null,
              muted: false,
              deafened: false,
              serverMuted: false,
              sharingScreen: false,
            },
            {
              peerId: "p2",
              userId: "u2",
              displayName: "Bia",
              avatarUrl: null,
              muted: false,
              deafened: false,
              serverMuted: false,
              sharingScreen: false,
            },
          ],
        }}
      />,
    );
    expect(html).toContain('aria-label="2 in the call"');
  });

  it("is the wide list again the moment the drawer is what is open", () => {
    // Under `md` the list is a drawer over the chat, and a drawer of icons
    // saves nothing. Belt to `channelSidebarIconsOnly`'s braces.
    const html = renderList(
      <ChannelList {...baseProps} iconsOnly onExpand={() => {}} mobileOpen />,
    );
    expect(html).not.toContain("data-channel-rail");
    expect(html).toContain(">geral<");
  });

  it("draws the wide list when nobody asked for the strip", () => {
    const html = renderList(<ChannelList {...baseProps} />);
    expect(html).not.toContain("data-channel-rail");
    expect(html).toContain(">geral<");
  });
});

describe("channelRailGroups", () => {
  const geral = channel(GERAL, "text");
  const mesa = channel(MESA, "voice");
  const longe = channel(LONGE, "text", { parentId: CATEGORY });
  const category = channel(CATEGORY, "category");

  it("keeps pins first, then text, then voice, then each category's channels", () => {
    expect(
      channelRailGroups({
        favorites: [mesa],
        text: [geral],
        voice: [],
        categories: [category],
        childrenByCategory: new Map([[CATEGORY, [longe]]]),
      }).map((group) => [group.key, group.channels.map((c) => c.name)]),
    ).toEqual([
      ["favorites", ["mesa"]],
      ["text", ["geral"]],
      [CATEGORY, ["longe"]],
    ]);
  });

  it("drops empty groups rather than drawing a divider over nothing", () => {
    expect(
      channelRailGroups({
        favorites: [],
        text: [],
        voice: [],
        categories: [category],
        childrenByCategory: new Map(),
      }),
    ).toEqual([]);
  });
});
