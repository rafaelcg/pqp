import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Channel, Server } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChannelList } from "./channel-list";

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

function channel(
  id: string,
  type: Channel["type"],
  extra: Partial<Channel> = {},
): Channel {
  return {
    id,
    serverId: server.id,
    kind: "server",
    name:
      id === GERAL ? "geral" : id === MESA ? "mesa" : id === LONGE ? "longe" : "cat",
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
  channel(CATEGORY, "category", { name: "fundo" }),
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

describe("ChannelList personal pins", () => {
  it("hides Pinados until something is pinned, and skips categories", () => {
    const html = renderList(
      <ChannelList {...baseProps} onFavoriteChannelIdsChange={() => {}} />,
    );
    expect(html).not.toContain("data-pinned-channels");
    // geral, mesa, longe — not the category header.
    expect(html.match(/data-channel-pin/g)?.length).toBe(3);
  });

  it("lifts pinned channels above Text in stored order, and drops them from the category", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        favoriteChannelIds={[LONGE, MESA]}
        onFavoriteChannelIdsChange={() => {}}
      />,
    );
    const pinned = html.indexOf("data-pinned-channels");
    const text = html.indexOf(">Text<");
    expect(pinned).toBeGreaterThan(-1);
    expect(pinned).toBeLessThan(text);
    expect(html).toContain(">Pinned<");

    const pinnedBlock = html.slice(pinned, text);
    expect(pinnedBlock.indexOf("longe")).toBeLessThan(pinnedBlock.indexOf("mesa"));
    expect(pinnedBlock).toContain('aria-label="Unpin"');

    const fundoKids = html.slice(html.indexOf("fundo"));
    expect(fundoKids).not.toContain("longe");
    expect(html).toContain("Empty. Drag a channel here.");
  });
});
