import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Channel, Server } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChannelList } from "./channel-list";

/**
 * The channel sidebar header — the block the owner called "very confusing":
 * the server's name drawn three times (in the banner image, over the banner,
 * and again in the row below) and an unlabelled "OWNER" next to four
 * unlabelled icons.
 *
 * What this file pins instead: the name appears exactly once, the role reads
 * as a word rather than a bare enum, and every icon carries both a tooltip
 * and an accessible name — see `tooltip.tsx`, which is what actually puts the
 * `aria-label` on the button; a `Tooltip` around a control is what satisfies
 * that requirement, not a second, separate prop.
 */

const server: Server = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "QG do pqp",
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
    slowmodeSeconds: 0,
    voiceTransport: null,
  },
];

const baseProps = {
  server,
  channels,
  selectedChannelId: channels[0]!.id,
  canManage: true,
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
  channelSidebarToggle: { iconsOnly: false, onToggle: () => {} },
};

function render(node: ReactElement) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>{node}</TooltipProvider>
    </MemoryRouter>,
  );
}

/** How many times a string shows up in the rendered markup. */
function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("the channel sidebar header", () => {
  it("says the server's name exactly once, without a banner", () => {
    const html = render(<ChannelList {...baseProps} />);
    expect(occurrences(html, "QG do pqp")).toBe(1);
  });

  it("says the server's name exactly once, with a banner", () => {
    const html = render(
      <ChannelList
        {...baseProps}
        server={{
          ...server,
          bannerUrl: "https://cdn.example.com/banner.png",
        }}
      />,
    );
    expect(occurrences(html, "QG do pqp")).toBe(1);
    // The banner is this same header's background, not a second block above
    // it: the image and the name-bearing row are both inside one
    // `[data-server-banner]` wrapper.
    const bannerIndex = html.indexOf('data-server-banner=""');
    const nameIndex = html.indexOf("QG do pqp");
    expect(bannerIndex).toBeGreaterThanOrEqual(0);
    expect(nameIndex).toBeGreaterThan(bannerIndex);
  });

  it("wraps the name across two lines instead of truncating it to one", () => {
    const html = render(<ChannelList {...baseProps} />);
    const match = /<p class="([^"]*)">QG do pqp<\/p>/.exec(html);
    expect(match).not.toBeNull();
    expect(match![1]).toContain("line-clamp-2");
    expect(match![1]).not.toContain("truncate");
  });

  it("shows the role as a word, not the bare compatibility rank", () => {
    const html = render(<ChannelList {...baseProps} />);
    // Not the raw wire value the header used to print straight from the API.
    expect(html).not.toContain(">owner<");
    expect(html).toContain("Owner");
  });

  it("translates every rank the header can show", () => {
    for (const [role, label] of [
      ["owner", "Owner"],
      ["admin", "Admin"],
      ["member", "Member"],
    ] as const) {
      const html = render(
        <ChannelList {...baseProps} server={{ ...server, role }} />,
      );
      expect(html).toContain(label);
    }
  });

  it("gives every action icon a tooltip and an accessible name", () => {
    const html = render(<ChannelList {...baseProps} />);
    for (const label of [
      "Community settings",
      "Members",
      "Invite people",
      "Collapse the channel list",
    ]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
  });

  it("switches the name to light text with a shadow over a banner", () => {
    // `text-paper` is a theme-relative role — dark ink in a light theme —
    // tuned against the plain row's own background. Left on over an
    // arbitrary photograph, a light theme renders it as dark text sitting on
    // the banner's own dark scrim, so the banner branch has to switch to a
    // literal, theme-independent `text-white` instead. A contrast failure
    // the static markup can catch without a browser.
    const withoutBanner = render(<ChannelList {...baseProps} />);
    const plainMatch = /<p class="([^"]*)">QG do pqp<\/p>/.exec(withoutBanner);
    expect(plainMatch![1]).not.toContain("text-white");
    expect(plainMatch![1]).not.toContain("drop-shadow");

    const withBanner = render(
      <ChannelList
        {...baseProps}
        server={{
          ...server,
          bannerUrl: "https://cdn.example.com/banner.png",
        }}
      />,
    );
    const bannerMatch = /<p class="([^"]*)">QG do pqp<\/p>/.exec(withBanner);
    expect(bannerMatch![1]).toContain("text-white");
    expect(bannerMatch![1]).toContain("drop-shadow-[var(--shadow-banner-text)]");
  });

  it("hides the settings icon from a member who cannot manage the server", () => {
    const html = render(<ChannelList {...baseProps} canManage={false} />);
    expect(html).not.toContain('aria-label="Community settings"');
    // Members and invite still show — those two are not manage-gated.
    expect(html).toContain('aria-label="Members"');
    expect(html).toContain('aria-label="Invite people"');
  });

  it("keeps the mobile close button while loading or with no server selected", () => {
    // The drawer can be open in either state, and a header with no way to
    // close it traps a mobile viewer — this failed for a beat: the
    // server-present and no-server branches of the header used to diverge on
    // whether `onMobileClose` was inside the `server` conditional at all.
    for (const props of [
      { ...baseProps, server: null, isLoading: true },
      { ...baseProps, server: null, isLoading: false },
    ]) {
      const html = render(<ChannelList {...props} onMobileClose={() => {}} />);
      expect(html).toContain('aria-label="Close channel list"');
    }
  });

  it("never clips the header row inside a fixed-height banner box", () => {
    // The banner wrapper used to give the row a fixed `aspectRatio` height
    // with `overflow-hidden`, which clips a two-line name plus a role badge
    // at a normal sidebar width. The row is normal flow now, not absolutely
    // positioned inside the box, so nothing caps its height.
    const html = render(
      <ChannelList
        {...baseProps}
        server={{
          ...server,
          bannerUrl: "https://cdn.example.com/banner.png",
        }}
      />,
    );
    const banner = /<div data-server-banner="" class="([^"]*)"/.exec(html);
    expect(banner).not.toBeNull();
    expect(banner![1]).not.toContain("overflow-hidden");
  });
});
