import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Channel, Server } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { LatestCard, LatestPreview } from "@/lib/community-home/latest";
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
  communityTagline: null,
  communityAbout: null,
  communityLinks: [],
  communitySlug: null,
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

  it("a community still gets the Baú row when this server has not opted in", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        server={{ ...server, isCommunity: true, communityHomeEnabled: false }}
        onSelectCommunityHome={() => {}}
      />,
    );
    expect(html).toContain("data-community-home-row");
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
    expect(html).toContain('data-community-home-face="chest"');
    expect(html).not.toContain("Not chat");
    // The badge is a fact about the server, not about the flag.
    expect(html).not.toContain(">Community<");
  });

  it("a community row uses the poster face, not a teaching subtitle", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        server={{ ...server, isCommunity: true, name: "Mesa da Tues" }}
        onSelectCommunityHome={() => {}}
      />,
    );
    expect(html).toContain('data-community-home-face="poster"');
    expect(html).toContain("MD");
    expect(html).toContain("Baú");
    expect(html).not.toContain("Not chat");
    expect(html).not.toContain("Posts that stay");
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

  it("flag on + community server: no Community chip in the header (that fact moved into the server menu as 'Público')", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        server={{ ...server, isCommunity: true }}
        communityHomeEnabled
        onSelectCommunityHome={() => {}}
      />,
    );
    expect(html).not.toContain(">Community<");
    expect(html).not.toContain(">Comunidade<");
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

  it("the unread count is lime, never the red a mention uses", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        communityHomeEnabled
        communityHomeUnread={3}
        onSelectCommunityHome={() => {}}
      />,
    );
    const badge = /<span[^>]*data-community-home-unread[^>]*>/.exec(html)?.[0] ?? "";
    expect(badge).toContain("bg-signal");
    expect(badge).not.toContain("bg-danger");
  });

  it("a post under 24 hours old adds a pulsing New chip beside the count", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        communityHomeEnabled
        communityHomeUnread={3}
        communityHomeUnreadFresh
        onSelectCommunityHome={() => {}}
      />,
    );
    const chip = /<span[^>]*data-community-home-fresh[^>]*>/.exec(html)?.[0] ?? "";
    expect(chip).toContain("motion-safe:animate-pulse");
    expect(html).toMatch(/data-community-home-fresh[^>]*>New</);
    expect(html).toContain(">3<");
  });

  it("an older unread post keeps the count and drops the chip", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        communityHomeEnabled
        communityHomeUnread={3}
        onSelectCommunityHome={() => {}}
      />,
    );
    expect(html).not.toContain("data-community-home-fresh");
    expect(html).toContain(">3<");
  });

  it("fresh with nothing unread draws nothing: the discovery chip stays its own thing", () => {
    const html = renderList(
      <ChannelList
        {...baseProps}
        communityHomeEnabled
        communityHomeShowNew
        communityHomeUnread={0}
        communityHomeUnreadFresh
        onSelectCommunityHome={() => {}}
      />,
    );
    expect(html).not.toContain("data-community-home-fresh");
    expect(html).toContain(">New<");
  });
});

describe("ChannelList Baú preview (GET …/home/latest)", () => {
  const post = (overrides: Partial<LatestCard> = {}): LatestCard => ({
    postId: "44444444-4444-4444-8444-444444444444",
    serverId: server.id,
    serverName: server.name,
    title: "Clutch 1v4 da Bia na Ancient",
    teaser: null,
    author: {
      id: "55555555-5555-4555-8555-555555555555",
      displayName: "Bia",
      avatarUrl: null,
    },
    mediaKind: "image",
    mediaUrl: "https://bucket.example/clutch.jpg",
    posterUrl: null,
    visibility: "free",
    locked: false,
    pinned: false,
    likeCount: 23,
    commentCount: 8,
    publishedAt: new Date().toISOString(),
    isNew: false,
    ...overrides,
  });
  const noop = () => {};
  const render = (latest: LatestPreview, canPost = false) =>
    renderList(
      <ChannelList
        {...baseProps}
        communityHomeEnabled
        communityHomeUnread={latest.unread}
        onSelectCommunityHome={noop}
        communityHomePreview={{ latest, canPost, onOpenPost: noop, onCompose: noop }}
      />,
    );
  const wrap = (html: string, name: string) =>
    new RegExp(`<div[^>]*data-bau-preview-${name}-wrap[^>]*>`).exec(html)?.[0] ?? "";

  it("something new: the card is open with the cover, title, author and count", () => {
    const html = render({
      unread: 2,
      lastSeenAt: null,
      posts: [
        post({ isNew: true }),
        post({ postId: "66666666-6666-4666-8666-666666666666", title: "Camp do QG", isNew: true }),
      ],
    });
    expect(html).toContain('data-bau-preview="card"');
    expect(wrap(html, "card")).toContain("grid-rows-[1fr]");
    expect(wrap(html, "card")).not.toContain("inert");
    expect(wrap(html, "row")).toContain("grid-rows-[0fr]");
    expect(wrap(html, "row")).toContain("inert");
    expect(html).toContain("Clutch 1v4 da Bia na Ancient");
    expect(html).toContain("Bia");
    expect(html).toContain('src="https://bucket.example/clutch.jpg"');
    expect(html).toMatch(/data-community-home-unread[^>]*>2</);
    expect(html).toContain("+1 new: Camp do QG");
    // The old plain row is gone, not drawn twice.
    expect(html.match(/data-community-home-row/g)).toHaveLength(1);
  });

  it("seen: folds into the slim row that still shows the last post", () => {
    const html = render({
      unread: 0,
      lastSeenAt: new Date().toISOString(),
      posts: [post()],
    });
    expect(html).toContain('data-bau-preview="row"');
    expect(wrap(html, "card")).toContain("grid-rows-[0fr]");
    expect(wrap(html, "row")).toContain("grid-rows-[1fr]");
    expect(wrap(html, "row")).not.toContain("inert");
    expect(html).toContain("Latest: Clutch 1v4 da Bia na Ancient");
    expect(html).not.toMatch(/data-community-home-unread/);
  });

  it("an uploaded video with no chosen cover gets the plate, never a <video>", () => {
    const html = render({
      unread: 1,
      lastSeenAt: null,
      posts: [post({ isNew: true, mediaKind: "video", mediaUrl: "https://bucket.example/v.mp4" })],
    });
    expect(html).not.toContain("<video");
    expect(html).not.toContain("v.mp4");
    expect(html).toContain('data-bau-preview-cover="plate"');
  });

  it("an uploaded video with a chosen cover shows the cover", () => {
    const html = render({
      unread: 1,
      lastSeenAt: null,
      posts: [
        post({
          isNew: true,
          mediaKind: "video",
          mediaUrl: "https://bucket.example/v.mp4",
          posterUrl: "https://bucket.example/cover.jpg",
        }),
      ],
    });
    expect(html).toContain('src="https://bucket.example/cover.jpg"');
    expect(html).not.toContain("v.mp4");
  });

  it("empty, staff: the invite to post", () => {
    const html = render({ unread: 0, lastSeenAt: null, posts: [] }, true);
    expect(html).toContain('data-bau-preview="empty-staff"');
    expect(html).toContain("Your Baú is empty");
    expect(html).toContain("data-bau-preview-compose");
  });

  it("empty, member: the quiet row, no invite", () => {
    const html = render({ unread: 0, lastSeenAt: null, posts: [] }, false);
    expect(html).toContain('data-bau-preview-row="empty"');
    expect(html).toContain("Nothing here yet");
    expect(html).not.toContain("data-bau-preview-compose");
  });

  it("transitions are off under reduced motion", () => {
    const html = render({ unread: 1, lastSeenAt: null, posts: [post({ isNew: true })] });
    expect(wrap(html, "card")).toContain("motion-reduce:transition-none");
    expect(wrap(html, "row")).toContain("motion-reduce:transition-none");
  });
});
